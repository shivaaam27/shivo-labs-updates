"""Image helper for Shivo Labs AI (Pillow). Usage: python imgtool.py <command> <job.json>   -> prints one JSON line.

convert  {"in", "out", "max": 1568}           any image Pillow can open -> JPEG/PNG, shrunk to fit `max` on its longest side
board    {"paths", "layout": "grid"|"compare", "cols", "labels", "cell", "diff", "out", "view", "view_max"}
info     {"in"} -> w, h
resize   {"in", "out", "factor": 0.5}
upscale  {"in", "out", "scale": 2|4}          plain resize (Lanczos + light sharpening); the AI app uses Real-ESRGAN when it has it
"""
import json
import math
import os
import sys

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps, ImageFilter
except ImportError:
    print(json.dumps({"error": "Pillow isn't installed. Run: python -m pip install pillow"}))
    sys.exit(0)

try:  # iPhone photos (.heic); optional
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

BG = (242, 242, 240)


def load(path):
    im = Image.open(path)
    try:
        im.seek(0)  # first frame of gifs
    except Exception:
        pass
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        base = Image.new("RGB", im.size, (255, 255, 255))
        base.paste(im, mask=im.split()[3])
        return base
    return im.convert("RGB")


def font(size):
    for name in ("segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            pass
    return ImageFont.load_default()


def fit(im, w, h):
    s = min(w / im.width, h / im.height)
    return im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)


def shorten(text, draw, f, width):
    if draw.textlength(text, font=f) <= width:
        return text
    while len(text) > 4 and draw.textlength(text + "…", font=f) > width:
        text = text[:-1]
    return text + "…"


def save(im, out):
    ext = os.path.splitext(out)[1].lower()
    if ext == ".png":
        im.save(out)
    else:
        im.save(out, quality=90)


def shrink_for_view(im, view_max):
    if max(im.size) > view_max:
        im = fit(im, view_max, view_max)
    return im


def cmd_convert(j):
    big = load(j["in"])
    im = shrink_for_view(big, int(j.get("max") or 1568))
    save(im, j["out"])
    return {"out": j["out"], "w": im.width, "h": im.height, "resized": im.size != big.size}


def cmd_board(j):
    paths = j["paths"]
    labels = j.get("labels", True)
    imgs, skipped = [], []
    names = j.get("names") or []
    for i, p in enumerate(paths):
        try:
            im = load(p)
            imgs.append((names[i] if i < len(names) and names[i] else os.path.basename(p), im, im.size))
        except Exception as e:
            skipped.append(f"{os.path.basename(p)}: {e}")
    if not imgs:
        return {"error": "None of the images could be opened. " + "; ".join(skipped)}
    layout = j.get("layout") or "grid"
    if layout == "compare":
        imgs = imgs[:4]
        H = int(j.get("cell") or 700)
        panels = [(n, fit(im, 99999, H), s) for n, im, s in imgs]
        if j.get("diff") and len(imgs) == 2:
            a, b = imgs[0][1], imgs[1][1]
            d = ImageChops.difference(a, b.resize(a.size, Image.LANCZOS)).convert("L").point(lambda v: min(255, v * 4))
            heat = ImageOps.colorize(d, black=(20, 20, 24), white=(255, 70, 60)).convert("RGB")
            panels.append(("Difference (brighter = more different)", fit(heat, 99999, H), a.size))
        gap, pad, lab = 24, 24, (46 if labels else 0)
        total_w = sum(p[1].width for p in panels) + gap * (len(panels) - 1) + pad * 2
        total_h = H + lab + pad * 2
        sheet = Image.new("RGB", (total_w, total_h), BG)
        draw, f = ImageDraw.Draw(sheet), font(22)
        x = pad
        for i, (name, im, size) in enumerate(panels):
            sheet.paste(im, (x, pad + (H - im.height) // 2))
            if labels:
                tag = ("AB"[i] + ": " if i < 2 and len(panels) <= 3 and len(imgs) == 2 else f"{i + 1}: ") if i < len(imgs) else ""
                text = shorten(f"{tag}{name}  {size[0]}x{size[1]}" if i < len(imgs) else name, draw, f, max(im.width, 200))
                draw.text((x, pad + H + 10), text, fill=(40, 40, 40), font=f)
            x += im.width + gap
    else:
        n = len(imgs)
        cols = int(j.get("cols") or math.ceil(math.sqrt(n)))
        cols = max(1, min(cols, n))
        rows = math.ceil(n / cols)
        S = int(j.get("cell") or 360)
        gap, pad, lab = 16, 20, (40 if labels else 0)
        sheet = Image.new("RGB", (pad * 2 + cols * S + gap * (cols - 1), pad * 2 + rows * (S + lab) + gap * (rows - 1)), BG)
        draw, f = ImageDraw.Draw(sheet), font(18)
        for i, (name, im, size) in enumerate(imgs):
            r, c = divmod(i, cols)
            x, y = pad + c * (S + gap), pad + r * (S + lab + gap)
            t = fit(im, S, S)
            sheet.paste(t, (x + (S - t.width) // 2, y + (S - t.height) // 2))
            if labels:
                draw.text((x, y + S + 6), shorten(name, draw, f, S), fill=(40, 40, 40), font=f)
                draw.text((x, y + S + 24), f"{size[0]}x{size[1]}", fill=(130, 130, 130), font=font(14))
    save(sheet, j["out"])
    view = shrink_for_view(sheet, int(j.get("view_max") or 1568))
    save(view, j["view"])
    return {"out": j["out"], "view": j["view"], "w": sheet.width, "h": sheet.height, "count": len(imgs), "skipped": skipped}


def cmd_info(j):
    im = Image.open(j["in"])
    return {"w": im.width, "h": im.height}


def cmd_resize(j):
    im = load(j["in"])
    f = float(j["factor"])
    out = im.resize((max(1, round(im.width * f)), max(1, round(im.height * f))), Image.LANCZOS)
    save(out, j["out"])
    return {"out": j["out"], "w": out.width, "h": out.height}


def cmd_upscale(j):
    im = load(j["in"])
    s = int(j.get("scale") or 2)
    big = im.resize((im.width * s, im.height * s), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
    save(big, j["out"])
    return {"out": j["out"], "w": big.width, "h": big.height}


if __name__ == "__main__":
    try:
        job = json.load(open(sys.argv[2], encoding="utf-8"))
        print(json.dumps({"convert": cmd_convert, "board": cmd_board, "upscale": cmd_upscale, "info": cmd_info, "resize": cmd_resize}[sys.argv[1]](job)))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
