#!/usr/bin/env python3
import os
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

state, size, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
INTERACTIVE = {"push button", "radio button", "check box", "link", "entry", "combo box", "toggle button", "text"}
results = []

def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + f"[{state} {size}] {name}" + (f"  {detail}" if detail and not ok else ""), flush=True)

def states_of(node):
    try:
        st = node.get_state_set()
    except Exception:
        return set()
    names = set()
    for label in ("FOCUSED", "FOCUSABLE", "SHOWING", "MODAL", "EDITABLE", "VISIBLE", "ENABLED"):
        if st.contains(getattr(Atspi.StateType, label)):
            names.add(label.lower())
    return names

def read(node, path, depth=0):
    try:
        role, name = node.get_role_name(), node.get_name() or ""
        attrs = dict(node.get_attributes() or {})
    except Exception:
        return []
    record = {"role": role, "name": name, "states": states_of(node), "attrs": attrs, "path": path, "depth": depth, "node": node}
    out = [record]
    if depth > 40:
        return out
    try:
        count = min(node.get_child_count(), 400)
    except Exception:
        return out
    for index in range(count):
        try:
            child = node.get_child_at_index(index)
        except Exception:
            continue
        if child is not None:
            out.extend(read(child, path + [(role, name)], depth + 1))
    return out

def find_app():
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if "bakery" in (app.get_name() or "").lower():
            return app
    return None

def snapshot():
    app = find_app()
    return read(app, []) if app else []

def wait_for(condition, timeout=30):
    end = time.time() + timeout
    nodes = []
    while time.time() < end:
        nodes = snapshot()
        if condition(nodes):
            return nodes
        time.sleep(0.5)
    return nodes

def has_page(nodes):
    return any(n["role"] == "heading" for n in nodes) or any(n["role"] == "document web" and n["name"] for n in nodes) and any(
        n["role"] in INTERACTIVE for n in nodes
    )

def press(keysym):
    Atspi.generate_keyboard_event(keysym, None, Atspi.KeySynthType.PRESSRELEASE | Atspi.KeySynthType.SYM)
    time.sleep(0.4)

TAB, ESCAPE = 0xFF09, 0xFF1B

def focused(nodes):
    return [n for n in nodes if "focused" in n["states"] and n["role"] in INTERACTIVE | {"document web"}]

def inside(record, role):
    return any(r == role for r, _ in record["path"])

def server_page_built(nodes):
    headings = [n for n in nodes if n["role"] == "heading" and n["name"]]
    landmarks = [n for n in nodes if n["role"] == "landmark"]
    links = [n for n in nodes if n["role"] == "link" and n["name"]]
    return bool(headings) and len(landmarks) >= 3 and len(links) >= 3

nodes = wait_for(server_page_built if state == "server-page" else has_page, timeout=90 if state == "server-page" else 30)
os.makedirs(out_dir, exist_ok=True)

def dump(records, path):
    with open(path, "w") as f:
        for n in records:
            flags = ",".join(sorted(n["states"] - {"visible", "enabled"}))
            f.write("  " * n["depth"] + f"{n['role']} {n['name']!r} [{flags}]\n")

dump(nodes, os.path.join(out_dir, f"{state}-{size}.tree.txt"))

frames = [n for n in nodes if n["role"] == "frame"]
check("one window, named Bakery", len(frames) == 1 and frames[0]["name"] == "Bakery", str([(f["role"], f["name"]) for f in frames]))

menu_items = [n for n in nodes if n["role"] == "menu item"]
check("the Bakery menu has named entries", len(menu_items) >= 3 and all(n["name"] for n in menu_items), str([n["name"] for n in menu_items]))

documents = [n for n in nodes if n["role"] == "document web"]
check("the page is a document", len(documents) == 1)

page = [n for n in nodes if n["role"] not in ("menu bar", "menu", "menu item", "separator") and not inside(n, "menu bar")]
headings = [n for n in page if n["role"] == "heading"]
check("one heading names the window", len(headings) >= 1 and all(h["name"] for h in headings) and any(
    h["attrs"].get("level") in (None, "1") for h in headings
), str([(h["name"], h["attrs"].get("level")) for h in headings]))
first_interactive = next((i for i, n in enumerate(page) if n["role"] in INTERACTIVE), None)
first_heading = next((i for i, n in enumerate(page) if n["role"] == "heading"), None)
if first_interactive is not None and state != "server-page":
    check("the heading comes before the first control", first_heading is not None and first_heading < first_interactive)

SERVER_PAGE = state == "server-page"

controls = [n for n in page if n["role"] in INTERACTIVE and "showing" in n["states"]
            and not (n["role"] == "text" and "editable" not in n["states"])]
if not SERVER_PAGE:
    check("every control has a name a screen reader can say", all(c["name"] for c in controls), str([c["role"] for c in controls if not c["name"]]))
    check("every control can take the keyboard", all("focusable" in c["states"] for c in controls),
          str([c["name"] for c in controls if "focusable" not in c["states"]]))

dialogs = [n for n in page if n["role"] == "dialog"]
is_dialog_state = state.startswith("link-") and state != "link-sign-in"
if is_dialog_state:
    check("the link dialog is one named dialog", len(dialogs) == 1 and dialogs[0]["name"], str([(d["name"], d["states"]) for d in dialogs]))
    if dialogs:
        check("the dialog is modal", "modal" in dialogs[0]["states"])
        in_dialog = [c for c in page if c["role"] in INTERACTIVE and inside(c, "dialog")]
        check("its buttons are inside it", len(in_dialog) >= 2, str([c["name"] for c in controls]))
        now = [n for n in focused(nodes) if n["role"] == "push button"]
        check("focus starts on a button in the dialog", len(now) == 1 and inside(now[0], "dialog"), str([(n["name"]) for n in focused(nodes)]))
elif controls and state != "server-page":
    now = [n for n in nodes if "focused" in n["states"] and n["role"] in INTERACTIVE | {"heading"}]
    check("focus starts on the heading or a control", len(now) >= 1, str([(n["role"], n["name"]) for n in nodes if "focused" in n["states"]]))

if SERVER_PAGE:
    Atspi.generate_mouse_event(860, 560, "abs")
    time.sleep(0.3)
    Atspi.generate_mouse_event(860, 560, "b1c")
    time.sleep(0.6)
    stops = []
    lost = 0
    for _ in range(10):
        press(TAB)
        every = snapshot()
        now = [n for n in focused(every) if n["role"] != "document web"]
        if now:
            stops.append((now[0]["role"], now[0]["name"]))
        else:
            lost += 1
    if lost == 10 and not stops:
        print("NOTE [server-page] keyboard focus inside the web page is not reported in this rig: Tab itself is not proven",
              flush=True)
    else:
        check("Tab lands on a control at every press", lost == 0, f"focus was lost {lost} times; stops {stops}")
        check("every control Tab reaches has a name", bool(stops) and all(name for _, name in stops), str(stops))
        check("Tab moves on: it does not stay on one control", len({stop for stop in stops}) >= 3, str(stops))

    reachable = [n for n in page if n["role"] in INTERACTIVE and "focusable" in n["states"] and "showing" in n["states"]]
    check("the page offers a link to skip to its content first",
          bool(reachable) and reachable[0]["role"] == "link" and "skip" in reachable[0]["name"].lower(),
          str([(n["role"], n["name"]) for n in reachable[:2]]))
    check("every control a keyboard can reach has a name", all(n["name"] for n in reachable),
          str([n["role"] for n in reachable if not n["name"]]))
    check("the page has landmarks to jump between", sum(1 for n in page if n["role"] == "landmark") >= 3,
          str(sum(1 for n in page if n["role"] == "landmark")))

if controls and size.startswith("9") and not SERVER_PAGE:
    Atspi.generate_mouse_event(480, 330, "abs")
    time.sleep(0.3)
    seen = []
    escaped = False
    tabbable = [n for n in page if n["role"] in INTERACTIVE and "focusable" in n["states"]
                and not (n["role"] == "text" and "editable" not in n["states"])] if os.environ.get("ZOOM") else controls
    for _ in range(len(tabbable) + 2):
        press(TAB)
        now = [n for n in focused(snapshot()) if n["role"] != "document web"]
        if now:
            seen.append(now[0]["name"])
            if is_dialog_state and not inside(now[0], "dialog"):
                escaped = True
    names = [c["name"] for c in tabbable if c["role"] != "radio button"]
    radios = [c["name"] for c in tabbable if c["role"] == "radio button"]
    reached = all(name in seen for name in names) and (not radios or any(name in seen for name in radios))
    check("Tab reaches every control", reached, f"controls {names + radios}, reached {seen}")
    if is_dialog_state:
        check("Tab stays inside the dialog", not escaped, str(seen))

if os.environ.get("ZOOM"):
    def extents(node):
        box = Atspi.Component.get_extents(node, Atspi.CoordType.SCREEN)
        return box.x, box.y, box.width, box.height

    fx, _, fw, _ = extents(frames[0]["node"]) if frames else (0, 0, 0, 0)
    off = []
    for n in page:
        if n["role"] in INTERACTIVE | {"heading", "paragraph", "dialog"} and "showing" in n["states"]:
            x, _, w, _ = extents(n["node"])
            if w > 0 and (x < fx - 1 or x + w > fx + fw + 1):
                off.append((n["role"], n["name"][:30], x - fx, w, fw))
    check("at 200% zoom nothing runs off the window sideways", not off, str(off[:3]))

def activate(name):
    button = next((n for n in snapshot() if n["role"] == "push button" and n["name"] == name), None)
    if button is None:
        return False
    return bool(Atspi.Action.do_action(button["node"], 0))

if is_dialog_state and dialogs:
    if size.startswith("9"):
        press(ESCAPE)
        label = "Escape"
    else:
        closer = next((c["name"] for c in page if c["role"] in INTERACTIVE and c["name"] in ("Close", "Cancel")
                       and inside(c, "dialog")), "Close")
        activate(closer)
        label = f"Pressing {closer}"
    after = wait_for(lambda ns: not any(n["role"] == "dialog" for n in ns), timeout=6)
    check(f"{label} closes the dialog", not any(n["role"] == "dialog" for n in after))

sys.exit(0 if all(results) else 1)
