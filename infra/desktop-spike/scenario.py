#!/usr/bin/env python3
"""Drives the spike app the way a person, the browser and the OS would (#77, slice 0).

Runs inside the container, against the real Bakery server on the host. Every check is
recorded in results.json with what was observed; nothing here is a mock of the server.
"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request, http.client

SERVER = os.environ["BAKERY_SERVER"]
EMAIL, PASSWORD = os.environ["SEED_EMAIL"], os.environ["SEED_PASSWORD"]
OUT = os.environ.get("OUT", "/out")
BIN = os.environ.get("SPIKE_BIN", "/cache/target/debug/bakery-desktop-spike")
results = []
app = None

def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": str(detail)[:300]})
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)

findings = []

def finding(name, detail):
    findings.append({"finding": name, "detail": str(detail)[:600]})
    print("FINDING " + name + "  [" + str(detail)[:300] + "]", flush=True)

def raw_http(request: bytes, timeout=10):
    """One raw HTTP/1.1 exchange with the real server: status line, headers, a body prefix."""
    import socket
    host, port = SERVER.split("//")[1].split(":")
    with socket.create_connection((host, int(port)), timeout=timeout) as sock:
        sock.sendall(request)
        data = b""
        sock.settimeout(3)
        try:
            while len(data) < 6000:
                chunk = sock.recv(2048)
                if not chunk: break
                data += chunk
        except Exception:
            pass
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.decode("latin1").split("\r\n")
    hdrs = {}
    for l in lines[1:]:
        if ":" in l:
            k, v = l.split(":", 1); hdrs[k.strip().lower()] = v.strip()
    return lines[0] if lines else "", hdrs, body[:300].decode("latin1", "replace")

def probe_server(credential):
    """What the real server answers to the two things the web view does that Rust does not."""
    host = SERVER.split("//")[1]
    import base64 as b64
    cors = raw_http((f"OPTIONS /v1/me HTTP/1.1\r\nHost: {host}\r\nOrigin: tauri://localhost\r\n"
                     "Access-Control-Request-Method: GET\r\nAccess-Control-Request-Headers: authorization\r\n"
                     "Connection: close\r\n\r\n").encode())
    allow = {k: v for k, v in cors[1].items() if k.startswith("access-control")}
    finding("CORS preflight from tauri://localhost for a bearer call", f"{cors[0]} allow-headers={allow or 'none'}")
    orgs = raw_http((f"GET /v1/organizations HTTP/1.1\r\nHost: {host}\r\nOrigin: tauri://localhost\r\n"
                     f"Authorization: Bearer {credential}\r\nConnection: close\r\n\r\n").encode())
    try:
        org = json.loads(orgs[2])["items"][0]["id"]
    except Exception:
        org = None
    finding("organizations listed with the bearer", f"{orgs[0]} first={'found' if org else 'none'}")
    for label, path in (("without an organization", "/v1/events"),
                        ("with ?organizationId=", f"/v1/events?organizationId={org}")):
        key = b64.b64encode(os.urandom(16)).decode()
        r = raw_http((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: tauri://localhost\r\n"
                      f"Sec-WebSocket-Protocol: bakery.desktop, bakery.credential.{credential}\r\n\r\n").encode())
        echoed = credential in (r[0] + json.dumps(r[1]) + r[2])
        finding(f"raw WebSocket handshake {label}",
                f"{r[0]} selected={r[1].get('sec-websocket-protocol')} credential-echoed={echoed} body={r[2][:160]!r}")
    return

def events(path):
    p = os.path.join(path, "report.jsonl")
    if not os.path.exists(p):
        return []
    out = []
    for l in open(p):
        try:
            out.append(json.loads(l))
        except ValueError:
            continue  # a line still being written; the next read has it whole
    return out

def wait_event(path, name, timeout=40, after=0, pred=None):
    end = time.time() + timeout
    while time.time() < end:
        for e in events(path):
            if e["event"] == name and e["t"] >= after and (pred is None or pred(e["data"])):
                return e
        time.sleep(0.3)
    return None

def start_app(path, extra=None):
    global app
    os.makedirs(path, exist_ok=True)
    env = dict(os.environ, SPIKE_OUT=path, BAKERY_SERVER=SERVER, **(extra or {}))
    app = subprocess.Popen([BIN], env=env, stdout=open(os.path.join(path, "app.log"), "a"),
                           stderr=subprocess.STDOUT)
    return app

def stop_app():
    global app
    if app and app.poll() is None:
        app.terminate()
        try: app.wait(10)
        except Exception: app.kill()
    app = None

def post(path, body, headers=None, form=False):
    data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
    h = {"content-type": "application/x-www-form-urlencoded" if form else "application/json",
         "origin": SERVER, **(headers or {})}
    req = urllib.request.Request(SERVER + path, data=data, headers=h, method="POST")
    try:
        r = urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), e.headers
    return r.status, r.read().decode(), r.headers

def browser_session():
    status, body, headers = post("/api/auth/sign-in/email", {"email": EMAIL, "password": PASSWORD})
    cookies = []
    for h in headers.get_all("set-cookie") or []:
        cookies.append(h.split(";")[0])
    return status, "; ".join(cookies)

def confirm(request_id, cookie, decision="continue"):
    """What the person does in the browser: open the page, press Continue."""
    page = urllib.request.Request(SERVER + "/api/desktop/sign-in?request=" + urllib.parse.quote(request_id),
                                  headers={"cookie": cookie})
    shown = urllib.request.urlopen(page).status
    status, html, _ = post("/api/desktop/sign-in", {"request": request_id, "decision": decision},
                           {"cookie": cookie}, form=True)
    m = re.search(r'href="((?:bakery://auth/callback|http://127\.0\.0\.1:\d+/callback)\?[^"]+)"', html)
    return shown, status, (m.group(1).replace("&amp;", "&") if m else None)

def deliver(link):
    """Hand the callback to the app the way the OS (or the browser) would."""
    if link.startswith("bakery://"):
        t = time.time_ns() // 1_000_000
        # No pipes: the app the OS launches inherits them and would keep this call waiting.
        err = open(OUT + "/gio.err", "a")
        r = subprocess.run(["gio", "open", link], stdout=subprocess.DEVNULL, stderr=err, timeout=30,
                           env=dict(os.environ, SPIKE_OUT=OUT + "/os-launched", BAKERY_SERVER=SERVER))
        return {"via": "gio open", "exit": r.returncode, "t": t}
    urllib.request.urlopen(link, timeout=10).read()
    return {"via": "http loopback"}

def secret_prefix():
    r = subprocess.run(["secret-tool", "lookup", "service", "com.bakery.desktop.spike", "username", SERVER],
                       capture_output=True, text=True)
    return r.returncode, r.stdout.strip()

def sign_in_flow(path, mode):
    t0 = time.time_ns() // 1_000_000
    extra = {"SPIKE_REDIRECT": mode}
    start_app(path, extra)
    check(f"[{mode}] the web view loads and the app starts",
          wait_event(path, "web:webview_loaded", 40) is not None)
    started = wait_event(path, "sign_in_started", 40)
    check(f"[{mode}] the app opens a PKCE sign-in request", started is not None,
          started and f"redirect={started['data']['redirect']} challenge={started['data']['challengeLength']} chars")
    if not started:
        return None
    check(f"[{mode}] the app asked the OS to open the system browser",
          wait_event(path, "browser_open_called", 10) is not None,
          (wait_event(path, "browser_open_called", 1) or {}).get("data"))
    status, cookie = browser_session()
    check(f"[{mode}] the person signs in on the web", status == 200 and cookie != "", f"status {status}")
    shown, answered, link = confirm(started["data"]["id"], cookie)
    check(f"[{mode}] the browser confirmation page shows and Continue is accepted",
          shown == 200 and answered == 200 and link is not None, f"page {shown}, answer {answered}")
    if not link:
        return None
    check(f"[{mode}] the done page links back to the app on the redirect it was opened with",
          link.startswith("bakery://auth/callback?code=") if mode == "applink"
          else link.startswith("http://127.0.0.1:") and "/callback?code=" in link,
          link.split("?")[0])
    return started, link

def main():
    os.makedirs(OUT, exist_ok=True)
    # ---------- A: app-link sign-in, cold ----------
    A = OUT + "/a"
    got = sign_in_flow(A, "applink")
    if got:
        started, link = got
        d = deliver(link)
        check("[applink] the OS delivers bakery:// to the registered handler (gio open)",
              d.get("exit") == 0, d)
        second = wait_event(A, "second_instance", 15)
        if second is None:
            # No desktop environment may have routed it: launch the app with the URL, which is
            # what a desktop file's Exec=... %u does.
            subprocess.Popen([BIN, link], env=dict(os.environ, SPIKE_OUT=A, BAKERY_SERVER=SERVER),
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            second = wait_event(A, "second_instance", 15)
        check("[applink] a second launch is forwarded to the running instance (single instance)",
              second is not None, "via gio open" if d.get("exit") == 0 and second else "via direct exec")
        check("[applink] the code is exchanged with the PKCE verifier", wait_event(A, "exchanged", 20) is not None,
              (wait_event(A, "exchanged", 1) or {}).get("data"))
        check("[applink] the credential is stored in the OS secret store",
              wait_event(A, "credential_stored", 20) is not None)
        rc, secret = secret_prefix()
        check("[applink] the secret store really holds a bkd_ credential (read with secret-tool)",
              rc == 0 and secret.startswith("bkd_"), f"exit {rc}, prefix {secret[:4]}")
        rc0, cred0 = secret_prefix()
        if rc0 == 0 and cred0:
            probe_server(cred0)
        check("[applink] the bearer credential is accepted by the server (/v1/me)",
              wait_event(A, "bearer_ok", 20) is not None)
        fm = wait_event(A, "web:fetch_me", 25)
        check("[applink] the web view can call the server with the bearer from its own origin (CORS)",
              fm is not None and fm["data"].get("status") == 200,
              fm and fm["data"])
        op = wait_event(A, "web:socket_open", 25)
        check("[applink] the web view opens the live socket and the server selects the bakery.desktop subprotocol",
              op is not None and op["data"].get("protocol") == "bakery.desktop", op and op["data"])
        msg = wait_event(A, "web:socket_message", 25)
        check("[applink] the socket delivers events to the web view", msg is not None, msg and msg["data"])
        # replay: the same link again
        t = time.time_ns() // 1_000_000
        deliver(link)
        rej = wait_event(A, "callback_rejected", 20, after=t)
        check("[applink] a replayed callback is rejected by the app (nothing pending)", rej is not None,
              rej and rej["data"])
        # credential hygiene
        rc, cred = secret_prefix()
        leaks = []
        if rc == 0 and cred:
            for root in (OUT, os.path.expanduser("~")):
                r = subprocess.run(["grep", "-rIl", "--", cred, root], capture_output=True, text=True)
                leaks += [l for l in r.stdout.splitlines() if "/.local/share/keyrings" not in l]
            ps = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout
            if cred in ps: leaks.append("process arguments")
        check("[hygiene] the credential appears in no report, log, file or process argument",
              not leaks, leaks)
        loaded = wait_event(A, "web:webview_loaded", 1)
        if loaded:
            check("[webview] engine and origin recorded", True,
                  f"{loaded['data']['userAgent'][-80:]} | origin {loaded['data']['origin']}")
        # ---------- B: restart restores the sign-in ----------
        stop_app()
        B = OUT + "/b"
        start_app(B, {"SPIKE_AUTOSTART": "0"})
        check("[restart] a later launch restores the credential from the secret store",
              wait_event(B, "credential_restored", 30) is not None)
        check("[restart] and goes live without a new sign-in",
              wait_event(B, "web:socket_open", 30) is not None
              and wait_event(B, "sign_in_started", 1) is None)
        # ---------- C: the server goes away and comes back ----------
        flag = OUT + "/flag-restart"
        open(flag, "w").write("1")
        closed = wait_event(B, "web:socket_close", 40)
        check("[reconnect] the socket closes when the server stops", closed is not None,
              closed and closed["data"])
        deadline = time.time() + 120
        while time.time() < deadline and not os.path.exists(OUT + "/flag-restarted"):
            time.sleep(1)
        reopened = wait_event(B, "web:socket_open", 60, after=closed["t"] if closed else 0)
        check("[reconnect] the web view reconnects by itself, with the same credential, after the server returns",
              reopened is not None, reopened and reopened["data"])
        # ---------- D: a revoked sign-in is told apart from an unreachable server ----------
        stop_app()
        rc, cred = secret_prefix()
        status, cookie = browser_session()
        # (revoke: sign the browser person out of every session the app holds is server work;
        # here the stored value is made invalid to see how the app tells 'ended' from 'unreachable')
        subprocess.run(["secret-tool", "store", "--label=spike", "service", "com.bakery.desktop.spike",
                        "username", SERVER], input="bkd_" + "x" * 43, text=True)
        D = OUT + "/d"
        start_app(D, {"SPIKE_AUTOSTART": "0"})
        rj = wait_event(D, "bearer_rejected", 30)
        check("[ended] a refused stored credential is told apart from an unreachable server and is removed",
              rj is not None and wait_event(D, "web:socket_open", 3) is None, rj and rj["data"])
        stop_app()
    # ---------- E: loopback redirect ----------
    subprocess.run(["secret-tool", "clear", "service", "com.bakery.desktop.spike"], capture_output=True)
    E = OUT + "/e"
    got = sign_in_flow(E, "loopback")
    if got:
        started, link = got
        d = deliver(link)
        check("[loopback] the browser's redirect reaches the app's one-shot listener", d.get("via") == "http loopback")
        check("[loopback] the code is exchanged and the credential stored",
              wait_event(E, "credential_stored", 25) is not None)
        op = wait_event(E, "web:socket_open", 30)
        check("[loopback] the live socket opens with the subprotocol",
              op is not None and op["data"].get("protocol") == "bakery.desktop", op and op["data"])
    stop_app()
    json.dump({"results": results, "findings": findings}, open(OUT + "/results.json", "w"), indent=2)
    failed = [r for r in results if not r["ok"]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    try:
        main()
    finally:
        stop_app()
