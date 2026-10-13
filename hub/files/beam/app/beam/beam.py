"""Beam core - the local transfer engine, run by the Shivo Labs hub (hub/engines/beam_host.py).

The iPhone talks to it over whatever network both devices share (home Wi-Fi,
the iPhone's Personal Hotspot, ...). Nothing leaves that network.
"""
import itertools, json, mimetypes, mmap, os, re, secrets, shutil, socket, subprocess, sys, threading, time, urllib.parse, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.sax.saxutils import escape

PORT = 8765
HOME = Path(os.environ.get("APPDATA", Path.home())) / "Beam"
OUTBOX = HOME / "outbox"
INBOX = Path.home() / "Downloads" / "Beam"
CHUNK = 1024 * 1024
ASSETS = {"/apple-touch-icon.png": "apple-touch-icon.png", "/icon.png": "logo.png",
          **{f"/fonts/{n}": f"fonts/{n}" for n in ("Sora-Light.ttf", "Sora-SemiBold.ttf",
                                                   "HankenGrotesk-Regular.ttf", "HankenGrotesk-SemiBold.ttf")}}
NOWIN = 0x08000000  # CREATE_NO_WINDOW
HERE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
on_received = None  # set by the tray app: called with the saved Path
on_show = None      # set by the tray app: called when Beam is launched again
ask_accept = None   # set by the tray app: ask_accept(ip) -> bool, blocks until the user answers
SHORTCUT_URL = "https://www.icloud.com/shortcuts/6d7b833ce6604d239fd92e8bc1079494"  # "Send to PC", for every iPhone
MDNS_NAME = "beam.local"  # every Beam PC answers to this, so one iPhone Shortcut works for everyone
_asks, _declined, _ask_lock = {}, {}, threading.Lock()


def config():
    HOME.mkdir(parents=True, exist_ok=True)
    f = HOME / "config.json"
    if f.exists():
        return json.loads(f.read_text())
    cfg = {"token": secrets.token_urlsafe(9), "port": PORT}
    f.write_text(json.dumps(cfg))
    return cfg


def save_config(cfg):
    (HOME / "config.json").write_text(json.dumps(cfg))


# ---------- your devices: each one gets its own waiting list ----------
# A device is known by the id the Shivo Labs app (or the Beam page) sends with every request (X-Beam-Id, or ?bid= in
# the address for downloads that can't carry headers; kept on the
# device), or, for older apps and the Shortcut, by its Wi-Fi hardware address (device_id). The app also says its name
# and kind (X-Beam-Name, X-Beam-Kind: iphone, ipad, android, tablet). The hub shows these as cards and sends files to
# one or several of them: a file in outbox/<device folder>/ waits only for that device; a file loose in outbox/ is
# for whichever device asks first (as before).
DEVICES = HOME / "devices.json"
_devices, _dev_lock, _dev_saved = None, threading.Lock(), [0.0]


def devices():
    global _devices
    if _devices is None:
        try:
            _devices = json.loads(DEVICES.read_text())
        except (OSError, ValueError):
            _devices = {}
    return _devices


def note_device(did, name="", kind="", mac=""):
    """Remember a device and when it was last seen (written now and then, not on every 4-second check)."""
    with _dev_lock:
        d = devices().setdefault(did, {})
        changed = ((name and d.get("name") != name) or (kind and d.get("kind") != kind)
                   or (mac and d.get("mac") != mac) or "seen" not in d)
        if name and d.get("name") != name:   # the device was (re)named on itself
            d["name"], d["named"] = name, time.time()
        if kind:
            d["kind"] = kind
        if mac:
            d["mac"] = mac
        d["seen"] = time.time()
        d.setdefault("first", d["seen"])
        if changed or time.time() - _dev_saved[0] > 15:
            _dev_saved[0] = time.time()
            try:
                HOME.mkdir(parents=True, exist_ok=True)
                tmp = DEVICES.with_suffix(".tmp")
                tmp.write_text(json.dumps(_devices))
                os.replace(tmp, DEVICES)
            except OSError:
                pass


def dev_dir(did):
    return OUTBOX / ("d-" + re.sub(r"[^A-Za-z0-9-]", "_", did))


def device_id(ip):
    """An iPhone keeps one Wi-Fi hardware address per network, so trust survives its IP changing."""
    try:
        out = subprocess.run(["arp", "-a", ip], capture_output=True, text=True, timeout=3, creationflags=NOWIN).stdout
        m = re.search(re.escape(ip) + r"\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})", out, re.I)
        if m:
            return "mac:" + m.group(1).lower()
    except (OSError, subprocess.SubprocessError):
        pass
    return "ip:" + ip


def advertise(port, stop):
    """Answer to beam.local over mDNS and re-announce when this PC's address changes. Runs until stop is set."""
    from zeroconf import ServiceInfo, Zeroconf
    zc, info, ip = Zeroconf(), None, None
    try:
        while not stop.is_set():
            now = lan_ip()
            if now != ip and now != "127.0.0.1":
                new = ServiceInfo("_http._tcp.local.", f"Shivo Labs Beam on {socket.gethostname()}._http._tcp.local.",
                                  addresses=[socket.inet_aton(now)], port=port, server=MDNS_NAME + ".",
                                  properties={"app": "shivo-labs-beam"})
                if info:
                    zc.unregister_service(info)
                zc.register_service(new, allow_name_change=True)
                info, ip = new, now
            stop.wait(30)
    finally:
        if info:
            zc.unregister_service(info)
        zc.close()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.168.0.1", 9))  # no packet is sent; just picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


APP_ID = "ShivoLabs.Beam"


def register_app_id():
    """Register "Shivo Labs Beam" with Windows (per user, no admin) so notifications carry its own name and icon
    instead of "Windows PowerShell". Returns the id to send toasts as."""
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\AppUserModelId\{APP_ID}") as k:
            winreg.SetValueEx(k, "DisplayName", 0, winreg.REG_SZ, "Shivo Labs Beam")
            winreg.SetValueEx(k, "IconUri", 0, winreg.REG_SZ, str(HERE / "assets" / "logo.png"))
            winreg.SetValueEx(k, "IconBackgroundColor", 0, winreg.REG_SZ, "FF141517")
        return APP_ID
    except OSError:
        return "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"


def toast(title, body, open_path=None):
    launch = f' activationType="protocol" launch="{escape(Path(open_path).as_uri())}"' if open_path else ""
    logo = HERE / "assets" / "logo.png"
    logo = f'<image placement="appLogoOverride" src="{escape(logo.as_uri())}"/>' if logo.exists() else ""
    xml = (f'<toast{launch}><visual><binding template="ToastGeneric"><text>{escape(title)}</text>'
           f'<text>{escape(body)}</text>{logo}</binding></visual></toast>')
    ps = (
        "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;"
        "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null;"
        "$x=New-Object Windows.Data.Xml.Dom.XmlDocument;$x.LoadXml($env:BEAM_TOAST);"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:BEAM_AUMID)"
        ".Show((New-Object Windows.UI.Notifications.ToastNotification $x))"
    )
    os.environ.setdefault("BEAM_AUMID", register_app_id())
    subprocess.Popen(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
                     env={**os.environ, "BEAM_TOAST": xml}, creationflags=NOWIN)


def set_clipboard(text):
    subprocess.run(["clip"], input=text.encode("utf-16le"), creationflags=NOWIN)


def safe_name(name, ext):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or time.strftime("beam-%Y%m%d-%H%M%S")
    ext = re.sub(r"[^A-Za-z0-9]", "", ext or "").lower()
    if ext and not name.lower().endswith("." + ext):
        name += "." + ext
    return name


def log(msg):
    """Small rolling log at %APPDATA%\\Beam\\beam.log, for diagnosing what an iPhone actually sent."""
    try:
        f = HOME / "beam.log"
        if f.exists() and f.stat().st_size > 1_000_000:
            f.replace(f.with_suffix(".old.log"))
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


def sniff(head):
    """File extension from the first bytes, for uploads that arrive without a name."""
    head = bytes(head)
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG"):
        return "png"
    if head.startswith(b"GIF8"):
        return "gif"
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"PK\x03\x04"):
        return "zip"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"heic", b"heix", b"hevc", b"mif1", b"msf1"):
            return "heic"
        return "mov" if brand == b"qt  " else "mp4"
    return ""


def unique(folder, name):
    """Claim a free name ("x (1).jpg"...) by creating it, so parallel uploads can't pick the same one."""
    folder.mkdir(parents=True, exist_ok=True)
    stem, suf, n = Path(name).stem, Path(name).suffix, 0
    while True:
        p = folder / (name if n == 0 else f"{stem} ({n}){suf}")
        try:
            open(p, "x").close()
            return p
        except FileExistsError:
            n += 1


def header(h, key):
    v = h.get(key, "")
    try:
        v = v.encode("latin-1").decode("utf-8")  # Shortcuts sends raw UTF-8 in headers
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return urllib.parse.unquote(v)


_trust_cache = {}  # ip -> (checked at, is trusted)
_addr_cache = {}   # ip -> (checked at, device id from the Wi-Fi address)


class Handler(BaseHTTPRequestHandler):
    server_version = "Beam/1.0"
    timeout = 30  # a stalled upload gives up instead of hanging
    path_token = ""

    def log_message(self, *a):
        pass

    def log_request(self, code="-", size="-"):
        path = re.sub(r"/p/[\w-]+", "/p/…", getattr(self, "path", "") or "")
        if code == 200 and path.split("?")[0] in ("/outbox", "/ping"):
            return  # the phone app asks every few seconds; keep the log for real transfers
        log(f"{self.client_address[0]} {getattr(self, 'command', '-')} {path} -> {code}")

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except Exception:
            import traceback
            log("ERROR " + traceback.format_exc())
            raise

    # ---- helpers
    APP_ORIGINS = ("capacitor://localhost", "ionic://localhost", "http://localhost")

    def end_headers(self):
        origin = self.headers.get("Origin", "") if hasattr(self, "headers") else ""
        if origin in self.APP_ORIGINS:  # the Shivo Labs phone app; ordinary websites stay blocked
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition, X-Remaining, X-Kind")
        super().end_headers()

    def do_OPTIONS(self):
        if self.headers.get("Origin", "") not in self.APP_ORIGINS:
            return self.reply(403, "")
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "X-Token, X-Name, X-Beam-Id, X-Beam-Name, X-Beam-Kind, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def param(self, key):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get(key, [""])[0]

    def mac(self):
        """This device's Wi-Fi address (cached a minute, like trust)."""
        ip, now = self.client_address[0], time.time()
        hit = _addr_cache.get(ip)
        if not hit or now - hit[0] > 60:
            hit = _addr_cache[ip] = (now, device_id(ip))
        return hit[1]

    def device(self):
        """Who is asking: the id the app sends; without one (the Shortcut, an older app) the Wi-Fi address, or the
        app on that same phone if it has checked in, so one phone is one device however it asks."""
        if getattr(self, "_did", None):
            return self._did
        given = re.sub(r"[^A-Za-z0-9-]", "", self.headers.get("X-Beam-Id", "") or self.param("bid"))[:64]
        if given:
            self._did = "app:" + given
        else:
            mac = self.mac()
            same = [(d.get("seen", 0), k) for k, d in list(devices().items()) if k.startswith("app:") and d.get("mac") == mac]
            self._did = max(same)[1] if same else mac
        return self._did

    def authed(self, path=""):
        tok = self.server.cfg["token"]
        cookie = re.search(r"beam=([\w-]+)", self.headers.get("Cookie", ""))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("t", [""])[0]
        given = (self.headers.get("X-Token", ""), cookie and cookie.group(1), q, self.path_token)
        if tok in given:
            return True
        # An iPhone the PC owner already accepted doesn't need the pairing code: this keeps the
        # Home Screen icon working when its saved code is out of date (e.g. after a reinstall).
        if self.trusted_phone():
            return True
        # The universal Shortcut carries no code: the PC owner accepts each new iPhone once, like AirDrop.
        if not any(given) and path in ("/upload", "/pull", "/next", "/outbox", "/ping"):
            if self.approve():
                return True
            self.reply(403, "Not accepted on the PC.")
            return False
        self.reply(401, "Wrong or missing token. Re-pair from the setup page on your PC.")
        return False

    def trusted_phone(self):
        ip, now = self.client_address[0], time.time()
        hit = _trust_cache.get(ip)
        if hit and now - hit[0] < 60:
            return hit[1]
        ok = device_id(ip) in self.server.cfg.get("trusted", [])
        _trust_cache[ip] = (now, ok)
        return ok

    def approve(self):
        cfg, ip = self.server.cfg, self.client_address[0]
        did = device_id(ip)
        if did in cfg.setdefault("trusted", []):
            return True
        if not ask_accept:
            return False
        with _ask_lock:
            if time.time() - _declined.get(did, 0) < 600:  # declined recently: don't nag
                return False
            ask = _asks.get(did)
            mine = ask is None
            if mine:  # one prompt per device, even when several files arrive at once
                ask = _asks[did] = {"done": threading.Event(), "ok": False}
        if mine:
            try:
                ask["ok"] = bool(ask_accept(ip))
            finally:
                with _ask_lock:
                    _asks.pop(did, None)
                    if ask["ok"]:
                        cfg["trusted"].append(did)
                        save_config(cfg)
                    else:
                        _declined[did] = time.time()
                ask["done"].set()
        else:
            ask["done"].wait(70)
        return ask["ok"]

    def reply(self, code, body, ctype="text/plain; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        extra = {"Cache-Control": "no-store", **(extra or {})}
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def body_chunks(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    return
                left = size
                while left:
                    b = self.rfile.read(min(CHUNK, left))
                    if not b:
                        return
                    left -= len(b)
                    yield b
                self.rfile.readline()
        else:
            left = int(self.headers.get("Content-Length", 0))
            while left:
                b = self.rfile.read(min(CHUNK, left))
                if not b:
                    return
                left -= len(b)
                yield b

    def send_file(self, p, delete=False):
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(p.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(p.stat().st_size))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(p.name))
        self.send_header("X-Remaining", str(max(0, len(outbox(self.device())) - (1 if delete else 0))))
        self.send_header("X-Kind", "media" if is_media(p) else "file")
        self.end_headers()
        size, t0 = p.stat().st_size, time.time()
        with open(p, "rb") as f:
            shutil.copyfileobj(f, self.wfile, CHUNK)
        secs = max(time.time() - t0, 0.001)
        log(f"  sent {p.name}: {size / 1e6:.1f} MB in {secs:.1f}s ({size / 1e6 / secs:.0f} MB/s)")
        if delete:
            p.unlink(missing_ok=True)

    def route(self):
        """/p/<token>/upload is /upload carrying its own token, so the iPhone Shortcut only has to
        append a word to the pairing link it scanned from the QR code."""
        path = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/p/([\w-]+)(/.+)?$", path)
        self.path_token = m.group(1) if m else ""
        return (m.group(2) or "/") if m else path

    # ---- routes
    def do_GET(self):
        path = self.route()
        if path == "/":  # the iPhone page; /p/<token> keeps it paired after Add to Home Screen
            return self.reply(200, (HERE / "phone.html").read_bytes(), "text/html; charset=utf-8")
        if path in ASSETS:
            f = HERE / "assets" / ASSETS[path]
            return self.reply(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "font/ttf",
                              {"Cache-Control": "max-age=604800"})
        if path == "/show" and self.client_address[0] == "127.0.0.1":
            if on_show:
                on_show()
            return self.reply(200, "ok")
        if not self.authed(path):
            return
        self.seen()
        if path == "/ping":
            return self.reply(200, json.dumps({"ok": True, "pc": socket.gethostname()}), "application/json")
        if path == "/outbox":
            items = [{"name": p.name, "size": p.stat().st_size, "kind": "media" if is_media(p) else "file"} for p in outbox(self.device())]
            return self.reply(200, json.dumps(items), "application/json")
        if path.startswith("/file/"):
            p = find_waiting(self.device(), Path(urllib.parse.unquote(path[6:])).name)
            return self.send_file(p) if p else self.reply(404, "Not found")
        if path == "/pull":
            items = outbox(self.device())
            return self.send_file(items[0], delete=True) if items else self.reply(200, "Nothing waiting on the PC.")
        if path == "/next":  # like /pull, but an empty queue answers 204 (no content) so a Shortcut loop can stop
            kind = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("kind", [""])[0]
            items = [p for p in outbox(self.device()) if not kind or (kind == "media") == is_media(p)]
            if items:
                return self.send_file(items[0], delete=True)
            self.send_response(204)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        self.reply(404, "Not found")

    def seen(self):
        try:
            did = self.device()
            kind = re.sub(r"[^a-z]", "", (self.headers.get("X-Beam-Kind", "") or self.param("bkind")).lower())[:12]
            if not kind:
                ua = self.headers.get("User-Agent", "")
                kind = ("ipad" if "iPad" in ua else "iphone" if re.search(r"iPhone|iPod|CFNetwork|Darwin", ua)
                        else "android" if "Android" in ua else "")
            note_device(did, urllib.parse.unquote(self.headers.get("X-Beam-Name", "") or self.param("bname"))[:60].strip(),
                        kind, self.mac() if did.startswith("app:") else "")
        except Exception:  # never let bookkeeping get in the way of a transfer
            pass

    def do_POST(self):
        path = self.route()
        if not self.authed(path):
            return
        self.seen()
        if path == "/done":  # the phone app saved this file: take it off the PC's send list
            name = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("name", [""])[0]
            p = find_waiting(self.device(), Path(name).name) if name else None
            if p:
                try:
                    p.unlink()
                except OSError:
                    pass  # still being read; the phone's own record stops it being saved twice
            return self.reply(200, "ok")
        if path == "/clear":
            for p in outbox(self.device()):
                try:
                    p.unlink()
                except OSError:
                    pass
            return self.reply(200, "ok")
        if path != "/upload":
            return self.reply(404, "Not found")
        full_ctype = self.headers.get("Content-Type", "")
        log(f"upload from {self.client_address[0]}: {full_ctype or '(no type)'}, "
            f"{self.headers.get('Content-Length') or self.headers.get('Transfer-Encoding')}")
        boundary = re.search(r'boundary="?([^";]+)"?', full_ctype)
        if full_ctype.lower().startswith("multipart/form-data") and boundary:
            n = self.receive_multipart(boundary.group(1).encode())
            log(f"  saved {n} file(s)")
            return self.reply(200 if n else 400, "Sent to PC" if n else "No file in the upload")
        self.receive(header(self.headers, "X-Name"), header(self.headers, "X-Ext"),
                     full_ctype.split(";")[0].strip().lower(), self.body_chunks())
        self.reply(200, "Sent to PC")

    def receive_multipart(self, boundary):
        """Shortcuts' "Request Body: Form" upload. The body is spooled to disk, then each file part is
        cut out of it, so even multi-GB videos never sit in memory."""
        INBOX.mkdir(parents=True, exist_ok=True)
        spool = INBOX / f".beam-{secrets.token_hex(8)}.part"  # per request: uploads can arrive in parallel
        with open(spool, "wb") as f:
            for b in self.body_chunks():
                f.write(b)
        n = 0
        try:
            with open(spool, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as m:
                delim = b"--" + boundary
                pos = m.find(delim)
                while pos != -1:
                    if m[pos + len(delim):pos + len(delim) + 2] == b"--":  # closing delimiter
                        break
                    head_start = pos + len(delim) + 2  # skip the CRLF after the delimiter
                    head_end = m.find(b"\r\n\r\n", head_start)
                    if head_end == -1:
                        break
                    head = m[head_start:head_end].decode("utf-8", "replace")
                    body_start = head_end + 4
                    nxt = m.find(b"\r\n" + delim, body_start)
                    if nxt == -1:
                        break
                    fn = re.search(r"filename\*=UTF-8''([^;\r\n]+)", head, re.I)
                    fn = urllib.parse.unquote(fn.group(1)) if fn else (re.search(r'filename="([^"]*)"', head) or [None, None])[1]
                    ct = (re.search(r"content-type:\s*([^\r\n;]+)", head, re.I) or [None, ""])[1].strip().lower()
                    log(f"  part: {head.replace(chr(13) + chr(10), ' | ')} ({nxt - body_start} bytes)")
                    looks_binary = sniff(m[body_start:body_start + 32]) or (ct and not ct.startswith("text/"))
                    if fn is None and nxt > body_start and (looks_binary or nxt - body_start >= 64_000):
                        fn = ""  # a file sent without a filename (e.g. a Form field Shortcuts didn't name)
                    if fn is not None:
                        stem, _, ext = fn.rpartition(".") if "." in fn else (fn, "", "")
                        ext = ext or sniff(m[body_start:body_start + 32])
                        chunks = (m[i:min(i + CHUNK, nxt)] for i in range(body_start, nxt, CHUNK))
                        self.receive(stem, ext, ct, chunks, size=nxt - body_start)
                        n += 1
                    pos = nxt + 2
        finally:
            spool.unlink(missing_ok=True)
        return n

    def receive(self, name, ext, ctype, chunks, size=None):
        chunks = iter(chunks)
        first = next(chunks, b"")
        chunks = itertools.chain([first], chunks)
        if not ext and not ctype.startswith("text/"):
            ext = sniff(first[:32]) or (mimetypes.guess_extension(ctype) or "").lstrip(".")
            if ext == "bin":
                ext = sniff(first[:32]) or "bin"
        # Shortcuts wraps shared text and links as a small "Text.txt" / "URL.txt"-style file
        shared_text = ext.lower() == "txt" and name.lower() in ("text", "url", "untitled", "") and (size or 0) < 64_000

        # Shared text / links go to the clipboard (links also open), like AirDrop on a Mac.
        if shared_text or (not ext and (ctype.startswith("text/") or ctype in ("", "application/x-www-form-urlencoded"))):
            data = b"".join(chunks)
            if len(data) < 2_000_000:
                text = data.decode("utf-8", "replace").strip()
                if re.fullmatch(r"https?://\S+", text):
                    webbrowser.open(text)
                    toast("Link from iPhone", text)
                else:
                    set_clipboard(text)
                    toast("Copied from iPhone", text[:120] or "(empty)")
                return
            INBOX.mkdir(parents=True, exist_ok=True)
            dest = unique(INBOX, safe_name(name, "txt"))
            dest.write_bytes(data)
        else:
            INBOX.mkdir(parents=True, exist_ok=True)
            dest = unique(INBOX, safe_name(name, ext))
            part = dest.with_name(dest.name + ".part")
            with open(part, "wb") as f:
                for b in chunks:
                    f.write(b)
            part.replace(dest)

        now = time.time()
        batch = self.server.batch
        batch["n"] = batch["n"] + 1 if now - batch["t"] < 4 else 1
        batch["t"] = now
        toast("Received from iPhone" if batch["n"] == 1 else f"Received {batch['n']} files from iPhone",
              dest.name, INBOX)
        if on_received:
            on_received(dest)


def is_media(p):
    t = mimetypes.guess_type(p.name)[0] or ""
    return t.startswith("image/") or t.startswith("video/") or p.suffix.lower() in (".heic", ".heif", ".mov")


def find_waiting(did, name):
    for folder in (dev_dir(did), OUTBOX):
        p = folder / name
        if p.is_file():
            return p
    return None


def outbox(did=None):
    """What waits for this device: its own folder first, then files for any device."""
    OUTBOX.mkdir(parents=True, exist_ok=True)
    folders = ([dev_dir(did)] if did and dev_dir(did).is_dir() else []) + [OUTBOX]
    return sorted((p for d in folders for p in d.iterdir() if p.is_file() and not p.name.startswith(".") and not p.name.endswith(".part")),
                  key=lambda p: p.stat().st_mtime)


class OnlyServer(ThreadingHTTPServer):
    """The port is this engine's alone: on Windows, address reuse would let a second engine listen on it too, and
    phones would reach one or the other at random."""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_server():
    """Returns the server, or None if Beam is already running."""
    cfg = config()
    try:
        srv = OnlyServer(("0.0.0.0", cfg["port"]), Handler)
    except OSError:
        return None
    srv.cfg, srv.batch = cfg, {"n": 0, "t": 0}
    INBOX.mkdir(parents=True, exist_ok=True)
    OUTBOX.mkdir(parents=True, exist_ok=True)
    for stale in [*OUTBOX.glob(".*"), *OUTBOX.glob("*.part"), *OUTBOX.glob("d-*/.*")]:  # temp files from a send that was cut short
        stale.unlink(missing_ok=True)
    return srv


def publish(tmp, folder, name):
    """Give a finished temp file its real name in one step (the first free "x (1).jpg"...). Linking fails
    when the name is taken, so parallel sends can't pick the same one, and the phone never sees a
    half-copied video: the file is either complete or not listed at all."""
    stem, suf, n = Path(name).stem, Path(name).suffix, 0
    while True:
        final = folder / (name if n == 0 else f"{stem} ({n}){suf}")
        try:
            os.link(tmp, final)
        except FileExistsError:
            n += 1
            continue
        except OSError:  # a drive without links: rename instead
            if final.exists():
                n += 1
                continue
            tmp.replace(final)
            return final
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass  # held for a moment (antivirus); it is hidden and cleared at the next start
        return final


def send(files, to=None):
    """Put files on the waiting list of the devices in to (their ids), or, without to, for any device.
    A folder goes as a zip. With several devices the file is copied once and the others get hard links
    (no extra disk space); each device takes and removes its own."""
    folders = [dev_dir(d) for d in (to or [])] or [OUTBOX]
    for d in folders:
        d.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in map(Path, files):
        tmp = OUTBOX / f".{secrets.token_hex(6)}"  # hidden until complete (outbox() skips dot files)
        try:
            if f.is_file():
                shutil.copyfile(f, tmp)
                name = f.name
            elif f.is_dir():
                tmp = Path(shutil.make_archive(str(tmp), "zip", f))
                name = f.name + ".zip"
            else:
                continue
            os.utime(tmp)  # fresh mtime = queue order
            for folder in folders:
                part = folder / f".{secrets.token_hex(6)}"
                try:
                    os.link(tmp, part)
                except OSError:
                    shutil.copyfile(tmp, part)
                publish(part, folder, name)
            n += 1
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    return n


def notify_queued(n):
    if n:
        toast(f"{n} item{'s' if n > 1 else ''} ready for iPhone",
              "On your iPhone run “Get from PC” (or open the Beam page).")

