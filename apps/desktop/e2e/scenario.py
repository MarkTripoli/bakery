#!/usr/bin/env python3
"""End to end: the production app against a real Bakery server, on Linux.

Runs inside the container (see scenario.sh). The app is driven the way a person would: buttons are
pressed through the harness's command directory, the browser's part is done over HTTP exactly as a
browser would, and the operating system hands the app its answer with `gio open`. Every phase
checks the windows the app showed, in order, and the secret store, and that no secret reached a file.
"""
import json
import os
import re
import subprocess
import sys
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


def start_app(path, bus=None, server=None):
    global app
    os.makedirs(os.path.join(path, "cmd"), exist_ok=True)
    env = dict(os.environ, BAKERY_SERVER=server or SERVER, BAKERY_DESKTOP_REPORT=os.path.join(path, "report.jsonl"),
               BAKERY_DESKTOP_COMMANDS=os.path.join(path, "cmd"), TZ="UTC")
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
            app.kill()
    app = None


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


def request_id_of(url):
    return urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["request"][0]


def stored():
    r = subprocess.run(["secret-tool", "lookup", "service", SERVICE, "username", USER],
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


def clear_store():
    subprocess.run(["secret-tool", "clear", "service", SERVICE, "username", USER], capture_output=True)


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


def main():
    print(f"server {SERVER}", flush=True)
    for phase in (phase_cold_sign_in, phase_restart, phase_cancel_then_late_answer, phase_bogus_answers,
                  phase_server_down_then_try_again, phase_ended_sign_in, phase_no_keyring, phase_address_spelling):
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
