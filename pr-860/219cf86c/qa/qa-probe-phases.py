# QA probe phases added to apps/desktop/e2e/scenario.py (not part of the PR). Run: E2E_WEB=1 E2E_PHASES=qa_links bash apps/desktop/e2e/e2e.sh

def phase_qa_links_in_page():
    """QA probe (not part of the PR): links pressed inside a signed-in server page, and a save that
    cannot be moved into the chosen folder."""
    web = os.environ.get("BAKERY_WEB", "")
    if not web:
        print("SKIP: no web app", flush=True)
        return
    p = os.path.join(OUT, "q-links")
    clear_store()
    clear_store(web)
    start_app(p, server=web, extra={"BAKERY_DESKTOP_DIALOG_ANSWER": "Close"})
    url = sign_in_to_waiting(p, "[qa]")
    if not url:
        return
    deliver(confirm(request_id_of(url), session_cookie()))
    if not wait_report(p, "server_page_opened", 1, timeout=40):
        check("[qa] the server's page opens", False)
        return
    time.sleep(4)

    def count(ev):
        return sum(1 for e in reports(p) if e["event"] == ev)

    def anchor(href, target=None):
        t = ("a.target='%s';" % target) if target else ""
        return ("const a=document.createElement('a');a.href='%s';%sa.rel='noopener noreferrer';"
                "a.textContent='qa';document.body.appendChild(a);a.click()" % (href, t))

    # 1. control: the window itself goes to another site (decided by on_navigation)
    b = count("link_to_browser")
    eval_in_window(p, "location.href='https://example.com/control'")
    time.sleep(6)
    check("[qa] control: the window going to another site is handed to the browser", count("link_to_browser") == b + 1,
          str([(e["event"], e["data"]) for e in reports(p) if "link" in e["event"]][-4:]))
    # 2. an ordinary link (no target) to another site
    b = count("link_to_browser")
    eval_in_window(p, anchor("https://example.com/plain"))
    time.sleep(6)
    check("[qa] a plain link to another site is handed to the browser", count("link_to_browser") == b + 1)
    # 3. target=_blank to another site (how the web marks external links)
    b = count("link_to_browser")
    eval_in_window(p, anchor("https://example.com/blank", "_blank"))
    time.sleep(6)
    check("[qa] a target=_blank link to another site is handed to the browser", count("link_to_browser") == b + 1,
          str([(e["event"], e["data"]) for e in reports(p) if "link" in e["event"]][-4:]))
    # 4. window.open to another site
    b = count("link_to_browser")
    eval_in_window(p, "window.open('https://example.com/open', '_blank')")
    time.sleep(6)
    check("[qa] window.open to another site is handed to the browser", count("link_to_browser") == b + 1)
    # 5. target=_blank to a page of the connected server: the design says it opens in this window
    n = len(page_loads(p))
    eval_in_window(p, anchor("/issues", "_blank"))
    time.sleep(8)
    loads = page_loads(p)
    check("[qa] a target=_blank link to a Bakery page opens that page in this window",
          any(pth == "/issues" for _, pth in loads[n:]), str(loads[n:]))
    # 6. a plain link to a Bakery page stays in the window
    n = len(page_loads(p))
    eval_in_window(p, anchor("/projects"))
    time.sleep(8)
    loads = page_loads(p)
    check("[qa] a plain link to a Bakery page opens in the window", any(pth == "/projects" for _, pth in loads[n:]), str(loads[n:]))
    # 7. mailto and a file: link
    eval_in_window(p, anchor("file:///etc/passwd"))
    time.sleep(4)
    check("[qa] a file: link is refused", count("link_refused") >= 1, str(count("link_refused")))
    stop_app()

    # 8. a save that cannot be moved to the chosen folder: nothing may be left anywhere
    drop = os.path.join(OUT, "no-such-dir", "deeper")
    q = os.path.join(OUT, "q-save-fail")
    clear_store(web)
    start_app(q, server=web, extra={"BAKERY_DESKTOP_DOWNLOAD_TO": drop})
    url = sign_in_to_waiting(q, "[qa-save]")
    if not url:
        return
    deliver(confirm(request_id_of(url), session_cookie()))
    if not wait_report(q, "server_page_opened", 1, timeout=40):
        check("[qa-save] the server's page opens", False)
        return
    time.sleep(3)
    eval_in_window(q, "const a=document.createElement('a');a.href='/favicon.svg';a.download='bakery-probe.svg';document.body.appendChild(a);a.click()")
    incoming = os.path.join("/tmp", f"bakery-incoming-{app.pid}")
    time.sleep(8)
    toasts = [e["data"] for e in reports(q) if e["event"] == "toast"]
    check("[qa-save] a failed move says the file could not be saved", any("could not be saved" in (t.get("text") or "") for t in toasts), str(toasts))
    left = os.listdir(incoming) if os.path.isdir(incoming) else []
    check("[qa-save] nothing is left in the app's own folder", left == [], str(left))
    check("[qa-save] nothing was created at the chosen path", not os.path.exists(drop))


def phase_qa_links3():
    """QA probe 2 (not part of the PR): what each kind of link does from a signed-in server page."""
    web = os.environ.get("BAKERY_WEB", "")
    if not web:
        return
    p = os.path.join(OUT, "q-links2")
    clear_store()
    clear_store(web)
    start_app(p, server=web, extra={"BAKERY_DESKTOP_DIALOG_ANSWER": "Close"})
    url = sign_in_to_waiting(p, "[qa2]")
    if not url:
        return
    deliver(confirm(request_id_of(url), session_cookie()))
    if not wait_report(p, "server_page_opened", 1, timeout=40):
        check("[qa2] the server's page opens", False)
        return
    time.sleep(4)

    def step(label, script, expect, wait=8):
        before = len(reports(p))
        eval_in_window(p, script)
        time.sleep(wait)
        new = [(e["event"], json.dumps(e["data"])[:90]) for e in reports(p)[before:] if e["event"] != "command"]
        names = [n for n, _ in new]
        check("[qa2] " + label, any(x in names for x in expect), "saw " + str(new))

    step("another app's address is refused with a dialog", "location.href = 'slack://open'", ["link_refused", "system_dialog"], 6)
    step("a mailto: address is handed to the system", "location.href = 'mailto:qa@example.test'", ["link_to_system"], 6)
    step("a tel: address is handed to the system", "location.href = 'tel:+10000000'", ["link_to_system"], 6)
    step("a file: address is refused with a dialog", "location.href = 'file:///etc/hostname'", ["link_refused", "system_dialog"], 8)
    step("a data: address is refused with a dialog", "location.href = 'data:text/html,hi'", ["link_refused", "system_dialog"], 8)
    step("window.open of another site goes to the browser", "window.open('https://example.com/o', '_blank')", ["link_to_browser"], 8)
    step("window.open of a Bakery page opens it in this window", "window.open('/issues', '_blank')", ["page_loaded"], 20)
    step("control: a full navigation inside the server is seen as a page load", "location.assign('/projects')", ["page_loaded"], 25)
    stop_app()
