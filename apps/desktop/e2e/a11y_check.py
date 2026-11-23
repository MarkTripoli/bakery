#!/usr/bin/env python3
"""Reads the app's window the way a screen reader does, over the accessibility bus (AT-SPI), and checks it.

  a11y_check.py <state> <size> <output dir>

Run by a11y.sh, inside the build image, with the app already showing one named state. Prints one line per
check, `PASS` or `FAIL`, writes the whole tree of the window to <output dir>/<state>-<size>.tree.txt, and
exits 1 when any check failed. Native accessibility for the desktop app (#77, acceptance criterion 1):
what a person using a screen reader or only a keyboard meets, read from the real window, not from a page
test in a browser.
"""
import os
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

state, size, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
# Things a person acts on: each needs a name a screen reader can say, and must be reachable.
INTERACTIVE = {"push button", "radio button", "check box", "link", "entry", "combo box", "toggle button", "text"}
SKIP_TEXT_NAMES = {"text"}  # "text" nodes are only interactive when they take input; judged below
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
    """The tree below a node, as plain records in reading order."""
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
    # The web view is built and the page is in it: a heading has arrived.
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


nodes = wait_for(has_page)
os.makedirs(out_dir, exist_ok=True)


def dump(records, path):
    with open(path, "w") as f:
        for n in records:
            flags = ",".join(sorted(n["states"] - {"visible", "enabled"}))
            f.write("  " * n["depth"] + f"{n['role']} {n['name']!r} [{flags}]\n")


dump(nodes, os.path.join(out_dir, f"{state}-{size}.tree.txt"))

# 1. The window is there and has a name.
frames = [n for n in nodes if n["role"] == "frame"]
check("one window, named Bakery", len(frames) == 1 and frames[0]["name"] == "Bakery", str([(f["role"], f["name"]) for f in frames]))

# 2. The Bakery menu is reachable and every entry has a name.
menu_items = [n for n in nodes if n["role"] == "menu item"]
check("the Bakery menu has named entries", len(menu_items) >= 3 and all(n["name"] for n in menu_items), str([n["name"] for n in menu_items]))

# 3. The page is a document a screen reader can enter.
documents = [n for n in nodes if n["role"] == "document web"]
check("the page is a document", len(documents) == 1)

# 4. A way in: one heading level 1, named, before anything a person can press.
page = [n for n in nodes if n["role"] not in ("menu bar", "menu", "menu item", "separator") and not inside(n, "menu bar")]
headings = [n for n in page if n["role"] == "heading"]
check("one heading names the window", len(headings) >= 1 and all(h["name"] for h in headings) and any(
    h["attrs"].get("level") in (None, "1") for h in headings
), str([(h["name"], h["attrs"].get("level")) for h in headings]))
first_interactive = next((i for i, n in enumerate(page) if n["role"] in INTERACTIVE), None)
first_heading = next((i for i, n in enumerate(page) if n["role"] == "heading"), None)
if first_interactive is not None:
    check("the heading comes before the first control", first_heading is not None and first_heading < first_interactive)

# 5. Every control has a name and can take the keyboard.
# Only what is on screen: a control that is hidden (the address box until "Another address" is chosen) is not read.
controls = [n for n in page if n["role"] in INTERACTIVE and "showing" in n["states"]
            and not (n["role"] == "text" and "editable" not in n["states"])]
check("every control has a name a screen reader can say", all(c["name"] for c in controls), str([c["role"] for c in controls if not c["name"]]))
check("every control can take the keyboard", all("focusable" in c["states"] for c in controls),
      str([c["name"] for c in controls if "focusable" not in c["states"]]))

# 6. A dialog is a dialog: named, modal, with the buttons inside it; focus starts on a button in it.
dialogs = [n for n in page if n["role"] == "dialog"]
is_dialog_state = state.startswith("link-") and state != "link-sign-in"
if is_dialog_state:
    check("the link dialog is one named dialog", len(dialogs) == 1 and dialogs[0]["name"], str([(d["name"], d["states"]) for d in dialogs]))
    if dialogs:
        check("the dialog is modal", "modal" in dialogs[0]["states"])
        in_dialog = [c for c in controls if inside(c, "dialog")]
        check("its buttons are inside it", len(in_dialog) >= 2, str([c["name"] for c in controls]))
        now = [n for n in focused(nodes) if n["role"] == "push button"]
        check("focus starts on a button in the dialog", len(now) == 1 and inside(now[0], "dialog"), str([(n["name"]) for n in focused(nodes)]))
elif controls:
    # A state that waits puts focus on its heading so it is read once; any other puts it on the main button.
    now = [n for n in nodes if "focused" in n["states"] and n["role"] in INTERACTIVE | {"heading"}]
    check("focus starts on the heading or a control", len(now) >= 1, str([(n["role"], n["name"]) for n in nodes if "focused" in n["states"]]))

# 7. Only the keyboard: Tab visits every control and, in a dialog, never leaves it.
if controls and size.startswith("9"):
    # No window manager here, so the pointer is put on the window for the keys to reach it.
    Atspi.generate_mouse_event(480, 330, "abs")
    time.sleep(0.3)
    seen = []
    escaped = False
    for _ in range(len(controls) + 2):
        press(TAB)
        now = [n for n in focused(snapshot()) if n["role"] != "document web"]
        if now:
            seen.append(now[0]["name"])
            if is_dialog_state and not inside(now[0], "dialog"):
                escaped = True
    # A radio group is one stop of Tab: the arrow keys move within it.
    names = [c["name"] for c in controls if c["role"] != "radio button"]
    radios = [c["name"] for c in controls if c["role"] == "radio button"]
    reached = all(name in seen for name in names) and (not radios or any(name in seen for name in radios))
    check("Tab reaches every control", reached, f"controls {names + radios}, reached {seen}")
    if is_dialog_state:
        check("Tab stays inside the dialog", not escaped, str(seen))

def activate(name):
    """Presses a button the way a screen reader's "press" does: through its action, not through the app's own
    harness, so it reaches the page's own handler and the app's command (a call to a command the app does not
    have was silent and left every drawn button dead: #77)."""
    button = next((n for n in snapshot() if n["role"] == "push button" and n["name"] == name), None)
    if button is None:
        return False
    return bool(Atspi.Action.do_action(button["node"], 0))


# 8. A link dialog closes by Escape (at the wide size) and by its Close button, pressed for real (at the narrow one).
if is_dialog_state and dialogs:
    if size.startswith("9"):
        press(ESCAPE)
        label = "Escape"
    else:
        # The button that closes: "Close", or "Cancel" in the dialog that offers to open another server's page.
        closer = next((c["name"] for c in controls if c["name"] in ("Close", "Cancel") and inside(c, "dialog")), "Close")
        activate(closer)
        label = f"Pressing {closer}"
    after = wait_for(lambda ns: not any(n["role"] == "dialog" for n in ns), timeout=6)
    check(f"{label} closes the dialog", not any(n["role"] == "dialog" for n in after))
# (A preview state ignores the app's events on purpose, so a button that starts a sign-in or opens the chooser
# cannot be seen working here. Every drawn button reaches the app through the one command Close uses, which the
# unit test tests/unit/desktop-page-commands_test.ts ties to the app's registered commands.)

sys.exit(0 if all(results) else 1)
