#!/usr/bin/env python3
"""DEBUG ONLY: the app's OS plumbing against a stub server, with no database.

This is not evidence about Bakery: it exists to iterate quickly on the deep link,
single-instance forwarding and the secret store. The proof is `scenario.py` against the
real server. The stub answers just enough of the sign-in contract for the app to run.
"""
import json, os, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = os.environ.get("OUT", "/out")
BIN = os.environ.get("SPIKE_BIN", "/cache/target/debug/bakery-desktop-spike")
CRED = "bkd_" + "A" * 43
PORT = 18787
SERVER = f"http://127.0.0.1:{PORT}"

class Stub(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); self.rfile.read(n)
        if self.path == "/v1/desktop-sign-ins":
            self.send(201, {"id": "11111111-1111-4111-8111-111111111111",
                            "confirmUrl": f"{SERVER}/api/desktop/sign-in?request=1", "expiresAt": "x"})
        elif self.path.endswith("/credential"):
            self.send(201, {"credential": CRED, "sessionId": "s", "expiresAt": "x"})
        else: self.send(404, {})
    def do_GET(self):
        ok = self.headers.get("authorization") == "Bearer " + CRED
        self.send(200 if ok else 401, {"email": "stub@example.test"} if ok else {"code": "AUTH"})

def events(path):
    p = os.path.join(path, "report.jsonl")
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []

def wait(path, name, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        for e in events(path):
            if e["event"] == name: return e
        time.sleep(0.3)

def main():
    threading.Thread(target=HTTPServer(("127.0.0.1", PORT), Stub).serve_forever, daemon=True).start()
    os.makedirs(OUT, exist_ok=True)
    env = dict(os.environ, SPIKE_OUT=OUT, BAKERY_SERVER=SERVER)
    app = subprocess.Popen([BIN], env=env, stdout=open(OUT + "/app.log", "w"), stderr=subprocess.STDOUT)
    ok = True
    def check(name, cond, detail=""):
        nonlocal ok; ok &= bool(cond)
        print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)
    check("app starts and registers the bakery:// handler",
          (wait(OUT, "deep_link_registered") or {}).get("data", {}).get("ok"), (wait(OUT, "deep_link_registered") or {}).get("data"))
    check("sign-in request opened", wait(OUT, "sign_in_started") is not None)
    mime = subprocess.run(["xdg-mime", "query", "default", "x-scheme-handler/bakery"], capture_output=True, text=True).stdout.strip()
    check("the OS lists a default handler for bakery://", mime != "", mime)
    link = "bakery://auth/callback?code=" + "B" * 43 + "&request=11111111-1111-4111-8111-111111111111"
    r = subprocess.run(["gio", "open", link], stdout=subprocess.DEVNULL, stderr=open(OUT + "/gio.err", "w"), timeout=30)
    check("gio open delivers the link to the registered handler", r.returncode == 0, f"exit {r.returncode}")
    second = wait(OUT, "second_instance", 15)
    check("the second launch is forwarded to the running instance", second is not None)
    check("code exchanged", wait(OUT, "exchanged", 15) is not None)
    check("credential stored in the OS secret store", wait(OUT, "credential_stored", 15) is not None,
          (wait(OUT, "credential_store_failed", 1) or {}).get("data"))
    look = subprocess.run(["secret-tool", "lookup", "service", "com.bakery.desktop.spike", "username", SERVER],
                          capture_output=True, text=True)
    check("secret-tool reads the credential back", look.returncode == 0 and look.stdout.startswith("bkd_"), f"exit {look.returncode}")
    check("bearer accepted", wait(OUT, "bearer_ok", 15) is not None)
    app.terminate()
    sys.exit(0 if ok else 1)

main()
