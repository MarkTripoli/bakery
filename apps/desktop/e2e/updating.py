#!/usr/bin/env python3
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse

OUT = os.environ.get("OUT", "/out")
BIN = os.environ["KEYED_BIN"]
PAY = "/tmp/serve/pay"
HOME = os.environ["HOME"]
APP_VERSION = os.environ.get("APP_VERSION") or json.load(open("/app/src-tauri/tauri.conf.json"))["version"]
ARCH = subprocess.check_output(["uname", "-m"], text=True).strip()  # x86_64 or aarch64, as the app reports it

results = []
LOG = []  # (monotonic seconds, method, path, query, authorization)
MODE = {"feed": "204", "handoff_delay": 0.0, "compat": 1}

def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""), flush=True)

def signature(which):
    return open(os.path.join(PAY, f"update.{which}.sig")).read().strip()

class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body=b"", ctype="application/json", headers=()):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def offer(self, version, file, sig):
        body = {"version": version, "pub_date": "2026-11-23T00:00:00Z", "url": f"{ORIGIN}/pay/{file}",
                "signature": signature(sig), "notes": "Notes"}
        self.send(200, json.dumps(body).encode())

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        LOG.append((time.monotonic(), "GET", url.path, url.query, self.headers.get("Authorization")))
        if url.path == "/health":
            self.send(200, json.dumps({"service": "bakery-server", "compatibility": MODE["compat"]}).encode())
        elif url.path == "/v1/me":
            self.send(200, json.dumps({"displayName": "Lab", "email": "lab@example.test"}).encode())
        elif url.path == "/api/desktop/handoff":
            time.sleep(MODE["handoff_delay"])
            self.send(303, b"", headers=[("location", "/")])
        elif url.path == "/":
            self.send(200, b"<!doctype html><title>Lab</title><h1>Lab page</h1>", "text/html")
        elif url.path == "/v1/desktop/update":
            feed = MODE["feed"]
            if feed == "204":
                self.send(204)
            elif feed == "newer":
                self.offer("9.9.9", "update.bin", "a")
            elif feed == "tampered":
                self.offer("9.9.9", "update-tampered.bin", "a")
            elif feed == "wrongkey":
                self.offer("9.9.9", "update.bin", "b")
            elif feed == "older":
                self.offer("0.0.1", "update.bin", "a")
            elif feed == "same":
                self.offer(APP_VERSION, "update.bin", "a")
            elif feed == "nofeed":
                self.send(404, b'{"title":"Not found"}')
            else:
                self.send(500, b"{}")
        elif url.path.startswith("/pay/"):
            data = open(os.path.join(PAY, url.path[5:]), "rb").read()
            self.send(200, data, "application/octet-stream")
        else:
            self.send(404)

    def do_POST(self):
        LOG.append((time.monotonic(), "POST", self.path, "", self.headers.get("Authorization")))
        self.rfile.read(int(self.headers.get("content-length", "0")))
        if self.path.startswith("/v1/desktop-handoffs"):
            self.send(201, json.dumps({"code": "labcode", "expiresAt": "2030-01-01T00:00:00Z"}).encode())
        else:
            self.send(404)

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
ORIGIN = f"http://127.0.0.1:{server.server_address[1]}"
threading.Thread(target=server.serve_forever, daemon=True).start()
subprocess.run(["secret-tool", "store", "--label=lab", "service", "bakery-desktop", "username", ORIGIN],
               input=b"bkd_lab", capture_output=True)

app = None

def reports(path):
    out = []
    try:
        for line in open(os.path.join(path, "report.jsonl")):
            out.append(json.loads(line))
    except FileNotFoundError:
        pass
    return out

def wait_until(condition, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.3)
    return False

def start(name, feed, tick=400, extra=None, handoff_delay=0.0):
    global app
    stop()
    MODE["feed"], MODE["handoff_delay"] = feed, handoff_delay
    LOG.clear()
    path = os.path.join(OUT, name)
    os.makedirs(os.path.join(path, "cmd"), exist_ok=True)
    config = os.path.join(path, "config")
    os.makedirs(config, exist_ok=True)
    env = dict(os.environ, BAKERY_SERVER=ORIGIN, BAKERY_DESKTOP_REPORT=os.path.join(path, "report.jsonl"),
               BAKERY_DESKTOP_COMMANDS=os.path.join(path, "cmd"), BAKERY_DESKTOP_CONFIG_DIR=config, TZ="UTC",
               BAKERY_DESKTOP_UPDATE_TICK_MS=str(tick), **(extra or {}))
    app = subprocess.Popen([BIN], env=env, stdout=open(os.path.join(path, "app.log"), "a"), stderr=subprocess.STDOUT)
    return path

def stop():
    global app
    if app and app.poll() is None:
        app.terminate()
        try:
            app.wait(10)
        except Exception:
            app.kill()
    subprocess.run(["pkill", "-9", "-f", BIN], capture_output=True)
    time.sleep(1)
    app = None

def states(path):
    return [e["data"].get("state") for e in reports(path) if e["event"] == "update_state"]

def toasts(path):
    return [e["data"].get("text") for e in reports(path) if e["event"] == "toast"]

def feed_hits():
    return [entry for entry in LOG if entry[2] == "/v1/desktop/update"]

def downloads_hits():
    return [entry for entry in LOG if entry[2].startswith("/pay/")]

def press_menu(path):
    open(os.path.join(path, "cmd", "menu-update_action"), "w").close()

p = start("a-current", "204")
check("[current] the app asks its server and is told it is up to date", wait_until(lambda: "up_to_date" in states(p)))
hits = feed_hits()
check("[current] it asks once the first page has shown, not before",
      bool(hits) and any(e["event"] == "page_loaded" for e in reports(p)))
query = urllib.parse.parse_qs(hits[0][3]) if hits else {}
check("[current] it says its system, processor and version", query.get("target") == ["linux"]
      and query.get("arch") == [ARCH] and query.get("current_version") == [APP_VERSION], str(query))
check("[current] it sends its sign-in to the server", bool(hits) and hits[0][4] == "Bearer bkd_lab", str(hits[:1]))
check("[current] nothing is said on screen: a check the app starts itself is silent", toasts(p) == [], str(toasts(p)))

for feed in ("older", "same"):
    p = start(f"b-{feed}", feed)
    check(f"[{feed}] a {feed} version counts as up to date and nothing is downloaded",
          wait_until(lambda: "up_to_date" in states(p)) and not downloads_hits(), str(states(p)))

p = start("c-nofeed", "nofeed")
check("[no feed] a server with no update feed ends in its own state, not 'up to date'", wait_until(lambda: "no_feed" in states(p)), str(states(p)))
check("[no feed] and says nothing unasked", toasts(p) == [], str(toasts(p)))
p = start("c-error", "error")
check("[error] a server that fails ends in 'failed'", wait_until(lambda: "failed" in states(p)), str(states(p)))
check("[error] and says nothing: a check the app starts itself is silent", toasts(p) == [], str(toasts(p)))

p = start("d-ready", "newer")
check("[ready] a newer verified update is ready", wait_until(lambda: "ready" in states(p)), str(states(p)))
check("[ready] it says so, once, in the designs words",
      wait_until(lambda: any(t and t.startswith("Bakery 9.9.9 is ready.") for t in toasts(p))), str(toasts(p)))
dl = downloads_hits()
check("[ready] the download carries no sign-in: the file may be on another host", bool(dl) and all(e[4] is None for e in dl), str(dl[:2]))
check("[ready] the sign-in went only to the server's own feed", all(e[4] == "Bearer bkd_lab" for e in feed_hits()))
saved = os.path.join(HOME, "Downloads", "Bakery updates")
check("[ready] a build that cannot install itself saves the file to open", os.path.isdir(saved) and os.listdir(saved), saved)

for feed, label in (("tampered", "changed after it was signed"), ("wrongkey", "signed by another key")):
    subprocess.run(["rm", "-rf", saved])
    p = start(f"e-{feed}", feed)
    check(f"[{feed}] an update {label} is not installed", wait_until(lambda: "not_verified" in states(p)), str(states(p)))
    check(f"[{feed}] and the person is told, in the designs words",
          wait_until(lambda: "An update could not be verified and was not installed." in toasts(p)), str(toasts(p)))
    check(f"[{feed}] nothing was kept", not os.path.isdir(saved) or not os.listdir(saved), str(os.listdir(saved)) if os.path.isdir(saved) else "")

subprocess.run(["rm", "-rf", saved])
p = start("f-asked", "204", tick=500)
check("[24 hours] the launch check ends up to date", wait_until(lambda: "up_to_date" in states(p)), str(states(p)))
looked = len(feed_hits())
time.sleep(4)
check("[24 hours] and no second look follows within the day", len(feed_hits()) == looked, f"{looked} then {len(feed_hits())}")

press_menu(p)
check("[asked] nothing newer says 'Bakery is up to date.'", wait_until(lambda: "Bakery is up to date." in toasts(p)), str(toasts(p)))
MODE["feed"] = "error"
press_menu(p)
check("[asked] a server that fails says it could not check",
      wait_until(lambda: "Bakery could not check for updates." in toasts(p)), str(toasts(p)))
MODE["feed"] = "nofeed"
press_menu(p)
check("[asked] a server with no update feed says so, in the designs words",
      wait_until(lambda: "This server does not offer app updates." in toasts(p)), str(toasts(p)))
MODE["feed"] = "newer"
press_menu(p)
check("[asked] a newer one is downloaded and said to be ready",
      wait_until(lambda: any(t and t.startswith("Bakery 9.9.9 is ready.") for t in toasts(p))), str(toasts(p)))

subprocess.run(["secret-tool", "clear", "service", "bakery-desktop", "username", ORIGIN], capture_output=True)
subprocess.run(["rm", "-rf", saved])
p = start("i-signed-out", "newer")
check("[signed out] the app still looks, and a newer verified update is ready", wait_until(lambda: "ready" in states(p)), str(states(p)))
hits = feed_hits()
check("[signed out] it sent no sign-in, because it has none", bool(hits) and all(e[4] is None for e in hits), str(hits[:2]))
check("[signed out] no notice is drawn over the sign-in panel: it carries the line, the menu the action", toasts(p) == [], str(toasts(p)))
stop()
subprocess.run(["secret-tool", "store", "--label=lab", "service", "bakery-desktop", "username", ORIGIN], input=b"bkd_lab", capture_output=True)

p = start("j-older-app", "204", tick=600000)
check("[older app] the app opens on the server's page", wait_until(lambda: any(e["event"] == "server_page_opened" for e in reports(p))))
time.sleep(1)
MODE["compat"] = 99
MODE["feed"] = "newer"
before = len(feed_hits())
open(os.path.join(p, "cmd", "menu-use_different_server"), "w").close()

def window_kinds():
    return [e["data"]["window"].get("kind") for e in reports(p) if e["event"] == "view"]

check("[older app] Use a different server opens the chooser", wait_until(lambda: "choose" in window_kinds()), str(window_kinds()[-3:]))
port = ORIGIN.rsplit(":", 1)[1]
with open(os.path.join(p, "cmd", "choose-another"), "w") as f:
    f.write(f"http://localhost:{port}")
check("[older app] a server with a newer level brings up the older-app panel",
      wait_until(lambda: "incompatible" in window_kinds()), str(window_kinds()[-4:]))
check("[older app] arriving starts a check at once, though the clock would not for a day",
      wait_until(lambda: "ready" in states(p)) and len(feed_hits()) > before, f"{states(p)}, hits {before} then {len(feed_hits())}")
MODE["compat"] = 1

fake = os.path.join(HOME, "Bakery.AppImage")
old = b"\x7fELF old AppImage"
open(fake, "wb").write(old)
os.chmod(fake, 0o755)
p = start("g-restart", "newer", extra={"APPIMAGE": fake})
check("[restart] a self-installing build has a ready update", wait_until(lambda: "ready" in states(p)), str(states(p)))
time.sleep(2)
press_menu(p)
check("[restart] pressing Restart to update installs it",
      wait_until(lambda: open(fake, "rb").read() != old, timeout=60), str(open(fake, "rb").read()[:20]))
left = os.path.join(OUT, "g-restart", "config", "after-update.json")
check("[restart] it leaves the version and the page that was open for the next start",
      wait_until(lambda: os.path.exists(left)) and json.load(open(left)).get("to") == "9.9.9", open(left).read() if os.path.exists(left) else "")
check("[restart] and the app ends to start again", wait_until(lambda: app.poll() is not None, timeout=30))

p = start("h-after", "204", tick=600000)
os.makedirs(os.path.join(OUT, "h-after", "config"), exist_ok=True)
stop()
json.dump({"to": "9.9.9", "path": "/other"}, open(os.path.join(OUT, "h-after", "config", "after-update.json"), "w"))
p = start("h-after", "204", tick=600000)
check("[after] it says it was updated, in the designs words",
      wait_until(lambda: "Bakery was updated to version 9.9.9." in toasts(p)), str(toasts(p)))
check("[after] and the page that was open comes back", wait_until(
    lambda: any(e["event"] == "server_page_opened" and e["data"].get("path") == "/other" for e in reports(p))),
    str([e["data"] for e in reports(p) if e["event"] == "server_page_opened"]))
check("[after] the note is used once: the next start says nothing",
      not os.path.exists(os.path.join(OUT, "h-after", "config", "after-update.json")))

stop()
passed = sum(results)
print(f"{passed} passed, {len(results) - passed} failed", flush=True)
json.dump({"passed": passed, "failed": len(results) - passed}, open(os.path.join(OUT, "updating-results.json"), "w"))
sys.exit(0 if passed == len(results) else 1)
