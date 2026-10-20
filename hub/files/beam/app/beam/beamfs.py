"""Your PC in the iPhone's Files app: the PC folders a phone may browse, open and save into (beam.py passes /fs/ here).

Only phones holding their own key (given when the PC accepted them) get in, on the home Wi-Fi or through the relay;
the pairing code, the Shortcut and the browser page can't use it. Shared: the Beam folder (Downloads, Beam; always)
plus the folders added on the PC (hub, Beam, Folders on your phone; kept in phone-folders.json next to config.json).
Nothing outside them can be reached: every path is resolved and checked to stay inside its folder (no "..", no
links pointing out). Deleting moves to the Recycle Bin.

Items are named "<Shared folder>/<path inside it>" with forward slashes; "" is the top (the list of shared folders).
  GET  /fs/list?p=<folder id>                  -> {"items": [{id, name, dir, size, mtime}]}
  GET  /fs/file?p=<file id>                    -> the file
  POST /fs/put?p=<folder id>&name=<name>       body = the file; a new name if taken -> the item
  POST /fs/put?p=<file id>&replace=1           body = new contents of that file -> the item
  POST /fs/mkdir?p=<folder id>&name=<name>     -> the item
  POST /fs/move?p=<id>&to=<folder id>&name=<new name>   rename and/or move -> the item
  POST /fs/delete?p=<id>                       -> to the Recycle Bin
"""
import json, os, re, secrets, shutil, sys, time, urllib.parse
from pathlib import Path

CHUNK = 1024 * 1024
HIDDEN = {"desktop.ini", "thumbs.db", ".ds_store"}
BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


# the same places as beam.py
HOME = Path(os.environ.get("APPDATA", Path.home())) / "Beam"
INBOX = Path.home() / "Downloads" / "Beam"
FOLDERS = HOME / "phone-folders.json"


def shared(cfg=None):
    """{name: folder} the phone may see: the Beam folder, then the ones added on the PC (read each time, so a change
    on the PC shows at once)."""
    INBOX.mkdir(parents=True, exist_ok=True)
    out = {"Beam": INBOX}
    try:
        extra = json.loads(FOLDERS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        extra = []
    for f in extra if isinstance(extra, list) else []:
        p = Path(str(f.get("path", "")))
        if not p.is_dir():
            continue
        name, n = str(f.get("name") or p.name or "Folder")[:60], 2
        base = name
        while name in out:
            name, n = f"{base} ({n})", n + 1
        out[name] = p
    return out


class FsError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def resolve(cfg, item_id):
    """(path, root name, path inside) for an item id; FsError if it isn't inside a shared folder."""
    item_id = (item_id or "").strip("/")
    if not item_id:
        return None, "", ""
    root, _, rest = item_id.partition("/")
    roots = shared(cfg)
    if root not in roots:
        raise FsError(404, "No such folder on the PC")
    base = roots[root].resolve()
    parts = [x for x in rest.split("/") if x]
    if any(x in (".", "..") or BAD_NAME.search(x) for x in parts):
        raise FsError(400, "Bad name")
    p = base.joinpath(*parts)
    real = Path(os.path.realpath(p))
    try:
        inside = os.path.commonpath([str(real).lower(), str(base).lower()]) == str(base).lower()
    except ValueError:   # a link to another drive
        inside = False
    if not inside:
        raise FsError(403, "Outside the shared folders")
    return p, root, "/".join(parts)


def item(p, root, rel):
    st = p.stat()
    return {"id": f"{root}/{rel}" if rel else root, "name": p.name if rel else root, "dir": p.is_dir(),
            "size": 0 if p.is_dir() else st.st_size, "mtime": st.st_mtime}


def visible(p):
    n = p.name
    if n.startswith(".") or n.startswith("~$") or n.lower() in HIDDEN or n.endswith(".part"):
        return False
    if os.name == "nt":
        try:
            a = p.stat().st_file_attributes
            if a & 0x2 or a & 0x4:   # hidden, system
                return False
        except (OSError, AttributeError):
            pass
    return True


def clean_name(name):
    name = BAD_NAME.sub("_", urllib.parse.unquote(name or "")).strip(" .")
    if not name or name in (".", ".."):
        raise FsError(400, "Bad name")
    return name[:200]


def free_name(folder, name):
    stem, suf, n = Path(name).stem, Path(name).suffix, 0
    while True:
        p = folder / (name if n == 0 else f"{stem} ({n}){suf}")
        if not p.exists():
            return p
        n += 1


def to_recycle_bin(p):
    """Delete the Windows way: into the Recycle Bin, so a mistake on the phone can be undone on the PC."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR), ("pTo", wintypes.LPCWSTR),
                        ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL), ("hNameMappings", ctypes.c_void_p),
                        ("lpszProgressTitle", wintypes.LPCWSTR)]
        op = SHFILEOPSTRUCTW(None, 3, str(p) + "\0", None, 0x40 | 0x10 | 0x4 | 0x400, False, None, None)  # delete, undo, no confirm, silent, no error UI
        if ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) != 0 or op.fAnyOperationsAborted:
            raise FsError(500, "Could not move it to the Recycle Bin")
    elif p.is_dir():
        shutil.rmtree(p)
    else:
        p.unlink()


def _json(h, code, obj):
    h.reply(code, json.dumps(obj), "application/json")


def handle(h, method, path, cfg, write_body, stage):
    """h: the request handler (reply, param, send_file-like helpers). write_body(fileobj) copies the request body.
    stage: a folder for half-written files on the same drive as Downloads."""
    try:
        what = path[len("/fs/"):]
        pid = h.param("p")
        if method == "GET" and what == "list":
            if not pid.strip("/"):
                roots = shared(cfg)
                return _json(h, 200, {"items": [item(v, k, "") for k, v in roots.items()]})
            p, root, rel = resolve(cfg, pid)
            if not p.is_dir():
                raise FsError(404, "Not a folder")
            out = []
            for c in sorted(p.iterdir(), key=lambda x: x.name.lower()):
                try:
                    if visible(c):
                        out.append(item(c, root, f"{rel}/{c.name}" if rel else c.name))
                except OSError:
                    pass
            return _json(h, 200, {"items": out})
        if method == "GET" and what == "item":
            p, root, rel = resolve(cfg, pid)
            if p is None:
                return _json(h, 200, {"id": "", "name": "Your PC", "dir": True, "size": 0, "mtime": 0})
            if not p.exists():
                raise FsError(404, "Not found")
            return _json(h, 200, item(p, root, rel))
        if method == "GET" and what == "file":
            p, _, _ = resolve(cfg, pid)
            if p is None or not p.is_file():
                raise FsError(404, "Not found")
            return h.send_plain_file(p)
        if method != "POST":
            raise FsError(404, "Not found")
        if what == "put":
            if h.param("replace") == "1":
                p, root, rel = resolve(cfg, pid)
                if p is None or p.is_dir():
                    raise FsError(400, "Not a file")
                target = p
            else:
                folder, root, rel = resolve(cfg, pid)
                if folder is None or not folder.is_dir():
                    raise FsError(400, "Choose a folder inside one of the PC's folders")
                target = free_name(folder, clean_name(h.param("name")))
                rel = f"{rel}/{target.name}" if rel else target.name
            stage.mkdir(parents=True, exist_ok=True)
            tmp = stage / f"fs-{secrets.token_hex(8)}.part"
            try:
                with open(tmp, "wb") as f:
                    write_body(f)
                try:
                    os.replace(tmp, target)
                except OSError:   # another drive (e.g. Documents moved elsewhere): copy across
                    shutil.move(str(tmp), str(target))
            finally:
                if tmp.exists():
                    tmp.unlink()
            return _json(h, 200, item(target, root, rel))
        if what == "mkdir":
            folder, root, rel = resolve(cfg, pid)
            if folder is None or not folder.is_dir():
                raise FsError(400, "Choose a folder inside one of the PC's folders")
            target = free_name(folder, clean_name(h.param("name")))
            target.mkdir()
            return _json(h, 200, item(target, root, f"{rel}/{target.name}" if rel else target.name))
        if what == "move":
            p, root, rel = resolve(cfg, pid)
            if p is None or not rel or not p.exists():
                raise FsError(400, "Can't move that")
            dest_id = h.param("to") or pid.rsplit("/", 1)[0]
            folder, droot, drel = resolve(cfg, dest_id)
            if folder is None or not folder.is_dir():
                raise FsError(400, "Choose a folder inside one of the PC's folders")
            name = clean_name(h.param("name") or p.name)
            target = folder / name
            if target.exists() and target.resolve() != p.resolve():
                target = free_name(folder, name)
            if p.is_dir() and str(target.resolve()).lower().startswith(str(p.resolve()).lower() + os.sep):
                raise FsError(400, "Can't move a folder into itself")
            shutil.move(str(p), str(target))
            return _json(h, 200, item(target, droot, f"{drel}/{target.name}" if drel else target.name))
        if what == "delete":
            p, root, rel = resolve(cfg, pid)
            if p is None or not rel:
                raise FsError(400, "The PC's main folders can't be deleted")
            if p.exists():
                to_recycle_bin(p)
            return _json(h, 200, {"ok": True})
        raise FsError(404, "Not found")
    except FsError as e:
        return _json(h, e.code, {"error": str(e)})
    except PermissionError:
        return _json(h, 403, {"error": "Windows didn't allow that (the file may be open in another program)"})
    except FileNotFoundError:
        return _json(h, 404, {"error": "Not found"})
