"""Beam's engine inside the Shivo Labs hub: the file server the iPhone talks to, without the old tray app.

Runs beam/app/beam/beam.py from this repo unchanged. The questions the tray app used to ask
("Accept files from an iPhone?") go to the hub, which shows them in its window.

  pythonw beam_host.py               run the engine (the hub starts it)
  pythonw beam_host.py send <files>  put files on the iPhone's list (Explorer: right-click > Send to iPhone (Beam))
  pythonw beam_host.py add <files>   the same without a notice (the hub's Beam page shows its own)
"""
import json, os, sys, tempfile, threading, time, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "beam" / "app" / "beam"))
import beam  # noqa: E402

HUB = os.environ.get("SHIVO_HUB", "http://127.0.0.1:4800")


def ask_accept(ip):
    """Ask in the hub window; waits for the answer (the hub declines after a minute)."""
    req = urllib.request.Request(f"{HUB}/api/beam/ask", data=json.dumps({"ip": ip}).encode(),
                                 headers={"content-type": "application/json", "x-hub": "1"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=70) as r:
            return bool(json.load(r).get("ok"))
    except OSError:
        return False


def notify_together(n):
    """Explorer runs "Send to iPhone (Beam)" once per selected file, all at the same moment. Each run notes how many
    it added; the last one to finish shows a single notice for all of them (not ten notices for ten files)."""
    tally = Path(tempfile.gettempdir()) / "shivo-beam-send.txt"
    with open(tally, "a", encoding="utf-8") as f:
        f.write(f"{os.getpid()} {n}\n")
    time.sleep(1.5)
    try:
        lines = tally.read_text(encoding="utf-8").split()
    except OSError:
        return
    if len(lines) >= 2 and lines[-2] == str(os.getpid()):
        tally.unlink(missing_ok=True)
        beam.notify_queued(sum(int(x) for x in lines[1::2]))


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("send", "add"):
        n = beam.send(sys.argv[2:])
        if sys.argv[1] == "send":
            notify_together(n)
        return
    beam.register_app_id()
    beam.ask_accept = ask_accept
    srv = beam.make_server()
    if srv is None:  # already running
        return
    stop = threading.Event()

    def advertise():
        try:
            beam.advertise(srv.cfg["port"], stop)
        except Exception as e:  # Beam still works by IP / pairing link without beam.local
            print("beam.local unavailable:", e, file=sys.stderr)
    threading.Thread(target=advertise, daemon=True).start()
    try:
        srv.serve_forever()
    finally:
        stop.set()


if __name__ == "__main__":
    main()
