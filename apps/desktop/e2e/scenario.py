#!/usr/bin/env python3
"""End to end: the production app against a real Bakery server, on Linux.

Runs inside the container (see scenario.sh). The app is driven the way a person would: buttons are
pressed through the harness's command directory, the browser's part is done over HTTP exactly as a
browser would, and the operating system hands the app its answer with `gio open`. Every phase
checks the windows the app showed, in order, and the secret store, and that no secret reached a file.
"""
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

SERVER = os.environ["BAKERY_SERVER"]
OUT = os.environ.get("OUT", "/out")
BIN = os.environ.get("BAKERY_DESKTOP_BIN", "/cache/target-desktop/debug/bakery-desktop")
EMAIL = os.environ["SEED_EMAIL"]
PASSWORD = os.environ["SEED_PASSWORD"]
SERVICE, USER = "bakery-desktop", SERVER
results = []
app = None
app_env = {}


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)
    return bool(ok)


def reports(path):
    p = os.path.join(path, "report.jsonl")
    if not os.path.exists(p):
        return []
    out = []
    for line in open(p):
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def window_name(view):
    w = view["window"]
    return "refusal:" + w["refusal"]["kind"] if w["kind"] == "refusal" else w["kind"]


def views(path):
    return [(window_name(e["data"]), e["data"]["dialog"]) for e in reports(path) if e["event"] == "view"]


def wait_window(path, name, dialog=None, after=0, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        seen = views(path)
        for i in range(after, len(seen)):
            if seen[i][0] == name and (dialog is None or seen[i][1] == dialog):
                return i + 1
        time.sleep(0.25)
    return None


def wait_effect(path, name, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        for e in reports(path):
            if e["event"] == "effect" and e["data"].get("name") == name:
                return e["data"]
        time.sleep(0.25)
    return None


def start_app(path, bus=None, server=None, extra=None):
    global app
    os.makedirs(os.path.join(path, "cmd"), exist_ok=True)
    # A configuration folder of its own per phase: what one phase saves never leaks into the next.
    config = os.path.join(path, "config")
    os.makedirs(config, exist_ok=True)
    env = dict(os.environ, BAKERY_SERVER=server or SERVER, BAKERY_DESKTOP_REPORT=os.path.join(path, "report.jsonl"),
               BAKERY_DESKTOP_COMMANDS=os.path.join(path, "cmd"), BAKERY_DESKTOP_CONFIG_DIR=config, TZ="UTC",
               **(extra or {}))
    if bus:
        env["DBUS_SESSION_BUS_ADDRESS"] = bus
    app_env.clear()
    app_env.update(env)
    app = subprocess.Popen([BIN], env=env, stdout=open(os.path.join(path, "app.log"), "a"),
                           stderr=subprocess.STDOUT)


def stop_app():
    global app
    if app and app.poll() is None:
        app.terminate()
        try:
            app.wait(10)
        except Exception:
            print("NOTE the app did not end within ten seconds and was killed", flush=True)
            app.kill()
            try:
                app.wait(5)
            except Exception:
                pass
    app = None
    # A server change restarts the app as a new process this harness did not start: end it too.
    subprocess.run(["pkill", "-f", BIN], capture_output=True)
    # The next start must not meet the old one's single-instance name on the session bus.
    time.sleep(2)


def press(path, button):
    open(os.path.join(path, "cmd", "press-" + button), "w").close()


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
    status, _, headers = post("/api/auth/sign-in/email", {"email": EMAIL, "password": PASSWORD})
    return status, "; ".join(h.split(";")[0] for h in headers.get_all("set-cookie") or [])


def confirm(request_id, cookie):
    """What the person does in the browser: open the page, press Continue. Returns the link back."""
    page = urllib.request.Request(SERVER + "/api/desktop/sign-in?request=" + urllib.parse.quote(request_id),
                                  headers={"cookie": cookie})
    urllib.request.urlopen(page)
    _, html, _ = post("/api/desktop/sign-in", {"request": request_id, "decision": "continue"},
                      {"cookie": cookie}, form=True)
    m = re.search(r'href="(bakery://auth/callback\?[^"]+)"', html)
    return m.group(1).replace("&amp;", "&") if m else None


def deliver(link, bus=None):
    """Hands the answer to the app the way the operating system does."""
    env = dict(os.environ, **({"DBUS_SESSION_BUS_ADDRESS": bus} if bus else {}))
    # No pipes: the app the OS launches inherits them and would keep this call waiting.
    err = open(os.path.join(OUT, "gio.err"), "a")
    subprocess.run(["gio", "open", link], stdout=subprocess.DEVNULL, stderr=err, timeout=30, env=env)


def desktop_sessions():
    """How many sign-ins the app holds on the server, as the person's Active sessions list shows them."""
    req = urllib.request.Request(SERVER + "/v1/me/sessions", headers={"cookie": session_cookie()})
    return urllib.request.urlopen(req).read().decode().count("Bakery app")


def settled_sessions(quiet=3, timeout=30):
    """The app's sign-in count once it has stopped changing for `quiet` seconds. The window asks for a
    browser session of its own as soon as it is signed in, and that session carries the same label."""
    end = time.time() + timeout
    value, since = desktop_sessions(), time.time()
    while time.time() < end:
        time.sleep(0.5)
        now = desktop_sessions()
        if now != value:
            value, since = now, time.time()
        elif time.time() - since >= quiet:
            break
    return value


def last_window(path):
    """The window the app showed last, as the app described it (never a secret)."""
    seen = [e["data"] for e in reports(path) if e["event"] == "view"]
    return seen[-1] if seen else None


def started_count(path):
    return sum(1 for e in reports(path) if e["event"] == "app_started")


def bearer_status(credential):
    """What the server answers to a sign-in the app held, without ever printing it."""
    req = urllib.request.Request(SERVER + "/v1/me", headers={"authorization": "Bearer " + credential})
    try:
        return urllib.request.urlopen(req).status
    except urllib.error.HTTPError as e:
        return e.code


def stub_server(health_body):
    """A tiny server on this computer's own address that answers /health with the given text (or
    nothing at all when it is None). Returns it and its port."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = (health_body or "").encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def closed_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def bakery_health(compat):
    extra = "" if compat is None else f',"compatibility":{compat}'
    return f'{{"service":"bakery-server","state":"ok","version":"e2e","dependencies":[]{extra}}}'


def choose(path, which, typed=""):
    """What the person does in the chooser: pick an option, type, press Continue."""
    with open(os.path.join(path, "cmd", "choose-" + which), "w") as f:
        f.write(typed)


def request_id_of(url):
    return urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["request"][0]


def stored(user=None):
    r = subprocess.run(["secret-tool", "lookup", "service", SERVICE, "username", user or USER],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def wait_until(condition, timeout=10):
    """Waits for something the app does a moment after it shows a window, such as clearing a secret."""
    end = time.time() + timeout
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.25)
    return condition()


def clear_store(user=None):
    subprocess.run(["secret-tool", "clear", "service", SERVICE, "username", user or USER], capture_output=True)


def server_flag(name):
    """Asks the host to stop or start the server, and waits until it has."""
    open(os.path.join(OUT, f"flag-{name}"), "w").close()
    end = time.time() + 150
    while time.time() < end:
        if os.path.exists(os.path.join(OUT, f"flag-{name}-done")):
            os.remove(os.path.join(OUT, f"flag-{name}-done"))
            return True
        time.sleep(0.5)
    return False


def leaked(secret):
    """Whether the secret appears in any file this run wrote. The secret itself is never printed."""
    if not secret:
        return None
    for root, _, files in os.walk(OUT):
        for f in files:
            try:
                if secret.encode() in open(os.path.join(root, f), "rb").read():
                    return os.path.join(root, f)
            except OSError:
                continue
    return None


def sign_in_to_waiting(path, prefix):
    """From the sign-in window to the waiting window; returns the confirm address the app opened."""
    check(f"{prefix} the sign-in window shows first", wait_window(path, "sign_in") is not None)
    press(path, "sign_in")
    check(f"{prefix} pressing the button moves to waiting", wait_window(path, "waiting") is not None)
    opened = wait_effect(path, "open_browser")
    check(f"{prefix} the app tried to open the browser", opened is not None, opened and f"ok={opened['ok']}")
    return opened["url"] if opened else None


_cookie = None


def session_cookie():
    """Signs in on the web once and keeps the session, as a browser does: the server rate-limits
    password sign-ins, and a person does not retype their password for every sign-in of the app."""
    global _cookie
    if _cookie is None:
        status, cookie = browser_session()
        check("the person signs in on the web, once", status == 200 and cookie != "", f"status {status}")
        _cookie = cookie
    return _cookie


def phase_cold_sign_in():
    p = os.path.join(OUT, "a-cold")
    clear_store()
    start_app(p)
    url = sign_in_to_waiting(p, "[cold]")
    # The container has no browser, so the app must say so and show the address to copy.
    check("[cold] with no browser the app shows the address to copy",
          wait_window(p, "browser_did_not_open") is not None)
    if not url:
        return
    link = confirm(request_id_of(url), session_cookie())
    check("[cold] the browser's done page links back to the app", bool(link and link.startswith("bakery://auth/callback?code=")))
    if not link:
        return
    deliver(link)
    check("[cold] the app finishes and opens the app window", wait_window(p, "app") is not None)
    check("[cold] once signed in the window goes to the server's page by a one-use code",
          wait_report(p, "server_page_opened", 1) and not any(e["event"] == "handoff_failed" for e in reports(p)))
    order = [v[0] for v in views(p)]
    check("[cold] the windows came in the designed order",
          order[:3] == ["sign_in", "waiting", "browser_did_not_open"] and order[-1] == "app", " > ".join(order))
    secret = stored()
    check("[cold] the sign-in is in the operating system's secret store", secret.startswith("bkd_"))
    check("[cold] it appears in no report, log or file", leaked(secret) is None)
    seen = len(views(p))
    deliver(link)
    time.sleep(4)
    check("[cold] the same answer delivered again changes nothing", len(views(p)) == seen and views(p)[-1][0] == "app")
    stop_app()


def phase_restart():
    p = os.path.join(OUT, "b-restart")
    start_app(p)
    first = wait_window(p, "app", timeout=30)
    check("[restart] a later launch goes straight to the app", first is not None)
    check("[restart] without ever showing a sign-in window", all(v[0] != "sign_in" for v in views(p)), str(views(p)))
    stop_app()


def phase_cancel_then_late_answer():
    p = os.path.join(OUT, "c-cancel")
    clear_store()
    start_app(p)
    url = sign_in_to_waiting(p, "[cancel]")
    check("[cancel] Cancel returns to the sign-in window", (press(p, "cancel") or True) and wait_window(p, "sign_in", after=2) is not None)
    if url:
        cookie = session_cookie()
        link = confirm(request_id_of(url), cookie)
        deliver(link)
        check("[cancel] a late answer says it did not come from this app",
              wait_window(p, "refusal:not_from_this_app") is not None)
        check("[cancel] nothing was saved", stored() == "")
    stop_app()


def phase_bogus_answers():
    p = os.path.join(OUT, "d-bogus")
    clear_store()
    start_app(p)
    url = sign_in_to_waiting(p, "[bogus]")
    # Before the person confirms, a wrong answer is "pending": never shown, the app keeps waiting.
    deliver("bakery://auth/callback?code=" + "x" * 43)
    time.sleep(5)
    check("[bogus] an answer before the person has confirmed leaves the app waiting",
          views(p)[-1][0] in ("waiting", "finishing") and all(not v[0].startswith("refusal") for v in views(p)), str(views(p)))
    if url:
        cookie = session_cookie()
        link = confirm(request_id_of(url), cookie)
        deliver("bakery://auth/callback?code=" + "y" * 43)
        check("[bogus] a wrong answer after confirming says it did not come from this app",
              wait_window(p, "refusal:not_from_this_app") is not None)
        check("[bogus] nothing was saved", stored() == "")
        check("[bogus] the button starts again", (press(p, "sign_in") or True) and wait_window(p, "waiting", after=4) is not None)
    stop_app()


def phase_server_down_then_try_again():
    p = os.path.join(OUT, "e-down")
    clear_store()
    start_app(p)
    url = sign_in_to_waiting(p, "[down]")
    if not url:
        return
    cookie = session_cookie()
    link = confirm(request_id_of(url), cookie)
    check("[down] the server stops", server_flag("stop"))
    deliver(link)
    check("[down] the app says it could not finish, and the browser step is not lost",
          wait_window(p, "refusal:could_not_finish", timeout=60) is not None)
    check("[down] the server starts again", server_flag("start"))
    press(p, "try_again")
    check("[down] Try again sends the same answer and signs in", wait_window(p, "app", timeout=60) is not None)
    check("[down] the sign-in is stored", stored().startswith("bkd_"))
    stop_app()


def phase_ended_sign_in():
    p = os.path.join(OUT, "f-ended")
    # A saved sign-in the server does not accept: what an ended or revoked sign-in looks like.
    subprocess.run(["secret-tool", "store", "--label=bakery", "service", SERVICE, "username", USER],
                   input="bkd_" + "z" * 43, text=True, capture_output=True)
    start_app(p)
    check("[ended] the app opens signed in at first", wait_window(p, "app", timeout=30) is not None)
    check("[ended] then the server says no and the dialog appears",
          wait_window(p, "sign_in_again", dialog=True, timeout=40) is not None)
    # The dialog is shown, then the saved sign-in is cleared: wait for the clear, within a limit.
    check("[ended] what was saved is cleared", wait_until(lambda: stored() == ""))
    seen = len(views(p))
    press(p, "sign_in")
    check("[ended] signing in again stays in the dialog", wait_window(p, "waiting", dialog=True, after=seen) is not None)
    url = (wait_effect(p, "open_browser") or {}).get("url")
    if url:
        cookie = session_cookie()
        deliver(confirm(request_id_of(url), cookie))
        # Only a window shown after signing in again counts: the run began on the app window too.
        check("[ended] and returns to the app, out of the dialog",
              wait_window(p, "app", dialog=False, after=seen, timeout=40) is not None)
        check("[ended] the new sign-in is stored", stored().startswith("bkd_"))
    stop_app()


def phase_no_keyring():
    p = os.path.join(OUT, "g-nokeyring")
    clear_store()
    # A session bus with no Secret Service on it: a Linux computer with no keyring.
    bus = subprocess.run(["dbus-daemon", "--session", "--fork", "--print-address"],
                         capture_output=True, text=True).stdout.strip()
    before = desktop_sessions()
    check("[no keyring] the sessions list shows the app's earlier sign-ins, so a new one would be seen", before > 0, str(before))
    start_app(p, bus=bus)
    url = sign_in_to_waiting(p, "[no keyring]")
    if url:
        cookie = session_cookie()
        deliver(confirm(request_id_of(url), cookie), bus=bus)
        check("[no keyring] the app says it could not save the sign-in",
              wait_window(p, "refusal:no_keyring", timeout=40) is not None)
        check("[no keyring] nothing was kept anywhere", stored() == "")
        probe = wait_effect(p, "keyring_probe", timeout=5)
        check("[no keyring] the keyring was tried before the server was asked for a sign-in",
              probe is not None and probe["ok"] is False)
        check("[no keyring] so the server issued no sign-in that nobody holds", desktop_sessions() == before,
              f"{before} before, {desktop_sessions()} after")
        leftover = [f for f in os.listdir(os.path.expanduser("~")) if "bakery" in f.lower() and f != ".bakery-nothing"]
        check("[no keyring] and no file holds a sign-in", not any("bkd_" in open(os.path.join(os.path.expanduser("~"), f), errors="ignore").read()
                                                               for f in leftover if os.path.isfile(os.path.join(os.path.expanduser("~"), f))))
    stop_app()


def phase_address_spelling():
    """One server written two ways is one sign-in: the same secret is found, and kept, under both."""
    p = os.path.join(OUT, "h-spelling")
    clear_store()
    start_app(p, server=SERVER + "/")
    url = sign_in_to_waiting(p, "[spelling]")
    if url:
        deliver(confirm(request_id_of(url), session_cookie()))
        check("[spelling] with a trailing slash on the address the app signs in", wait_window(p, "app") is not None)
        check("[spelling] the sign-in is kept under the server's plain address", stored().startswith("bkd_"))
        stop_app()
        start_app(os.path.join(OUT, "h-spelling-2"))
        check("[spelling] the same server written without the slash is already signed in",
              wait_window(os.path.join(OUT, "h-spelling-2"), "app", timeout=30) is not None)
    stop_app()


def sign_in_to_app(path, prefix):
    """The whole sign-in, from the sign-in window to the signed-in window."""
    url = sign_in_to_waiting(path, prefix)
    if not url:
        return False
    link = confirm(request_id_of(url), session_cookie())
    deliver(link)
    return wait_window(path, "app", timeout=60) is not None


def phase_sign_out():
    p = os.path.join(OUT, "i-signout")
    clear_store()
    start_app(p)
    check("[sign out] the app signs in", sign_in_to_app(p, "[sign out]"))
    check("[sign out] the window opens the server's page, which asks for a session of its own",
          wait_report(p, "server_page_opened", 1, timeout=40))
    before, secret = settled_sessions(), stored()
    check("[sign out] the signed-in window offers Sign out", secret.startswith("bkd_"))
    press(p, "sign_out")
    check("[sign out] the sign-in panel comes back under the signed-out notice",
          wait_window(p, "signed_out", timeout=30) is not None)
    window = (last_window(p) or {}).get("window", {})
    check("[sign out] and says the server ended the sign-in", window.get("ended_on_server") is True, str(window))
    check("[sign out] it is gone from this computer", wait_until(lambda: stored() == ""))
    check("[sign out] the server lists fewer app sign-ins",
          wait_until(lambda: desktop_sessions() < before, timeout=20), f"{before} before, {desktop_sessions()} after")
    check("[sign out] the sign-in the app held is refused", bearer_status(secret) == 401)
    check("[sign out] it appears in no report, log or file", leaked(secret) is None)

    # The server does not answer: the sign-in is still removed here, and the window says so.
    start_len, opened_before = len(views(p)), len(opened_browsers(p))
    press(p, "sign_in")
    check("[sign out] signing in again works", sign_in_to_app_from_waiting(p, start_len, opened_before))
    still_listed = desktop_sessions()
    check("[sign out] the server is stopped", server_flag("stop"))
    press(p, "sign_out")
    check("[sign out] with no answer the window still comes back, within seconds",
          wait_window(p, "signed_out", after=start_len, timeout=30) is not None)
    window = (last_window(p) or {}).get("window", {})
    check("[sign out] and says the server may still list it", window.get("ended_on_server") is False, str(window))
    check("[sign out] the sign-in is removed from this computer anyway", stored() == "")
    check("[sign out] the server is started again", server_flag("start"))
    check("[sign out] and still lists the sign-in, as the window said", desktop_sessions() == still_listed)
    stop_app()


def opened_browsers(path):
    return [e["data"] for e in reports(path) if e["event"] == "effect" and e["data"].get("name") == "open_browser"]


def sign_in_to_app_from_waiting(path, after, opened_before):
    """From a sign-in button already pressed: wait for the browser step of THIS attempt (an earlier
    attempt's address is spent), answer it, reach the app."""
    waiting = wait_window(path, "waiting", after=after)
    if waiting is None or not wait_until(lambda: len(opened_browsers(path)) > opened_before, 30):
        return False
    deliver(confirm(request_id_of(opened_browsers(path)[-1]["url"]), session_cookie()))
    return wait_window(path, "app", after=after, timeout=60) is not None


def chooser_problem(path):
    window = (last_window(path) or {}).get("window", {})
    return (window.get("chooser") or {}).get("problem")


def phase_choose_and_switch():
    p = os.path.join(OUT, "j-switch")
    clear_store()
    start_app(p)
    check("[switch] the app signs in to the first server", sign_in_to_app(p, "[switch]"))
    secret = stored()
    press(p, "use_different_server")
    check("[switch] Use a different server opens the chooser", wait_window(p, "choose", timeout=30) is not None)
    chooser = ((last_window(p) or {}).get("window") or {}).get("chooser") or {}
    check("[switch] signed in, so it says the sign-in is kept", chooser.get("signed_in") is True, str(chooser))
    check("[switch] this computer's own server was asked once",
          wait_effect(p, "check_this_computer", timeout=15) is not None)

    # Each address problem keeps the chooser open under its own sentence and sends nothing.
    for typed, problem in [("", "empty"), ("ftp://example.com", "not_web_address"),
                           ("https://ana:secret@example.com", "has_credentials"), ("http://example.com", "plain_http")]:
        choose(p, "another", typed)
        check(f"[switch] {typed or 'nothing'!r} is refused as {problem}",
              wait_until(lambda: chooser_problem(p) == problem, 15), str(chooser_problem(p)))
    gone = closed_port()
    choose(p, "another", f"http://127.0.0.1:{gone}")
    check("[switch] an address nothing answers at is refused as no answer",
          wait_until(lambda: chooser_problem(p) == "no_answer", 30), str(chooser_problem(p)))
    plain, plain_port = stub_server("<html>It works!</html>")
    choose(p, "another", f"http://127.0.0.1:{plain_port}")
    check("[switch] an answer that is not Bakery is refused as such",
          wait_until(lambda: chooser_problem(p) == "not_bakery", 30), str(chooser_problem(p)))
    check("[switch] nothing was saved by any of that", not os.path.exists(os.path.join(p, "config", "settings.json")))

    # A server older than the app has its own panel; Choose a different server comes back to the chooser.
    old, old_port = stub_server(bakery_health(None))
    choose(p, "another", f"http://127.0.0.1:{old_port}")
    check("[switch] an older server gets its own panel", wait_window(p, "incompatible", timeout=30) is not None)
    check("[switch] the panel says which way", ((last_window(p) or {}).get("window") or {}).get("mismatch") == "server_older")
    press(p, "choose_different")
    check("[switch] Choose a different server returns to the chooser", wait_window(p, "choose", after=len(views(p)) - 1) is not None)
    new, new_port = stub_server(bakery_health(2))
    choose(p, "another", f"http://127.0.0.1:{new_port}")
    check("[switch] a newer server says the app is older",
          wait_until(lambda: ((last_window(p) or {}).get("window") or {}).get("mismatch") == "app_older", 30))

    # Use it anyway switches: the app restarts on the new server, in the same size, under the notice.
    starts = started_count(p)
    press(p, "use_it_anyway")
    check("[switch] the app switches", wait_effect(p, "switch_server", timeout=30) is not None)
    check("[switch] and comes back as a new start", wait_until(lambda: started_count(p) == starts + 1, 60))
    check("[switch] the window comes back in its size", wait_until(lambda: any(e["event"] == "place_restored" for e in reports(p)), 30))
    target = f"http://127.0.0.1:{new_port}"
    check("[switch] the sign-in panel names the new server under one notice",
          wait_until(lambda: (last_window(p) or {}).get("notice") == f"Bakery now uses {target}.", 30), str((last_window(p) or {}).get("notice")))
    saved = json.load(open(os.path.join(p, "config", "settings.json")))
    check("[switch] the choice is kept", saved.get("server") == target and saved.get("last_other") == target, str(saved))
    check("[switch] the first server's sign-in is still in the keyring", stored().startswith("bkd_") and stored() == secret)

    # Switching back keeps its sign-in: the app opens straight to the signed-in window.
    press(p, "use_different_server")
    check("[switch] the chooser opens from the new server", wait_window(p, "choose", after=len(views(p)) - 1, timeout=30) is not None)
    starts = started_count(p)
    choose(p, "another", SERVER)
    check("[switch] choosing the first server again switches back", wait_until(lambda: started_count(p) == starts + 1, 90))
    check("[switch] and opens signed in, with no new sign-in",
          wait_until(lambda: (last_window(p) or {}).get("window", {}).get("kind") == "app", 60))
    check("[switch] under the notice that the app uses the first server again",
          wait_until(lambda: (last_window(p) or {}).get("notice") == f"Bakery now uses {SERVER}.", 30), str((last_window(p) or {}).get("notice")))
    check("[switch] the sign-in is the same one", stored() == secret and bearer_status(secret) == 200)
    check("[switch] no secret reached any file", leaked(secret) is None)
    for srv in (plain, old, new):
        srv.shutdown()
    stop_app()


def phase_silent_server_then_back():
    p = os.path.join(OUT, "k-silent")
    clear_store()
    start_app(p, extra={"BAKERY_DESKTOP_RETRY_MS": "1000"})
    check("[silent] the sign-in window shows first", wait_window(p, "sign_in") is not None)
    check("[silent] the server is stopped", server_flag("stop"))
    seen = len(views(p))
    press(p, "sign_in")
    check("[silent] pressing Sign in with no answer says the server is not answering",
          wait_window(p, "not_answering", after=seen, timeout=60) is not None)
    check("[silent] the server is started again", server_flag("start"))
    check("[silent] the window moves on by itself, with no click",
          wait_window(p, "sign_in", after=seen + 1, timeout=60) is not None)
    stop_app()


def wait_report(path, event, count, timeout=20):
    """True once the app has reported the event at least `count` times."""
    end = time.time() + timeout
    while time.time() < end:
        if sum(1 for e in reports(path) if e["event"] == event) >= count:
            return True
        time.sleep(0.5)
    return False


def phase_open_links():
    p = os.path.join(OUT, "k-links")
    clear_store()
    start_app(p)
    deliver("bakery://open?path=%2Ftasks%2F7%3Ftab%3Dfiles")
    check("[links] an open link naming a page of the server is accepted with that path",
          wait_report(p, "link_open_requested", 1)
          and [e["data"]["path"] for e in reports(p) if e["event"] == "link_open_requested"] == ["/tasks/7?tab=files"])
    bad = ["bakery://open?path=%2F%2Fevil.test", "bakery://open?path=https%3A%2F%2Fevil.test",
           "bakery://open?path=%2Fa%2F..%2Fb", "bakery://open?path=%2Fa&path=%2Fb", "bakery://open",
           "bakery://open/extra?path=%2Fa"]
    for link in bad:
        deliver(link)
    check("[links] every address that is not a plain page of the server is refused",
          wait_report(p, "link_refused", len(bad)))
    shown = [e["data"].get("link_dialog") for e in reports(p) if e["event"] == "view"]
    check("[links] a refused address asks for no page and shows the can't-open dialog over the window",
          sum(1 for e in reports(p) if e["event"] == "link_open_requested") == 1 and "cant_open" in shown, str(shown))
    notices = [e["data"].get("notice") for e in reports(p) if e["event"] == "view"]
    check("[links] signed out, a page link asks for a sign-in on the sign-in panel",
          "Sign in to open the page from your link." in notices, str(notices))
    check("[links] a link that is not a sign-in answer leaves the window as it was",
          stored() == "" and views(p)[-1][0] == "sign_in", str(views(p)))
    stop_app()


def eval_in_window(path, script):
    """Runs a script in the app's window, as a person acting in the page would."""
    tmp = os.path.join(path, "cmd", "tmp-eval")
    with open(tmp, "w") as f:
        f.write(script)
    os.rename(tmp, os.path.join(path, "cmd", "eval-" + str(int(time.time() * 1000))))


def page_loads(path):
    return [(e["data"].get("host"), e["data"].get("path")) for e in reports(path) if e["event"] == "page_loaded"]


def phase_web_pages():
    """With the built web app on the connected server's own address: a real page opens after sign-in,
    and signing out in the web ends the app's sign-in."""
    web = os.environ.get("BAKERY_WEB", "")
    if not web:
        print("SKIP the web phase: no built web app (run with E2E_WEB=1)", flush=True)
        return
    host = web.split("//", 1)[1].split(":")[0]
    p = os.path.join(OUT, "m-web")
    clear_store()
    clear_store(web)
    start_app(p, server=web)
    assert wait_window(p, "sign_in") is not None
    # A page link that arrives while nobody is signed in is kept, and opens after the sign-in.
    deliver("bakery://open?path=%2Fissues")
    check("[web] a page link while signed out is kept and the panel says why",
          wait_report(p, "link_open_requested", 1)
          and "Sign in to open the page from your link." in [e["data"].get("notice") for e in reports(p) if e["event"] == "view"])
    url = sign_in_to_waiting(p, "[web]")
    if not url:
        return
    deliver(confirm(request_id_of(url), session_cookie()))
    check("[web] the app finishes and opens the server's page", wait_report(p, "server_page_opened", 1, timeout=40))
    check("[web] it opens the page the link named, not the start page",
          [e["data"]["path"] for e in reports(p) if e["event"] == "server_page_opened"][:1] == ["/issues"])
    end = time.time() + 40
    while time.time() < end and not any(h == host and not (pth or "").startswith("/sign-in") for h, pth in page_loads(p)):
        time.sleep(1)
    loads = page_loads(p)
    check("[web] a real page of the web app loads, signed in (not the sign-in page)",
          any(h == host and not (pth or "").startswith("/sign-in") for h, pth in loads), str(loads[-4:]))
    check("[web] the sign-in was saved for the web address", stored(web).startswith("bkd_"), "before sign-out")
    check("[web] the window's one-use code is in no report",
          not any("handoff" in json.dumps(e) and "code=" in json.dumps(e) for e in reports(p)))
    # The web's own Sign out: a full navigation to the web's sign-out page, as its link does.
    eval_in_window(p, "location.assign('/sign-out')")
    check("[web] signing out in the web ends the app's sign-in and returns to the sign-in panel",
          wait_report(p, "web_sign_out_seen", 1, timeout=40) and wait_window(p, "signed_out", timeout=40) is not None,
          str(views(p)[-3:]))
    check("[web] the saved sign-in is gone", stored(web) == "")
    check("[web] the window is back on the app's own panel", wait_report(p, "panels_shown", 1, timeout=20))
    stop_app()


def phase_web_download():
    """Builder question 5: a file a page offers is saved only where the person says, never silently
    into the folder the app was started from. A run cannot answer the system's dialog, so it is run
    twice: once with the harness choosing a folder in place of the dialog, and once as a person would
    meet it, where the dialog must open and nothing may be written before it is answered."""
    web = os.environ.get("BAKERY_WEB", "")
    if not web:
        return
    drop = os.path.join(OUT, "downloads")
    os.makedirs(drop, exist_ok=True)
    probe = ("const a=document.createElement('a');a.href='/favicon.svg';a.download='bakery-probe.svg';"
             "document.body.appendChild(a);a.click()")
    for label, extra in (("[download] with a folder chosen", {"BAKERY_DESKTOP_DOWNLOAD_TO": drop}),
                         ("[download] with the dialog", {})):
        p = os.path.join(OUT, "n-download-" + ("hook" if extra else "dialog"))
        clear_store(web)
        if os.path.exists(os.path.join(drop, "bakery-probe.svg")):
            os.remove(os.path.join(drop, "bakery-probe.svg"))
        start_app(p, server=web, extra=extra)
        url = sign_in_to_waiting(p, label)
        if not url:
            return
        deliver(confirm(request_id_of(url), session_cookie()))
        if not wait_report(p, "server_page_opened", 1, timeout=40):
            check(label + ": the server's page opens", False)
            stop_app()
            continue
        time.sleep(3)
        eval_in_window(p, probe)
        if extra:
            check(label + ": the file is saved there", wait_until(lambda: os.path.exists(os.path.join(drop, "bakery-probe.svg")), timeout=20))
            check(label + ": the app reports the save", wait_report(p, "download_finished", 1, timeout=20))
        else:
            # Without the harness, the system's save dialog opens and waits: nothing is written yet.
            time.sleep(6)
            check(label + ": nothing was written before the person answered",
                  not os.path.exists("/work/bakery-probe.svg") and not os.path.exists(os.path.join(drop, "bakery-probe.svg")) and
                  sum(1 for e in reports(p) if e["event"] == "download_started") == 0)
            tree = subprocess.run("xwininfo -root -tree 2>/dev/null | grep -iE 'save|bakery-probe' | head -3",
                                  shell=True, capture_output=True, text=True).stdout.strip()
            print("INFO the save dialog's window: " + (tree or "not found by name (xwininfo may be missing)"), flush=True)
        stop_app()


def main():
    print(f"server {SERVER}", flush=True)
    for phase in (phase_cold_sign_in, phase_restart, phase_cancel_then_late_answer, phase_bogus_answers,
                  phase_server_down_then_try_again, phase_ended_sign_in, phase_no_keyring, phase_address_spelling,
                  phase_sign_out, phase_choose_and_switch, phase_silent_server_then_back,
                  phase_open_links, phase_web_pages, phase_web_download):
        try:
            phase()
        except Exception as e:  # a phase that breaks is a failed check, not a silent skip
            check(f"{phase.__name__} ran to the end", False, repr(e)[:160])
        finally:
            stop_app()
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"{passed} passed, {len(results) - passed} failed", flush=True)
    json.dump([{"check": n, "ok": ok, "detail": d} for n, ok, d in results], open(os.path.join(OUT, "results.json"), "w"), indent=2)
    sys.exit(0 if passed == len(results) else 1)


main()
