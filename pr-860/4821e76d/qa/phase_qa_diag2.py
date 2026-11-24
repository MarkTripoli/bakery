def phase_qa_diag2():
    """QA diagnostic 2 (not part of the PR): does a click on a new-tab or file link from a signed-in server page
    work every time, and what is on screen after it."""
    web = os.environ.get("BAKERY_WEB", "")
    if not web:
        return

    def session(tag):
        p = os.path.join(OUT, "q-" + tag)
        clear_store()
        clear_store(web)
        start_app(p, server=web, extra={"BAKERY_DESKTOP_DIALOG_ANSWER": "Close"})
        url = sign_in_to_waiting(p, "[" + tag + "]")
        if not url:
            return None
        deliver(confirm(request_id_of(url), session_cookie()))
        if not wait_report(p, "server_page_opened", 1, timeout=40):
            check("[" + tag + "] the server's page opens", False)
            return None
        time.sleep(10)
        return p

    def step(p, tag, label, script, expect, wait=7):
        before = len(reports(p))
        eval_in_window(p, script)
        time.sleep(wait)
        shot(tag + "-" + label.split()[0].lower())
        new = [(e["event"], json.dumps(e["data"])[:60]) for e in reports(p)[before:] if e["event"] not in ("command", "view")]
        names = [n for n, _ in new]
        check("[" + tag + "] " + label, any(x in names for x in expect), "saw " + str(new))

    def anchor(href, attrs=""):
        return ("const a=document.createElement('a');a.href='%s';%sa.textContent='qa';document.body.appendChild(a);a.click()" % (href, attrs))

    p = session("diagA")
    if p:
        step(p, "A", "A1 first target=_blank click to another site", anchor("https://example.com/a1", "a.target='_blank';"), ["link_to_browser"])
        step(p, "A", "A2 second target=_blank click to another site", anchor("https://example.com/a2", "a.target='_blank';"), ["link_to_browser"])
        step(p, "A", "A3 then a file: click", anchor("file:///etc/hostname"), ["link_refused", "system_dialog"])
        step(p, "A", "A4 then another target=_blank click", anchor("https://example.com/a4", "a.target='_blank';"), ["link_to_browser"])
        stop_app()
    p = session("diagB")
    if p:
        x_click(300, 450)
        time.sleep(2)
        step(p, "B", "B1 target=_blank click after a real click on the page", anchor("https://example.com/b1", "a.target='_blank';"), ["link_to_browser"], 8)
        step(p, "B", "B2 again", anchor("https://example.com/b2", "a.target='_blank';"), ["link_to_browser"], 8)
        stop_app()


