"""Slides artifact (HTML) -> editable PowerPoint. Usage: python deck2pptx.py in.html out.pptx

Reads each <section class="slide"> and keeps its headings, paragraphs, bullets, tables and pictures
as real PowerPoint text boxes, tables and images. The layout is simplified (title on top, text on the
left, pictures on the right); colours come from the slide's background when it is a plain colour."""
import base64
import io
import re
import sys
import urllib.request
from html.parser import HTMLParser

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt

VOID = {"br", "img", "hr", "meta", "link", "input", "source", "col", "area", "base", "wbr"}
BLOCK = {"h1", "h2", "h3", "h4", "p", "li", "blockquote", "figcaption", "div", "section", "article", "ul", "ol", "header", "footer", "aside", "main", "table", "tr", "td", "th", "pre"}
COLOR = re.compile(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)")


def to_rgb(text):
    m = COLOR.search(text or "")
    if not m:
        return None
    v = m.group(0)
    if v.startswith("rgb"):
        r, g, b = [int(x) for x in re.findall(r"\d+", v)[:3]]
        return (r, g, b)
    v = v[1:]
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


class Deck(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.slides, self.css = [], []
        self.cur, self.slide_depth = None, None
        self.stack, self.skip = [], 0
        self.kind, self.buf = "p", []
        self.table, self.row, self.cell = None, None, None
        self.in_style = False

    def flush(self):
        text = re.sub(r"[ \t\r\f\v]+", " ", "".join(self.buf)).strip()
        text = re.sub(r"\s*\n\s*", "\n", text)
        self.buf = []
        if text and self.cur is not None and self.cell is None:
            self.cur["items"].append({"k": self.kind, "t": text})

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "style":
            self.in_style = True
        if tag in ("script", "style", "head", "title"):
            if tag not in VOID:
                self.stack.append(tag)
            self.skip += 1
            return
        if tag not in VOID:
            self.stack.append(tag)
        classes = (a.get("class") or "").split()
        if self.cur is None and "slide" in classes:
            bg = None
            style = a.get("style") or ""
            m = re.search(r"background(?:-color)?\s*:\s*([^;]+)", style)
            if m:
                bg = to_rgb(m.group(1))
            self.cur = {"items": [], "bg": bg, "classes": classes}
            self.slide_depth = len(self.stack)
            self.slides.append(self.cur)
            self.kind = "p"
            return
        if self.cur is None:
            return
        if tag == "img":
            src = a.get("src") or ""
            self.flush()
            self.cur["items"].append({"k": "img", "src": src})
        elif tag == "br":
            self.buf.append("\n")
        elif tag == "table":
            self.flush()
            self.table = []
        elif tag == "tr" and self.table is not None:
            self.row = []
            self.table.append(self.row)
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []
        elif tag in BLOCK:
            self.flush()
            self.kind = {"h1": "h1", "h2": "h2", "h3": "h3", "h4": "h3", "li": "li", "blockquote": "p"}.get(tag, "p")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head", "title"):
            if tag == "style":
                self.in_style = False
            self.skip = max(0, self.skip - 1)
            if tag in self.stack:
                while self.stack and self.stack.pop() != tag:
                    pass
            return
        if tag in self.stack:
            while self.stack:
                if self.stack.pop() == tag:
                    break
        if self.cur is None:
            return
        if tag in ("td", "th") and self.cell is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
            self.cell = None
        elif tag == "table" and self.table is not None:
            rows = [r for r in self.table if r]
            if rows:
                self.cur["items"].append({"k": "table", "rows": rows})
            self.table = self.row = None
        elif tag in BLOCK and self.cell is None:
            self.flush()
            self.kind = "p"
        if self.slide_depth is not None and len(self.stack) < self.slide_depth:
            self.flush()
            self.cur, self.slide_depth = None, None

    def handle_data(self, data):
        if self.in_style:
            self.css.append(data)
            return
        if self.skip or self.cur is None:
            return
        if self.cell is not None:
            self.cell.append(data)
        else:
            self.buf.append(data)


def class_background(css, classes):
    """A plain colour from a rule such as .slide { background: #123 } or .slide.light { ... } that fits this slide."""
    text = " ".join(css)
    have = set(classes) | {"slide"}
    best, found = (-1, -1), None
    for order, m in enumerate(re.finditer(r"([^{}]+)\{([^}]*)\}", text)):
        b = re.search(r"background(?:-color)?\s*:\s*([^;}]+)", m.group(2))
        color = to_rgb(b.group(1)) if b else None
        if not color:
            continue
        for sel in m.group(1).split(","):
            sel = sel.strip()
            if re.fullmatch(r"(\.[\w-]+)+", sel):
                names = sel.split(".")[1:]
                if set(names) <= have and (len(names), order) > best:
                    best, found = (len(names), order), color
    return found


def luminance(rgb):
    r, g, b = rgb
    return 0.299 * r + 0.587 * g + 0.114 * b


def picture_bytes(src):
    if src.startswith("data:"):
        head, _, body = src.partition(",")
        return base64.b64decode(body) if ";base64" in head else body.encode()
    if src.startswith("http"):
        with urllib.request.urlopen(src, timeout=6) as r:
            return r.read()
    return None


def main(src, out):
    d = Deck()
    d.feed(open(src, encoding="utf-8", errors="replace").read())
    d.close()
    if not d.slides:
        raise SystemExit("No slides found (each slide must be a <section class=\"slide\">).")
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    blank = prs.slide_layouts[6]
    for s in d.slides:
        slide = prs.slides.add_slide(blank)
        bg = s["bg"] or class_background(d.css, s["classes"]) or (255, 255, 255)
        fg = RGBColor(255, 255, 255) if luminance(bg) < 140 else RGBColor(17, 17, 17)
        fill = slide.background.fill
        fill.solid()
        fill.fore_color.rgb = RGBColor(*bg)
        items = s["items"]
        title = next((i for i in items if i["k"] in ("h1", "h2")), None)
        imgs = [i for i in items if i["k"] == "img"]
        pics = []
        for i in imgs:
            try:
                data = picture_bytes(i["src"])
                if data:
                    pics.append(data)
            except Exception:
                pass
        top = 0.5
        if title:
            tb = slide.shapes.add_textbox(Inches(0.6), Inches(0.4), Inches(12.1), Inches(1.2))
            tf = tb.text_frame
            tf.word_wrap = True
            run = tf.paragraphs[0].add_run()
            run.text = title["t"]
            run.font.size, run.font.bold, run.font.color.rgb = Pt(36 if title["k"] == "h1" else 32), True, fg
            top = 1.75
        body = [i for i in items if i is not title and i["k"] in ("h1", "h2", "h3", "p", "li")]
        tables = [i for i in items if i["k"] == "table"]
        width = 7.4 if pics else 12.1
        chars = sum(len(i["t"]) for i in body)
        size = 22 if chars < 500 else 18 if chars < 900 else 14
        if body:
            tb = slide.shapes.add_textbox(Inches(0.6), Inches(top), Inches(width), Inches(7.1 - top - (2.2 if tables else 0)))
            tf = tb.text_frame
            tf.word_wrap = True
            first = True
            for i in body:
                p = tf.paragraphs[0] if first else tf.add_paragraph()
                first = False
                run = p.add_run()
                run.text = ("• " if i["k"] == "li" else "") + i["t"]
                heading = i["k"] in ("h1", "h2", "h3")
                run.font.size = Pt(size + 4 if heading else size)
                run.font.bold = heading
                run.font.color.rgb = fg
                p.space_after = Pt(8)
        y = top + (0 if not body else 0)
        if tables:
            rows = tables[0]["rows"]
            cols = max(len(r) for r in rows)
            ty = 4.9 if body else top
            shape = slide.shapes.add_table(len(rows), cols, Inches(0.6), Inches(ty), Inches(width), Inches(0.4 * len(rows)))
            for ri, r in enumerate(rows):
                for ci in range(cols):
                    cell = shape.table.cell(ri, ci)
                    cell.text = r[ci] if ci < len(r) else ""
                    for para in cell.text_frame.paragraphs:
                        for run in para.runs:
                            run.font.size = Pt(14)
        py = top
        for data in pics[:3]:
            try:
                slide.shapes.add_picture(io.BytesIO(data), Inches(8.3), Inches(py), width=Inches(4.4))
                py += 2.4
            except Exception:
                pass
    prs.save(out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
