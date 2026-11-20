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
        el("span", "detail__value", detail.address),
      );
      return box;
    }
    case "address": {
      const box = el("div", "detail");
      box.append(el("span", "detail__value", detail.address));
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
    default:
      return null;
  }
}

let current = null;
let copiedTimer = null;
let lastKey = "";

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
  await tauri.core.invoke("press", { button: button.id });
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

export function render(view, { keepFocus = false } = {}) {
  // The same view again changes nothing on screen: leave it, so focus stays where it is.
  const fingerprint = JSON.stringify(view);
  if (fingerprint === rendered && !keepFocus) return;
  rendered = fingerprint;
  current = view;
  root.replaceChildren();
  if (!view.panel) {
    // The app itself: the web app's own pages arrive in a later slice.
    const node = el("section", "panel");
    node.append(el("h1", "panel__heading", "You are signed in"));
    root.append(node);
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
  const key = JSON.stringify([view.window, view.dialog]);
  if (!keepFocus && key !== lastKey) {
    lastKey = key;
    // The primary button takes focus when a state appears; the heading while waiting.
    const primary = node.querySelector(".btn--primary");
    (waiting || !primary ? heading : primary).focus();
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
