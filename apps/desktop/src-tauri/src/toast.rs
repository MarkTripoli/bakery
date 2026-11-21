//! The notice for a saved file, drawn over the server's page (#77 slice 5, design-ux's Toast).
//!
//! The page cannot talk to the app and the app cannot draw inside it, so the notice is added to the
//! page's own document with the web's own Toast classes (the same styles the web shows), made from
//! text nodes only: nothing from a file name or a path is ever read as markup. A button in it asks the
//! app to act by navigating to `bakery-action://<nonce>/<action>/<id>`, which the app answers itself
//! and never loads; the nonce is made when the app starts, so a page cannot ask for an action.

use serde_json::json;

pub use bakery_desktop_core::links::ACTION_SCHEME;

#[derive(Clone, Copy)]
pub enum Tone {
    Success,
    Information,
    Error,
}

pub struct Toast {
    pub id: u64,
    pub tone: Tone,
    /// The first line: what happened.
    pub text: String,
    /// A second line, where there is a reason to give.
    pub detail: Option<String>,
    /// Shown when the pointer rests on the notice (the full folder path).
    pub tooltip: Option<String>,
    /// Buttons: label and the action the app answers.
    pub actions: Vec<(String, &'static str)>,
    /// Seconds after which it goes, unless the pointer or focus is on it. None: stays until closed.
    pub goes_after: Option<u64>,
}

fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// The script that shows (or replaces) the notice in the open page.
pub fn show_script(toast: &Toast, nonce: &str) -> String {
    let tone = match toast.tone {
        Tone::Success => "success",
        Tone::Information => "information",
        Tone::Error => "error",
    };
    let role = if matches!(toast.tone, Tone::Error) {
        "alert"
    } else {
        "status"
    };
    let actions: Vec<_> = toast.actions.iter().map(|(l, a)| json!([l, a])).collect();
    format!(
        r#"(() => {{
  const id = {id};
  const nonce = {nonce};
  const tone = {tone};
  const role = {role};
  const text = {text};
  const detail = {detail};
  const tooltip = {tooltip};
  const actions = {actions};
  const goesAfter = {goes_after};
  let host = document.getElementById("bakery-toasts");
  if (!host) {{
    host = document.createElement("div");
    host.id = "bakery-toasts";
    const s = host.style;
    s.position = "fixed"; s.insetInlineEnd = "16px"; s.insetBlockEnd = "16px"; s.zIndex = "2147483647";
    s.display = "flex"; s.flexDirection = "column-reverse"; s.gap = "8px";
    s.maxInlineSize = "min(420px, calc(100% - 32px))";
    (document.body || document.documentElement).appendChild(host);
  }}
  const old = host.querySelector('[data-bakery-toast="' + id + '"]');
  if (old) old.remove();
  const toast = document.createElement("div");
  toast.className = "ui-toast ui-toast--" + tone;
  toast.setAttribute("role", role);
  toast.dataset.bakeryToast = String(id);
  toast.dataset.state = "visible";
  toast.dataset.uiComponent = "toast";
  toast.dataset.variant = tone;
  if (tooltip) toast.title = tooltip;
  toast.style.background = "var(--color-surface, Canvas)";
  const content = document.createElement("div");
  content.className = "ui-toast__content";
  const first = document.createElement("div");
  first.textContent = text;
  content.append(first);
  if (detail) {{
    const second = document.createElement("div");
    second.textContent = detail;
    content.append(second);
  }}
  toast.append(content);
  if (actions.length) {{
    const row = document.createElement("div");
    row.className = "ui-toast__action";
    for (const [label, action] of actions) {{
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ui-button ui-button--secondary";
      b.textContent = label;
      b.addEventListener("click", () => {{ location.href = "{scheme}://" + nonce + "/" + action + "/" + id; }});
      row.append(b);
    }}
    toast.append(row);
  }}
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ui-feedback-dismiss";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());
  toast.append(close);
  host.prepend(toast);
  if (goesAfter) {{
    let timer = null;
    const start = () => {{ clearTimeout(timer); timer = setTimeout(() => toast.remove(), goesAfter * 1000); }};
    const hold = () => clearTimeout(timer);
    toast.addEventListener("mouseenter", hold);
    toast.addEventListener("focusin", hold);
    toast.addEventListener("mouseleave", start);
    toast.addEventListener("focusout", start);
    start();
  }}
}})();"#,
        id = toast.id,
        nonce = quoted(nonce),
        tone = quoted(tone),
        role = quoted(role),
        text = quoted(&toast.text),
        detail = toast
            .detail
            .as_deref()
            .map(quoted)
            .unwrap_or_else(|| "null".into()),
        tooltip = toast
            .tooltip
            .as_deref()
            .map(quoted)
            .unwrap_or_else(|| "null".into()),
        actions = serde_json::Value::Array(actions),
        goes_after = toast.goes_after.unwrap_or(0),
        scheme = ACTION_SCHEME,
    )
}

/// What an action address asks for, when its nonce is the app's: the rule lives in the core, where it
/// is tested.
pub fn parse_action(url: &url::Url, nonce: &str) -> Option<(String, u64)> {
    bakery_desktop_core::links::toast_action(url.as_str(), nonce)
}
