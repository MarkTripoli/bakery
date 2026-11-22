#!/usr/bin/env python3
"""DEBUG ONLY: the app's OS plumbing against a stub server, with no database.

This is not evidence about Bakery: it exists to iterate quickly on the deep link,
single-instance forwarding and the secret store. The proof is `scenario.py` against the
real server. The stub answers just enough of the sign-in contract for the app to run.
"""
import base64, hashlib, json, os, struct, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = os.environ.get("OUT", "/out")
BIN = os.environ.get("SPIKE_BIN", "/cache/target/debug/bakery-desktop-spike")
CRED = "bkd_" + "A" * 43
PORT = 18787
SERVER = f"http://127.0.0.1:{PORT}"

ws_log = []

class Stub(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # an upgrade needs an HTTP/1.1 status line
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
    def do_OPTIONS(self):
        # A browser preflight for a cross-origin call that carries an Authorization header.
        self.send_response(204)
        if os.environ.get("STUB_CORS") == "1":
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-headers", "authorization, content-type")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("content-length", "0"); self.end_headers()
    def do_GET(self):
        if self.path == "/v1/events" and self.headers.get("upgrade", "").lower() == "websocket":
            return self.websocket()
        ok = self.headers.get("authorization") == "Bearer " + CRED
        self.send(200 if ok else 401, {"email": "stub@example.test"} if ok else {"code": "AUTH"})
    def websocket(self):
        offered = [p.strip() for p in self.headers.get("sec-websocket-protocol", "").split(",")]
        key = self.headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        ws_log.append({"origin": self.headers.get("origin"), "offered": [o[:18] for o in offered]})
        if "bakery.desktop" not in offered:
            self.send_response(400); self.end_headers(); return
        self.send_response(101, "Switching Protocols")
        self.send_header("upgrade", "websocket"); self.send_header("connection", "Upgrade")
        self.send_header("sec-websocket-accept", accept)
        self.send_header("sec-websocket-protocol", "bakery.desktop")  # the credential is never echoed
        self.end_headers()
        payload = json.dumps({"type": "stub.hello"}).encode()
        self.wfile.write(bytes([0x81, len(payload)]) + payload); self.wfile.flush()
        if len(ws_log) == 1:
            # The first connection is dropped by the server, as a restart would: the web view
            # must come back by itself.
            time.sleep(1)
            self.wfile.write(bytes([0x88, 2]) + struct.pack(">H", 1001)); self.wfile.flush()
            return
        try:
            while self.connection.recv(1024): pass
        except Exception:
            pass
    def end_headers(self):
        if os.environ.get("STUB_CORS") == "1" and self.command != "OPTIONS":
            self.send_header("access-control-allow-origin", "*")
        super().end_headers()

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
    threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", PORT), Stub).serve_forever, daemon=True).start()
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
    check("bearer accepted (Rust)", wait(OUT, "bearer_ok", 15) is not None)
    fm = wait(OUT, "web:fetch_me", 15)
    check("web view fetch from tauri://localhost" + (" (stub sends CORS)" if os.environ.get("STUB_CORS") == "1" else " (stub sends no CORS)"),
          fm is not None and fm["data"].get("status") == 200, fm and fm["data"])
    op = wait(OUT, "web:socket_open", 15)
    check("web view WebSocket with subprotocols opens and the stub's subprotocol is selected",
          op is not None and op["data"].get("protocol") == "bakery.desktop", (op or {}).get("data") or (wait(OUT, "web:socket_close", 1) or {}).get("data"))
    check("the web view receives a frame", wait(OUT, "web:socket_message", 10) is not None)
    closed = wait(OUT, "web:socket_close", 15)
    check("the server drops the socket and the web view sees it close", closed is not None,
          closed and closed["data"])
    end = time.time() + 30; second = None
    while time.time() < end and second is None:
        for e in events(OUT):
            if e["event"] == "web:socket_open" and e["data"].get("attempt", 1) >= 2: second = e
        time.sleep(0.5)
    check("the web view reconnects by itself and the subprotocol is selected again",
          second is not None and second["data"].get("protocol") == "bakery.desktop", second and second["data"])
    print("stub saw websocket handshakes:", json.dumps(ws_log)[:300], flush=True)
    app.terminate()
    sys.exit(0 if ok else 1)

main()
