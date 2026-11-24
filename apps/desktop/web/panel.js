// Renders the window the app says to show (design-ux, #77 slice 3). Everything on screen comes from
// the app as data: this file only draws it and sends back which button was pressed.
//
// No inline script or style anywhere: the page runs under a strict content security policy.

import { formatTime } from "./format.js";

const tauri = globalThis.__TAURI__;
const root = document.getElementById("root");
const announce = document.getElementById("announce");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detailBox(detail) {
  switch (detail.kind) {
    case "server": {
      const box = el("div", "detail");
      box.append(
        el("span", "detail__label", "Server"),
        el("span", "detail__value detail__value--address", detail.address),
      );
      return box;
    }
    case "address": {
      const box = el("div", "detail");
      box.append(
        el("span", "detail__value detail__value--address", detail.address),
      );
      return box;
    }
    case "waiting": {
      const box = el("div", "detail detail--waiting");
      const lines = el("div", "detail__lines");
      lines.append(el("div", "detail__value", detail.status));
      if (detail.until) {
        lines.append(
          el(
            "div",
            "detail__label",
            detail.until.text.replace("{time}", formatTime(detail.until.at)),
          ),
        );
      }
      const spinner = el("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      box.append(spinner, lines);
      return box;
    }
    case "working": {
      const box = el("div", "detail detail--waiting");
      const spinner = el("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      box.append(spinner, el("div", "detail__value", detail.text));
      return box;
    }
    case "warning": {
      const box = el("div", "detail detail--warning");
      box.setAttribute("role", "alert");
      box.append(el("span", "detail__value", detail.text));
      return box;
    }
    case "signed_in": {
      // Who is signed in, then the server, as two boxes. Either of name and email may be missing.
      const wrap = el("div", "detail-stack");
      const who = el("div", "detail");
      who.append(el("span", "detail__label", "Signed in as"));
      if (detail.name) who.append(el("span", "detail__value", detail.name));
      if (detail.email) {
        who.append(
          el(
            "span",
            detail.name ? "detail__label" : "detail__value",
            detail.email,
          ),
        );
      }
      const server = el("div", "detail");
      server.append(
        el("span", "detail__label", "Server"),
        el("span", "detail__value detail__value--address", detail.address),
      );
      wrap.append(who, server);
      return wrap;
    }
    case "server_tried": {
      const box = el("div", "detail");
      box.append(
        el("span", "detail__label", "Server"),
        el("span", "detail__value detail__value--address", detail.address),
        el(
          "span",
          "detail__label",
          detail.at
            ? detail.text.replace("{time}", formatTime(detail.at))
            : detail.text,
        ),
      );
      return box;
    }
    case "chooser":
      return chooserNode(detail);
    default:
      return null;
  }
}

// What the person has picked and typed in the chooser. The app only sends where it starts and why it
// stays open; typing is the page's own until Continue, so a status that arrives late never undoes it.
let draft = { selected: "this_computer", typed: "" };
let draftProblem = null;
let chooserOpen = false;

function chooserNode(detail) {
  const entering = !chooserOpen;
  const problemChanged = detail.problem !== draftProblem;
  if (entering || problemChanged) {
    draft = { selected: detail.selected, typed: detail.typed };
  }
  chooserOpen = true;
  draftProblem = detail.problem;

  const group = el("div", "chooser");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-labelledby", "panel-heading");

  const option = (value, label) => {
    const row = el("div", "chooser__option");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "server-choice";
    input.value = value;
    input.id = `choice-${value}`;
    input.checked = draft.selected === value;
    input.addEventListener("change", () => {
      draft.selected = value;
      syncBox();
    });
    const text = el("label", "chooser__label", label);
    text.htmlFor = input.id;
    text.id = `choice-label-${value}`;
    const head = el("div", "chooser__head");
    head.append(input, text);
    row.append(head);
    return row;
  };

  const here = option("this_computer", "This computer");
  const hereLine = el("div", "chooser__line");
  hereLine.append(
    el("span", "chooser__address", detail.this_computer_address),
    el("span", "chooser__status", detail.this_computer_status ?? ""),
  );
  here.append(hereLine);

  const other = option("another", "Another address");
  const box = document.createElement("input");
  box.type = "text";
  box.id = "server-address";
  box.className = "chooser__box";
  box.value = draft.typed;
  box.autocomplete = "off";
  box.spellcheck = false;
  box.setAttribute("aria-labelledby", "choice-label-another");
  box.setAttribute("aria-describedby", "server-address-note");
  box.addEventListener("input", () => {
    draft.typed = box.value;
  });
  const note = el(
    "div",
    detail.problem ? "chooser__problem" : "chooser__help",
    detail.problem ?? detail.help,
  );
  note.id = "server-address-note";
  if (detail.problem) {
    note.setAttribute("role", "alert");
    box.setAttribute("aria-invalid", "true");
  }
  const boxRow = el("div", "chooser__boxrow");
  boxRow.append(box, note);
  other.append(boxRow);

  // The box is under the second option only while that option is the one chosen.
  const syncBox = () => {
    boxRow.hidden = draft.selected !== "another";
  };
  syncBox();

  group.append(here, other);
  return group;
}

/// Sends the chooser's choice and text to the app.
async function continueChoosing() {
  await tauri.core.invoke("choose_server", {
    choice: draft.selected,
    typed: draft.typed,
  });
}

let current = null;
let copiedTimer = null;
let lastKey = "";
let beforeLinkDialog = null;
let linkDialogKind = null;

/// The dialog a link brought up, drawn over whatever the window shows (design-ux, slice 5, section 3).
function linkDialogNode(dialog) {
  const scrim = el("div", "scrim");
  const node = el("section", "panel panel--dialog");
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-modal", "true");
  node.setAttribute("aria-labelledby", "link-dialog-title");
  node.dataset.linkDialog = dialog.kind;
  const title = el("h1", "panel__heading", dialog.title);
  title.id = "link-dialog-title";
  node.append(title);
  for (const paragraph of dialog.text) {
    node.append(el("p", "panel__text", paragraph));
  }
  // The dialog for a page that did not open has no link to show, so no box.
  if (dialog.shown !== "") {
    const box = el("div", "detail");
    if (dialog.box_label) {
      box.append(el("span", "detail__label", dialog.box_label));
    }
    box.append(
      el("span", "detail__value detail__value--address", dialog.shown),
    );
    node.append(box);
  }
  const row = el("div", "buttons buttons--dialog");
  for (const button of dialog.buttons) {
    const b = el(
      "button",
      button.primary ? "btn btn--primary" : "btn",
      button.label,
    );
    b.type = "button";
    b.dataset.button = button.id;
    b.addEventListener("click", () => pressLinkDialog(dialog, button, b));
    row.append(b);
  }
  node.append(row);
  scrim.append(node);
  return { scrim, node, title };
}

async function pressLinkDialog(dialog, button, node) {
  if (button.id === "copy_link") {
    try {
      await navigator.clipboard.writeText(dialog.full);
    } catch {
      return;
    }
    // The dialog stays open; the button says so for two seconds.
    const label = button.label;
    node.textContent = "Copied";
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      node.textContent = label;
    }, 2000);
    return;
  }
  await tauri.core.invoke("press_button", { button: button.id });
}

async function press(button) {
  if (button.id === "copy_address") {
    const address = current?.panel?.detail?.address ?? "";
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Selecting the address by hand still works: it is shown selectable.
      return;
    }
    button.label = "Copied";
    render(current, { keepFocus: true });
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      button.label = "Copy the address";
      render(current, { keepFocus: true });
    }, 2000);
    return;
  }
  if (button.id === "continue") {
    await continueChoosing();
    return;
  }
  await tauri.core.invoke("press_button", { button: button.id });
}

function panelNode(panel, window) {
  const node = el("section", "panel");
  node.setAttribute("aria-labelledby", "panel-heading");
  if (panel.notice) node.append(el("p", "panel__notice", panel.notice));
  const heading = el("h1", "panel__heading", panel.heading);
  heading.id = "panel-heading";
  heading.tabIndex = -1;
  node.append(heading);
  if (panel.text) node.append(el("p", "panel__text", panel.text));
  const box = detailBox(panel.detail);
  if (box) node.append(box);
  if (panel.buttons.length > 0) {
    const row = el("div", "buttons");
    for (const button of panel.buttons) {
      const b = el(
        "button",
        button.primary ? "btn btn--primary" : "btn",
        button.label,
      );
      b.type = "button";
      b.dataset.button = button.id;
      b.addEventListener("click", () => press(button));
      row.append(b);
    }
    node.append(row);
  }
  return {
    node,
    heading,
    waiting: window.kind === "waiting" || window.kind === "finishing",
  };
}

let rendered = "";

/// Draws the link dialog over what is already on screen. Returns true while one is open, so the
/// panel behind keeps its place and focus stays in the dialog. Closing it returns focus to where it was.
function drawLinkDialog(view, _placeholder) {
  const dialog = view.link_dialog;
  if (!dialog) {
    if (linkDialogKind !== null) {
      linkDialogKind = null;
      const opener = beforeLinkDialog;
      beforeLinkDialog = null;
      const twin = opener ? root.querySelector(opener) : null;
      (twin ?? root.querySelector(".btn--primary") ??
        root.querySelector("#panel-heading"))?.focus();
    }
    return false;
  }
  const { scrim, node, title } = linkDialogNode(dialog);
  root.append(scrim);
  for (const child of root.children) {
    if (child !== scrim) child.inert = true;
  }
  if (linkDialogKind !== dialog.kind) {
    linkDialogKind = dialog.kind;
    (node.querySelector(".btn--primary") ?? title).focus();
    announce.textContent = dialog.title;
  }
  return true;
}

function selectorOf(node) {
  if (!(node instanceof HTMLElement) || node === document.body) return null;
  if (node.dataset.button) return `[data-button="${node.dataset.button}"]`;
  return node.id ? `#${node.id}` : null;
}

export function render(view, { keepFocus = false } = {}) {
  // The same view again changes nothing on screen: leave it, so focus stays where it is.
  const fingerprint = JSON.stringify(view);
  if (fingerprint === rendered && !keepFocus) return;
  rendered = fingerprint;
  current = view;
  if (linkDialogKind === null) {
    beforeLinkDialog = selectorOf(document.activeElement);
  }
  root.replaceChildren();
  if (view.window.kind !== "choose") {
    chooserOpen = false;
    draftProblem = null;
  }
  if (!view.panel) {
    // The app itself: the web app's own pages arrive in a later slice.
    const node = el("section", "panel");
    node.append(el("h1", "panel__heading", "You are signed in"));
    root.append(node);
    drawLinkDialog(view, true);
    return;
  }
  const { node, heading, waiting } = panelNode(view.panel, view.window);
  if (view.dialog) {
    const scrim = el("div", "scrim");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-modal", "true");
    scrim.append(node);
    root.append(scrim);
  } else {
    root.append(node);
  }
  if (drawLinkDialog(view, false)) return;
  const key = JSON.stringify([view.window, view.dialog]);
  if (!keepFocus && key !== lastKey) {
    lastKey = key;
    // The primary button takes focus when a state appears; the heading while waiting.
    const primary = node.querySelector(".btn--primary");
    const chosen = node.querySelector(".chooser input[type=radio]:checked");
    const box = node.querySelector("#server-address[aria-invalid]");
    // A chooser that stays open with a problem puts the cursor back in the marked box.
    (view.window.kind === "choose" && box && !box.parentElement.hidden
      ? box
      : view.window.kind === "choose" && chosen
      ? chosen
      : waiting || !primary
      ? heading
      : primary).focus();
    // Each change is announced once.
    announce.textContent = view.panel.heading;
  } else if (keepFocus) {
    const primary = node.querySelector(".btn--primary");
    primary?.focus();
  }
}

function theme() {
  const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

document.addEventListener("keydown", (event) => {
  const dialog = current?.link_dialog;
  if (dialog) {
    if (event.key === "Escape") {
      event.preventDefault();
      const close = dialog.buttons.find((b) => b.id === "close");
      if (close) pressLinkDialog(dialog, close, document.body);
    }
    return;
  }
  if (!current?.panel) return;
  if (event.key === "Escape") {
    const cancel = current.panel.buttons.find((b) => b.id === "cancel");
    if (cancel) {
      event.preventDefault();
      press(cancel);
    }
  } else if (
    event.key === "Enter" && !(event.target instanceof HTMLButtonElement)
  ) {
    const primary = current.panel.buttons.find((b) => b.primary);
    if (primary) {
      event.preventDefault();
      press(primary);
    }
  }
});

theme();
globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener(
  "change",
  theme,
);

if (tauri) {
  tauri.event.listen("view", (event) => render(event.payload));
  tauri.core.invoke("get_view").then(render);
}
