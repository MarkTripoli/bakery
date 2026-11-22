#!/usr/bin/env python3
"""The link lab (see lab.sh): how the window treats the links a server's page can hold, against a stub server."""
import http.server
import json
import os
import subprocess
import sys
import threading
import time

OUT = os.environ.get("OUT", "/out")
BIN = os.environ.get("BAKERY_DESKTOP_BIN", "/cache/target-desktop/debug/bakery-desktop")
PAGE = b"""<!doctype html><html><head><meta charset=utf-8><title>Lab</title></head><body>
<h1>Link lab</h1>
<style>a{position:absolute;left:20px;font-size:20px}
#blank{top:60px}#samepage{top:110px}#file{top:160px}#fileblank{top:210px}#slack{top:260px}#mail{top:310px}</style>
<a id=blank href="https://example.org/x" target="_blank">external, new tab</a>
<a id=samepage href="/other" target="_blank">this server, new tab</a>
<a id=file href="file:///etc/hostname">local file</a>
<a id=fileblank href="file:///etc/hostname" target="_blank">local file, new tab</a>
<a id=slack href="slack://open">slack</a>
<a id=mail href="mailto:ana@example.org">mail</a>
</body></html>"""


class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body=b"", ctype="application/json", headers=()):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/health":
            self.send(200, json.dumps({"service": "bakery-server", "compatibility": 1}).encode())
        elif path == "/v1/me":
            self.send(200, json.dumps({"displayName": "Lab", "email": "lab@example.test"}).encode())
        elif path == "/api/desktop/handoff":
            self.send(303, b"", headers=[("location", "/")])
        elif path in ("/", "/other"):
            self.send(200, PAGE, "text/html")
        else:
            self.send(404)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        self.rfile.read(length)
        if self.path.startswith("/v1/desktop-handoffs"):
            self.send(201, json.dumps({"code": "labcode", "expiresAt": "2030-01-01T00:00:00Z"}).encode())
        else:
            self.send(404)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
PORT = server.server_address[1]
ORIGIN = f"http://127.0.0.1:{PORT}"
threading.Thread(target=server.serve_forever, daemon=True).start()
subprocess.run(["secret-tool", "store", "--label=lab", "service", "bakery-desktop", "username", ORIGIN],
               input=b"bkd_lab", capture_output=True)

path = os.path.join(OUT, "lab")
os.makedirs(os.path.join(path, "cmd"), exist_ok=True)
os.makedirs(os.path.join(path, "config"), exist_ok=True)
env = dict(os.environ, BAKERY_SERVER=ORIGIN, BAKERY_DESKTOP_REPORT=os.path.join(path, "report.jsonl"),
           BAKERY_DESKTOP_COMMANDS=os.path.join(path, "cmd"), BAKERY_DESKTOP_CONFIG_DIR=os.path.join(path, "config"),
           BAKERY_DESKTOP_DIALOG_ANSWER=os.environ.get("LAB_ANSWER", "none"), TZ="UTC")
app = subprocess.Popen([BIN], env=env, stdout=open(os.path.join(path, "app.log"), "a"), stderr=subprocess.STDOUT)


def reports():
    p = os.path.join(path, "report.jsonl")
    out = []
    if os.path.exists(p):
        for line in open(p):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def count(event, **match):
    return sum(1 for e in reports() if e["event"] == event and all(e["data"].get(k) == v for k, v in match.items()))


def wait_until(condition, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.4)
    return False


def eval_js(script):
    tmp = os.path.join(path, "cmd", "tmp")
    open(tmp, "w").write(script)
    os.rename(tmp, os.path.join(path, "cmd", "eval-%d" % int(time.time() * 1000000)))



def x_click(x, y):
    import ctypes
    x11 = ctypes.CDLL("libX11.so.6")
    xtst = ctypes.CDLL("libXtst.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    display = x11.XOpenDisplay(os.environ.get("DISPLAY", ":99").encode())
    xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
    x11.XFlush(display)
    time.sleep(0.3)
    xtst.XTestFakeButtonEvent(display, 1, 1, 0)
    x11.XFlush(display)
    time.sleep(0.2)
    xtst.XTestFakeButtonEvent(display, 1, 0, 0)
    x11.XFlush(display)


results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


ok = wait_until(lambda: count("page_loaded", host="127.0.0.1", path="/") >= 1, 40)
check("the lab's page opens in the window", ok, str([e["event"] for e in reports()][-6:]))
if not ok:
    app.terminate()
    sys.exit(1)
time.sleep(2)


def try_it(name, script, expect, timeout=15):
    eval_js(script)
    got = wait_until(expect, timeout)
    check(name, got, str([(e["event"], e["data"]) for e in reports()][-4:]))
    time.sleep(1)


try_it("window.open to another site goes to the browser", "window.open('https://example.org/docs', '_blank')",
       lambda: count("link_to_browser") >= 1)
try_it("a link that asks for a new tab, another site, goes to the browser",
       "document.getElementById('blank').click()", lambda: count("link_to_browser") >= 2)
base = count("page_loaded", path="/other")
try_it("a link that asks for a new tab, this server, opens in this window",
       "document.getElementById('samepage').click()", lambda: count("page_loaded", path="/other") > base)
base = count("page_loaded", path="/other")
try_it("window.open to this server opens in this window", "window.open('/other?x=1', '_blank')",
       lambda: count("page_loaded", path="/other") > base)
try_it("a link to a local file is refused with a dialog", "document.getElementById('file').click()",
       lambda: count("system_dialog", kind="not_web") >= 1)
base = count("system_dialog", kind="not_web")
try_it("a local file link that asks for a new tab is refused with a dialog",
       "document.getElementById('fileblank').click()", lambda: count("system_dialog", kind="not_web") > base)
base = count("system_dialog", kind="not_web")
try_it("window.open to a local file is refused with a dialog", "window.open('file:///etc/hostname', '_blank')",
       lambda: count("system_dialog", kind="not_web") > base)
base = count("system_dialog", kind="not_web")
try_it("another app's link is refused with a dialog", "document.getElementById('slack').click()",
       lambda: count("system_dialog", kind="not_web") > base)
try_it("a mail link goes to the system", "document.getElementById('mail').click()",
       lambda: count("link_to_system") >= 1)

import shutil
shutil.copyfile("/tmp/xfb/Xvfb_screen0", os.path.join(OUT, "lab.xwd"))
subprocess.run(["python3", "/app/e2e/xwd2png.py", os.path.join(OUT, "lab.xwd"), os.path.join(OUT, "lab.png")], capture_output=True)

# The same links, pressed with a real pointer click: where the page's top is 25 below the window's menu bar.
def click_it(name, top, expect, timeout=15):
    x_click(40, 25 + top + 12)
    time.sleep(0.5)
    x_click(40, 25 + top + 12)
    got = wait_until(expect, timeout)
    check("[real click] " + name, got, str([(e["event"], e["data"]) for e in reports()][-4:]))
    time.sleep(1)


base = count("link_to_system")
click_it("a mail link, to prove clicks arrive", 310, lambda: count("link_to_system") > base)
base = count("link_to_browser")
click_it("a link that asks for a new tab, another site, goes to the browser", 60, lambda: count("link_to_browser") > base)
base = count("page_loaded", path="/other")
click_it("a link that asks for a new tab, this server, opens in this window", 110, lambda: count("page_loaded", path="/other") > base)
base = count("system_dialog", kind="not_web")
click_it("a link to a local file is refused with a dialog", 160, lambda: count("system_dialog", kind="not_web") > base)
base = count("system_dialog", kind="not_web")
click_it("a local file link that asks for a new tab is refused with a dialog", 210, lambda: count("system_dialog", kind="not_web") > base)
print(f"{sum(results)} of {len(results)} passed", flush=True)
app.terminate()
sys.exit(0 if all(results) else 1)
