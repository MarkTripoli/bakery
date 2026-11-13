import { readFileSync, writeFileSync } from "node:fs";
const mobileStatus = readFileSync(
  new URL("mobile-status-bar.html", import.meta.url),
  "utf8",
);
import {
  defaultPositions,
  demoWorkflow,
  evaluationCases,
  skillLibrary,
} from "./samples.mjs";
import { icon as rawIcon } from "./icons.mjs";
const esc = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
const C = {
  bg: "var(--color-light-canvas)",
  surface: "var(--color-light-surface)",
  fg: "var(--color-light-fg)",
  muted: "var(--color-light-fg-secondary)",
  border: "var(--color-light-border)",
  strong: "var(--color-light-control)",
  accent: "var(--color-light-accent)",
  selected: "var(--color-light-accent-surface)",
  good: "var(--color-success)",
  bad: "var(--color-destructive)",
};
const ico = (name, size = 18, color = C.fg) =>
  rawIcon(name).replaceAll("currentColor", color).replace(
    'class="icon "',
    `width="${size}" height="${size}" style="width:${size}px;height:${size}px;flex-shrink:0;color:${color};"`,
  );
const tx = (text, size = 13, color = C.fg, weight = 400, extra = "") =>
  `<div style="font-family:Geist,system-ui,sans-serif;font-size:${size}px;line-height:${
    size + 6
  }px;color:${color};font-weight:${weight};${extra}">${esc(text)}</div>`;
const button = (
  text,
  { primary = false, icoName = "", quiet = false, mobile = false } = {},
) =>
  `<div style="display:flex;align-items:center;justify-content:center;gap:7px;min-height:${
    mobile ? 44 : 36
  }px;padding:7px 12px;border:${
    quiet ? "0" : "1px solid " + (primary ? C.fg : C.border)
  };border-radius:4px;background:${
    primary ? C.fg : quiet ? "transparent" : C.surface
  };color:${
    primary ? C.surface : C.fg
  };font-family:Geist,system-ui,sans-serif;font-size:13px;line-height:20px;font-weight:500;flex-shrink:0;">${
    icoName ? ico(icoName, 16, primary ? C.surface : C.fg) : ""
  }${esc(text)}</div>`;
const row = (html, style = "") =>
  `<div style="display:flex;align-items:center;gap:8px;font-family:Geist,system-ui,sans-serif;${style}">${html}</div>`;
const badge = (text) =>
  tx(
    text,
    12,
    C.muted,
    400,
    `padding:2px 7px;background:${C.bg};border-radius:4px;`,
  );
const chunk = (key, parent, html) => ({ key, parent, html });
const gap = '<div style="flex:1;"></div>';
const field = (label, value, mobile = false) =>
  `<div style="display:flex;flex-direction:column;gap:7px;font-family:Geist,system-ui,sans-serif;">${
    tx(label, 13, C.fg, 500)
  }<div style="display:flex;align-items:center;min-height:${
    mobile ? 44 : 40
  }px;border:1px solid ${C.strong};border-radius:4px;padding:9px 11px;font-family:Geist,system-ui,sans-serif;font-size:${
    mobile ? 16 : 13
  }px;line-height:22px;">${esc(value)}</div></div>`;
function pythonCode(phone) {
  const size = phone ? 14 : 13,
    line = phone ? 24 : 23,
    token = (text, color = C.fg) =>
      `<div style="font-family:Geist Mono;font-size:${size}px;line-height:${line}px;white-space:pre;color:${color};">${
        esc(text)
      }</div>`,
    row = (parts) =>
      `<div style="display:flex;height:${line}px;align-items:center;">${
        parts.map(([text, color]) => token(text, color)).join("")
      }</div>`;
  return `<div layer-name="Syntax highlighted Python" style="display:flex;flex:1;flex-direction:column;padding:18px;background:${C.surface};">${
    row([["import", C.accent], [" json, sys"]])
  }<div style="height:${line}px;"></div>${
    row([["data = json.load(sys.stdin)"]])
  }${
    row([["assert", C.accent], [" data.get("], ['"sources"', C.good], ["), "], [
      '"sources are required"',
      C.good,
    ]])
  }${row([["print"], ["("], ['"evidence ok"', C.good], [")"]])}</div>`;
}
function shell(
  key,
  name,
  { phone = false, skills = false, detail = false } = {},
) {
  const w = phone ? 390 : 1440,
    h = phone ? 844 : 900,
    chunks = [],
    b = { key, name, width: w, height: h, chunks },
    selected = skills ? "Skills" : "Workflows";
  chunks.push(
    chunk(
      "root",
      null,
      `<div layer-name="Application" style="display:flex;flex-direction:${
        phone ? "column" : "row"
      };width:${w}px;height:${h}px;background:${C.surface};color:${C.fg};font-family:Geist;font-size:14px;position:relative;overflow:hidden;"></div>`,
    ),
  );
  if (phone) chunks.push(chunk("status", "root", mobileStatus));
  else {
    chunks.push(
      chunk(
        "rail",
        "root",
        `<div layer-name="Application navigation" style="display:flex;flex-direction:column;width:208px;height:900px;flex-shrink:0;background:${C.bg};border-right:1px solid ${C.border};padding:20px 12px 12px;"></div>`,
      ),
    );
    chunks.push(
      chunk(
        "brand",
        "rail",
        row(
          `<img src="paper-asset://~/PersonalDevelopment/bakery/assets/brand/favicon-32.png" style="width:25px;height:25px;"/>${
            tx("Bakery", 18, C.fg, 600)
          }`,
          "gap:10px;padding:0 10px 25px;",
        ),
      ),
    );
    chunks.push(
      chunk(
        "org",
        "rail",
        row(
          `<div style="width:30px;height:30px;border:1px solid ${C.border};background:${C.surface};border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;">P</div><div>${
            tx("Platform team", 13)
          }${tx("Organization", 11, C.muted)}</div>`,
          "padding:10px 8px 20px;",
        ),
      ),
    );
    for (
      const [id, label, ic] of [
        ["work", "Work", "file"],
        ["applications", "Applications", "split"],
        ["sessions", "Sessions", "history"],
        ["machines", "Machines", "agent"],
        ["integrations", "Integrations", "branch"],
        ["workflows", "Workflows", "flow"],
        ["skills", "Skills", "book"],
        ["automations", "Automations", "clock"],
        ["settings", "Settings", "plan"],
      ]
    ) {
      const active = label === selected;
      chunks.push(
        chunk(
          "nav-" + id,
          "rail",
          row(
            ico(ic, 18, active ? C.accent : C.fg) +
              tx(label, 13, active ? C.accent : C.fg, active ? 500 : 400),
            `padding:9px 12px;min-height:38px;border-radius:4px;background:${
              active ? C.selected : "transparent"
            };gap:10px;`,
          ),
        ),
      );
    }
    chunks.push(chunk("rail-fill", "rail", '<div style="flex:1;"></div>'));
    chunks.push(
      chunk(
        "rail-note",
        "rail",
        tx(
          "Interactive design · sample data",
          11,
          C.muted,
          400,
          "padding:8px 10px;",
        ),
      ),
    );
    chunks.push(
      chunk(
        "rail-person",
        "rail",
        row(
          `<div style="width:30px;height:30px;border:1px solid ${C.border};background:${C.surface};border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;">AM</div><div>${
            tx("Alex Morgan", 12)
          }${tx("Personal workspace", 11, C.muted)}</div>`,
          `padding:16px 10px 4px;border-top:1px solid ${C.border};`,
        ),
      ),
    );
  }
  chunks.push(
    chunk(
      "area",
      "root",
      '<div style="display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;"></div>',
    ),
  );
  const listing = key === "workflow-library" || (skills && !detail),
    detailName = detail ? "Research" : skills ? "Skills" : "Issue to delivery",
    trail = phone
      ? ico("menu") + tx(detailName, 14, C.fg, 500)
      : listing
      ? tx(selected, 14, C.fg, 500)
      : tx(selected, 13, C.muted) + tx("/", 13, C.muted) +
        tx(detailName, 14, C.fg, 500);
  chunks.push(
    chunk(
      "header",
      "area",
      row(
        trail + (!skills && !phone ? badge("Draft") : "") + gap +
          (skills ? "" : button("Publish", { primary: true, mobile: phone })) +
          (skills ? "" : ico("dots")),
        `height:${phone ? 60 : 64}px;flex-shrink:0;padding:0 ${
          phone ? 16 : 24
        }px;border-bottom:1px solid ${C.border};gap:10px;`,
      ),
    ),
  );
  chunks.push(
    chunk(
      "body",
      "area",
      `<div style="display:flex;flex:1;min-width:0;min-height:0;flex-direction:${
        phone ? "column" : "row"
      };"></div>`,
    ),
  );
  chunks.push(
    chunk(
      "main",
      "body",
      '<div style="display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;"></div>',
    ),
  );
  return b;
}
function graphBoard(
  key,
  name,
  { panel = null, phone = false, run = false, chatState = "review" } = {},
) {
  const b = shell(key, name, { phone });
  const a = (...args) => b.chunks.push(chunk(...args));
  const panelWidth = panel === "ai" ? 320 : panel ? 336 : 0;
  const cw = (phone ? 390 : 1232) - panelWidth;
  const ch = 794 - (run ? 248 : 0);
  const z = Math.min(1, (cw - 48) / 1160, (ch - 130) / 620);
  const px = (cw - 1160 * z) / 2, py = Math.max(60, (ch - 620 * z) / 2);
  a(
    "tabs",
    "main",
    row(
      row(
        tx("Editor", 12, C.fg, 500) + tx("Runs", 12, C.muted) +
          tx("Evaluations", 12, C.muted),
        "gap:22px;height:46px;",
      ) + gap + (phone ? ico("code") : row(
        ico("check", 13, C.muted) + tx("Saved locally", 12, C.muted) +
          button("JSON", { icoName: "code", quiet: true }) +
          button("Outline", { quiet: true }),
      )),
      "height:46px;flex-shrink:0;padding:0 24px;border-bottom:1px solid " +
        C.border + ";",
    ),
  );
  a(
    "workspace",
    "main",
    `<div style="display:flex;flex:1;min-height:0;position:relative;background:${C.bg};"></div>`,
  );
  if (phone) {
    if (panel === "ai") {
      phoneChat(b, chatState);
      return b;
    }
    a(
      "outline",
      "workspace",
      `<div style="display:flex;flex-direction:column;width:390px;padding:16px;gap:8px;"></div>`,
    );
    a(
      "step-trigger",
      "outline",
      row(
        ico("play", 20) +
          `<div style="flex:1;">${tx("When started", 13, C.fg, 500)}${
            tx("Manual trigger · Workflow input", 12, C.muted)
          }</div>` + ico("chevron"),
        `min-height:66px;padding:12px;background:${C.surface};border:1px solid ${C.border};border-radius:4px;gap:12px;`,
      ),
    );
    demoWorkflow.steps.forEach((s, i) =>
      a(
        "step-" + s.id,
        "outline",
        row(
          tx(String(i + 1), 12, C.muted, 400, "width:20px;flex-shrink:0;") +
            ico(
              s.uses === "rpi.research"
                ? "search"
                : s.uses === "rpi.plan"
                ? "plan"
                : s.repository
                ? "agent"
                : "shield",
            ) +
            `<div style="flex:1;">${tx(s.label, 13, C.fg, 500)}${
              tx(
                (s.repository ? s.repository + " · " : "") + (s.needs?.length
                  ? "After " + s.needs.map((id) =>
                    demoWorkflow.steps.find((n) => n.id === id)?.label || id
                  ).join(" + ")
                  : "Workflow input"),
                12,
                C.muted,
              )
            }</div>` + ico("chevron"),
          `min-height:66px;padding:12px;background:${C.surface};border:1px solid ${C.border};border-radius:4px;gap:12px;`,
        ),
      )
    );
    a(
      "phone-actions",
      "outline",
      row(
        button("Add step", { icoName: "plus", mobile: true }) + gap +
          button("Ask Bakery", { icoName: "agent", mobile: true }),
        "padding-top:12px;",
      ),
    );
    return b;
  }
  a(
    "canvas",
    "workspace",
    `<div layer-name="Workflow canvas" style="display:flex;flex:1;position:relative;overflow:hidden;background:${C.bg};"></div>`,
  );
  a(
    "dots",
    "canvas",
    `<svg style="position:absolute;left:0;top:0;width:${cw}px;height:${ch}px;" width="${cw}" height="${ch}" viewBox="0 0 ${cw} ${ch}"><path d="${
      Array.from(
        { length: Math.ceil(ch / 20) },
        (_, i) => "M10 " + (10 + i * 20) + " H" + cw,
      ).join(" ")
    }" fill="none" stroke="#D6DBE2" stroke-width="1.5" stroke-dasharray="1 19" stroke-linecap="round"/></svg>`,
  );
  a(
    "canvas-top",
    "canvas",
    row(
      tx("6 steps · 2 repositories", 12, C.muted) + gap +
        button("Add step", { icoName: "plus" }),
      "position:absolute;top:20px;left:20px;right:20px;",
    ),
  );
  a(
    "scene",
    "canvas",
    `<div layer-name="Connected workflow" style="display:flex;position:absolute;left:${px}px;top:${py}px;width:1160px;height:640px;"></div>`,
  );
  const p = defaultPositions;
  const links = [
    ["trigger", "research", 72],
    ["research", "plan", 72],
    ["plan", "backend", 72],
    ["plan", "frontend", 72],
    ["backend", "checks", 168],
    ["frontend", "checks", 168],
    ["checks", "review", 72],
  ];
  for (const [from, to, w] of links) {
    const x = p[from].x + w,
      y = p[from].y + 36,
      x2 = p[to].x,
      y2 = p[to].y + 36,
      d = Math.max(35, Math.abs(x2 - x) * .48);
    a(
      "wire-" + from + "-" + to,
      "scene",
      `<svg style="position:absolute;left:0;top:0;width:1160px;height:640px;" width="1160" height="640" viewBox="0 0 1160 640"><path d="M${x} ${y} C${
        x + d
      } ${y},${
        x2 - d
      } ${y2},${x2} ${y2}" fill="none" stroke="#8792A1" stroke-width="1.5"/><path d="M${
        x2 - 6
      } ${y2 - 3} L${x2} ${y2} L${x2 - 6} ${
        y2 + 3
      }" fill="none" stroke="#8792A1" stroke-width="1.5"/></svg>`,
    );
  }
  const ns = [
    {
      id: "trigger",
      label: "When started",
      icon: "play",
      sub: "Manual trigger",
    },
    ...demoWorkflow.steps.map((s) => ({
      ...s,
      icon: s.uses === "rpi.research"
        ? "search"
        : s.uses === "rpi.plan"
        ? "plan"
        : s.repository
        ? "agent"
        : s.id === "checks"
        ? "check"
        : "shield",
      sub: s.repository || s.skillRevision?.split("-")[0] ||
        "All required candidates",
    })),
  ];
  for (const s of ns) {
    const w = s.repository ? 168 : 72;
    const selected = (panel === "setup" || panel === "ai") &&
      s.id === "backend";
    a(
      "node-" + s.id,
      "scene",
      `<div layer-name="${esc(s.label)}" style="position:absolute;left:${
        p[s.id].x
      }px;top:${p[s.id].y}px;width:${w}px;height:72px;border:1.5px solid ${
        selected ? C.accent : C.strong
      };border-radius:${
        s.id === "trigger" ? "24px 8px 8px 24px" : "8px"
      };background:${C.surface};display:flex;align-items:center;justify-content:${
        s.repository ? "flex-start" : "center"
      };gap:10px;padding:${s.repository ? "0 14px" : "0"};">${
        ico(
          s.icon,
          s.repository ? 25 : 30,
          s.id === "trigger"
            ? "var(--color-warning)"
            : s.repository
            ? C.fg
            : C.accent,
        )
      }${s.repository ? tx(s.label, 13, C.fg, 500) : ""}</div>`,
    );
    if (s.id !== "trigger") {
      a(
        "in-" + s.id,
        "scene",
        `<div style="position:absolute;left:${p[s.id].x - 5}px;top:${
          p[s.id].y + 31
        }px;width:10px;height:10px;background:${C.surface};border:1.5px solid #8792A1;border-radius:50%;"></div>`,
      );
    }
    a(
      "out-" + s.id,
      "scene",
      `<div style="position:absolute;left:${p[s.id].x + w - 5}px;top:${
        p[s.id].y + 31
      }px;width:10px;height:10px;background:${C.surface};border:1.5px solid #8792A1;border-radius:50%;"></div>`,
    );
    a(
      "label-" + s.id,
      "scene",
      `<div style="position:absolute;left:${p[s.id].x + w / 2 - 90}px;top:${
        p[s.id].y + 82
      }px;width:180px;text-align:center;display:flex;flex-direction:column;gap:3px;">${
        s.repository ? "" : tx(s.label, 13, C.fg, 500)
      }${tx(s.sub, 11, C.muted)}</div>`,
    );
    if (s.repository) {
      a(
        "skill-link-" + s.id,
        "scene",
        `<div style="position:absolute;left:${p[s.id].x + 84}px;top:${
          p[s.id].y + 104
        }px;height:26px;border-left:1px dashed #8792A1;"></div>`,
      );
      a(
        "skill-" + s.id,
        "scene",
        `<div style="position:absolute;left:${p[s.id].x + 28}px;top:${
          p[s.id].y + 130
        }px;width:112px;display:flex;align-items:center;flex-direction:column;gap:5px;"><div style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;border:1px solid ${C.strong};border-radius:50%;background:${C.surface};">${
          ico("book", 18, C.muted)
        }</div>${tx("Implementation skill", 10, C.muted)}</div>`,
      );
    }
  }
  a(
    "terminal",
    "scene",
    `<div style="position:absolute;left:1080px;top:262px;width:28px;height:28px;border:1px solid ${C.strong};border-radius:4px;background:${C.surface};display:flex;align-items:center;justify-content:center;">${
      ico("plus", 13)
    }</div>`,
  );
  a(
    "canvas-hint",
    "canvas",
    tx(
      "Drag to move · Scroll to pan · ⌘/Ctrl + scroll to zoom",
      11,
      C.muted,
      400,
      "position:absolute;left:20px;bottom:70px;",
    ),
  );
  a(
    "canvas-bottom",
    "canvas",
    row(
      row(
        ico("minus", 16) + tx(Math.round(z * 100) + "%", 11, C.muted) +
          ico("plus", 16) + ico("fit", 16) + ico("undo", 16),
        `border:1px solid ${C.border};border-radius:6px;padding:10px;background:${C.surface};gap:13px;`,
      ) + gap + button("Test workflow", { primary: true, icoName: "play" }) +
        (panel === "ai"
          ? ""
          : gap + button("Ask Bakery", { icoName: "agent" })),
      "position:absolute;left:20px;right:20px;bottom:20px;",
    ),
  );
  if (z !== 1) {
    for (const c of b.chunks.filter((c) => c.parent === "scene")) {
      c.html = c.html.replace(
        /(-?\d+(?:\.\d+)?)px/g,
        (_, n) => (Number(n) * z).toFixed(2) + "px",
      );
    }
  }
  if (panel) {
    a(
      "panel",
      "workspace",
      `<div style="display:flex;flex-direction:column;width:336px;flex-shrink:0;border-left:1px solid ${C.border};background:${C.surface};"></div>`,
    );
    if (panel === "ai") {
      const c = b.chunks.find((c) => c.key === "panel");
      c.html = c.html.replace("width:336px", "width:320px").replace(
        "border-left",
        "border-right",
      );
      b.chunks.splice(b.chunks.indexOf(c), 1);
      b.chunks.splice(b.chunks.findIndex((c) => c.key === "canvas"), 0, c);
      desktopChat(b, chatState);
    }
    if (panel === "setup") setup(b);
    if (panel === "json") source(b);
  }
  if (
    panel === "picker"
  ) { /* picker is drawn as a contextual overlay in its own canvas group */ }
  if (run) runDrawer(b);
  return b;
}
function desktopChat(b, state = "review", phone = false) {
  const a = (...args) => b.chunks.push(chunk(...args)), font = phone ? 16 : 13;
  a(
    "ai-head",
    "panel",
    row(
      `<img src="paper-asset://~/PersonalDevelopment/bakery/assets/brand/favicon-32.png" style="width:20px;height:20px;"/>` +
        tx("Build with Bakery", 14, C.fg, 500) + gap + ico("dots") +
        ico("close"),
      `min-height:${
        phone ? 52 : 56
      }px;padding:10px 16px;border-bottom:1px solid ${C.border};`,
    ),
  );
  a(
    "ai-context",
    "panel",
    row(
      ico("flow", 14) + tx("Issue to delivery", 12) + gap + badge("Draft"),
      `padding:10px 16px;border-bottom:1px solid ${C.border};`,
    ),
  );
  a(
    "ai-body",
    "panel",
    `<div style="display:flex;flex-direction:column;padding:20px 16px;gap:${
      state === "auto" ? 12 : 20
    }px;flex:1;"></div>`,
  );
  if (state === "intro") {
    a(
      "intro",
      "ai-body",
      tx("Let’s build it together.", phone ? 20 : 18, C.fg, 600),
    );
    a(
      "welcome",
      "ai-body",
      tx(
        "Tell me what should happen. I’ll find the skills and connect the steps.",
        font,
        C.muted,
      ),
    );
    for (
      const [i, text] of [
        "Research an issue, then make a plan",
        "Explain this workflow",
        "Add an independent review",
      ].entries()
    ) {
      a(
        "prompt-" + i,
        "ai-body",
        row(
          tx(text, phone ? 15 : 13) + gap + ico("chevron"),
          `min-height:52px;border-bottom:1px solid ${C.border};`,
        ),
      );
    }
  } else {
    a(
      "ai-person",
      "ai-body",
      `<div style="display:flex;flex-direction:column;gap:6px;background:${C.bg};border-radius:6px;padding:10px 12px;">${
        row(tx("You", 12, C.fg, 500) + gap + tx("Sep 8, 9:41 AM", 10, C.muted))
      }${tx("Give Build the API up to 60 minutes.", font)}</div>`,
    );
    a(
      "ai-response",
      "ai-body",
      `<div style="display:flex;flex-direction:column;gap:8px;">${
        row(
          ico("agent", 16) + tx("Bakery", 12, C.fg, 500) + gap +
            tx("Sep 8, 9:41 AM", 10, C.muted),
        )
      }${
        tx(
          state === "auto"
            ? "Done — the draft is updated. You can inspect the steps or keep building with me."
            : "I’ll give Build the API up to 60 minutes.",
          font,
        )
      }</div>`,
    );
    a(
      "ai-proposal",
      "ai-body",
      `<div style="display:flex;flex-direction:column;gap:12px;"></div>`,
    );
    a(
      "proposal-heading",
      "ai-proposal",
      row(
        ico(state === "auto" ? "check" : "flow", 16) +
          tx(
            state === "auto" ? "1 draft change" : "Review draft changes",
            13,
            C.fg,
            500,
          ),
      ),
    );
    a(
      "proposal-change",
      "ai-proposal",
      row(
        tx("Update", 12, C.muted, 400, "width:44px;flex-shrink:0;") +
          `<div>${tx("Build the API", phone ? 14 : 13, C.fg, 500)}${
            tx("Timeout: 2h → 60m", phone ? 13 : 12, C.muted)
          }</div>`,
        `padding:12px 0;align-items:flex-start;border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};`,
      ),
    );
    if (state === "auto") {
      a("ai-next", "ai-body", tx("Ready for a closer look?", font, C.muted));
      a(
        "ai-test",
        "ai-body",
        button("Inspect example output", {
          icoName: "play",
          quiet: true,
          mobile: phone,
        }),
      );
      a(
        "ai-undo",
        "ai-body",
        button("Undo last change", {
          icoName: "undo",
          quiet: true,
          mobile: phone,
        }),
      );
      a(
        "ai-checkpoint",
        "ai-body",
        row(
          ico("clock", 14) + "<div>" + tx("Checkpoint · 6 steps", 12, C.muted) +
            tx("Sep 8, 9:40 AM", 10, C.muted) + "</div>" + gap +
            button("Compare", { quiet: true, mobile: phone }),
          `padding-top:12px;border-top:1px solid ${C.border};`,
        ),
      );
    } else {
      a(
        "proposal-help",
        "ai-proposal",
        tx(
          "Your workflow stays as it is until you apply.",
          phone ? 13 : 12,
          C.muted,
        ),
      );
      a(
        "proposal-actions",
        "ai-proposal",
        row(
          button("Apply changes", { primary: true, mobile: phone }) +
            button("Discard", { quiet: true, mobile: phone }),
        ),
      );
    }
  }
  a(
    "composer-wrap",
    "panel",
    '<div style="display:flex;padding:0 16px;"></div>',
  );
  a(
    "composer",
    "composer-wrap",
    `<div style="display:flex;flex-direction:column;width:100%;border:1px solid ${C.strong};border-radius:20px;padding:12px;gap:8px;"></div>`,
  );
  if (state !== "intro") {
    a(
      "composer-context",
      "composer",
      row(
        tx("About Build the API", 12, C.muted) + gap + ico("close", 14),
        "min-height:28px;",
      ),
    );
  }
  a(
    "composer-input",
    "composer",
    tx(
      "Describe what you’d like to change…",
      phone ? 16 : 14,
      C.muted,
      400,
      "min-height:60px;",
    ),
  );
  a(
    "composer-controls",
    "composer",
    row(
      tx(
        state === "auto" ? "Auto-build draft" : "Ask before editing",
        phone ? 14 : 12,
      ) + ico("down", 14) + gap +
        `<div style="display:flex;align-items:center;justify-content:center;width:${
          phone ? 44 : 32
        }px;height:${
          phone ? 44 : 32
        }px;border-radius:50%;background:${C.fg};">${
          ico("send", 16, C.surface)
        }</div>`,
    ),
  );
  a(
    "composer-help",
    "panel",
    tx(
      state === "auto"
        ? "Edits this draft. Each change can be undone."
        : "Review each proposed edit before it is applied.",
      phone ? 12 : 11,
      C.muted,
      400,
      "padding:7px 20px 0;",
    ),
  );
  a(
    "ai-example",
    "panel",
    tx(
      "Interactive example · no cloud agent connected",
      phone ? 12 : 11,
      C.muted,
      400,
      "padding:3px 20px 16px;",
    ),
  );
}
function phoneChat(b, state = "intro") {
  b.chunks.push(
    chunk(
      "panel",
      "workspace",
      `<div style="display:flex;flex-direction:column;width:390px;min-height:679px;flex:1;background:${C.surface};"></div>`,
    ),
  );
  desktopChat(b, state, true);
}
function setup(b) {
  const a = (...args) => b.chunks.push(chunk(...args));
  a(
    "setup-head",
    "panel",
    row(
      ico("agent") + tx("Build the API", 14, C.fg, 500) + gap + ico("close"),
      `padding:16px 20px;border-bottom:1px solid ${C.border};`,
    ),
  );
  a(
    "setup-body",
    "panel",
    `<div style="display:flex;flex-direction:column;padding:20px;gap:24px;flex:1;"></div>`,
  );
  a(
    "setup-state",
    "setup-body",
    row(badge("Setup") + tx("backend repository", 12, C.muted)),
  );
  a("setup-name", "setup-body", field("Step name", "Build the API"));
  a(
    "setup-skill",
    "setup-body",
    `<div style="display:flex;flex-direction:column;gap:10px;">${
      tx("Skill", 12, C.muted)
    }${
      row(
        ico("book") +
          `<div>${tx("Implementation", 13, C.fg, 500)}${
            tx("Global · v1.0", 12, C.muted)
          }</div>` + gap + ico("chevron"),
      )
    }</div>`,
  );
  a(
    "setup-input",
    "setup-body",
    field("Use output from", "Create a plan → result"),
  );
  a(
    "setup-waits",
    "setup-body",
    `<div>${tx("Waits for", 12, C.muted)}${tx("Create a plan", 13)}</div>`,
  );
  a(
    "setup-advanced",
    "setup-body",
    row(tx("Agent & advanced settings", 13, C.muted) + gap + ico("down")),
  );
  a(
    "setup-help",
    "setup-body",
    button("Ask Bakery about this step", { icoName: "agent", quiet: true }),
  );
  a(
    "setup-foot",
    "panel",
    row(
      button("Test step", { primary: true, icoName: "play" }) +
        tx("Example output", 12, C.muted),
      `padding:16px 20px;border-top:1px solid ${C.border};`,
    ),
  );
}
function source(b) {
  const a = (...args) => b.chunks.push(chunk(...args));
  a(
    "json-head",
    "panel",
    row(
      tx("workflow.json", 14, C.fg, 500) + gap +
        button("Format", { quiet: true }) + ico("close"),
      `padding:16px;border-bottom:1px solid ${C.border};`,
    ),
  );
  a(
    "json-code",
    "panel",
    `<pre style="font-family:Geist Mono;font-size:12px;line-height:22px;white-space:pre-wrap;padding:20px;background:${C.bg};flex:1;">${
      esc(JSON.stringify(
        {
          id: "backend",
          label: "Build the API",
          repository: "backend",
          uses: "harness.implement",
          skillRevision: "implementation-v1",
          needs: ["plan"],
          with: { planArtifact: "$step.plan.artifact" },
          timeout: "2h",
        },
        null,
        2,
      ))
    }</pre>`,
  );
  a(
    "json-state",
    "panel",
    tx(
      "In sync · local validation passed",
      12,
      C.good,
      400,
      `padding:16px;border-top:1px solid ${C.border};`,
    ),
  );
  a(
    "json-foot",
    "panel",
    row(
      button("Restore valid", { quiet: true }) +
        button("Export JSON", { quiet: true }),
      "padding:12px;",
    ),
  );
}
function runDrawer(b) {
  const a = (...args) => b.chunks.push(chunk(...args));
  a(
    "run",
    "main",
    `<div style="min-height:248px;flex-shrink:0;display:flex;flex-direction:column;background:${C.surface};border-top:1px solid ${C.border};"></div>`,
  );
  a(
    "run-head",
    "run",
    row(
      tx("Example execution", 12, C.fg, 500) + badge("Sample data") +
        tx("Inspect a step’s input and output", 12, C.muted) + gap +
        ico("close"),
      `padding:12px 20px;border-bottom:1px solid ${C.border};`,
    ),
  );
  a("run-columns", "run", `<div style="display:flex;flex:1;"></div>`);
  a(
    "run-list",
    "run-columns",
    `<div style="width:220px;flex-shrink:0;display:flex;flex-direction:column;padding:12px;gap:8px;border-right:1px solid ${C.border};"></div>`,
  );
  demoWorkflow.steps.forEach((s) =>
    a(
      "run-" + s.id,
      "run-list",
      row(
        ico("check", 13, C.good) + tx(s.label, 12),
        s.id === "research"
          ? `padding:6px;background:${C.selected};border-radius:4px;`
          : "padding:4px 6px;",
      ),
    )
  );
  a(
    "run-input",
    "run-columns",
    `<div style="display:flex;flex-direction:column;gap:12px;padding:18px 20px;width:40%;border-right:1px solid ${C.border};">${
      tx("INPUT · RESEARCH ISSUE", 11, C.muted)
    }<pre style="font-family:Geist Mono;font-size:12px;line-height:22px;">${
      esc('{\n  "taskId": "$input.taskId"\n}')
    }</pre></div>`,
  );
  a(
    "run-output",
    "run-columns",
    `<div style="display:flex;flex-direction:column;gap:12px;padding:18px 20px;flex:1;">${
      tx("OUTPUT · EXAMPLE", 11, C.muted)
    }${
      tx(
        "Found the affected web and API modules. A shared contract is needed before implementation.",
        13,
      )
    }${tx("Sample fixture; no step was executed.", 12, C.muted)}</div>`,
  );
}
function skillsBoard(
  key,
  name,
  { phone = false, detail = false, evaluation = false, cases = false } = {},
) {
  const b = shell(key, name, { phone, skills: true, detail });
  const a = (...args) => b.chunks.push(chunk(...args));
  a(
    "content",
    "main",
    `<div style="display:flex;flex-direction:column;padding:${
      phone ? "24px 16px" : "36px 40px"
    };gap:16px;flex:1;"></div>`,
  );
  if (phone && detail) {
    a(
      "back-skills",
      "content",
      row(ico("back") + tx("Back to Skills", 13, C.muted), "min-height:44px;"),
    );
  }
  a(
    "heading",
    "content",
    row(
      `<div style="flex:1;">${
        tx(detail ? "Research" : "Skills", phone ? 22 : 20, C.fg, 600)
      }${
        tx(
          detail
            ? "Global · Version 1.0 · Maintained by Bakery"
            : "The instructions behind great work.",
          13,
          C.muted,
          400,
          "padding-top:7px;",
        )
      }</div>` +
        button(detail ? "Create a copy" : "New skill", {
          primary: true,
          icoName: detail ? "copy" : "plus",
          mobile: phone,
        }),
      "align-items:flex-start;",
    ),
  );
  if (!detail) {
    a(
      "filters",
      "content",
      row(
        ["All skills", "Global", "Organization", "My skills"].map((t, i) =>
          `<div style="padding:${phone ? "10px 7px" : "8px 12px"};font-size:${
            phone ? 12 : 13
          }px;color:${i ? C.fg : C.accent};background:${
            i ? "transparent" : C.selected
          };border-radius:4px;">${t}</div>`
        ).join(""),
      ),
    );
    a(
      "columns",
      "content",
      row(
        tx("Skill", 12, C.muted, 400, "flex:1;") +
          (phone ? "" : tx("Scope", 12, C.muted, 400, "width:140px;") +
            tx("Version", 12, C.muted, 400, "width:100px;") +
            tx("Evaluation", 12, C.muted, 400, "width:140px;")) +
          tx("Status", 12, C.muted, 400, "width:85px;text-align:right;"),
        `padding-bottom:10px;border-bottom:1px solid ${C.border};`,
      ),
    );
    skillLibrary.slice(0, phone ? 6 : 8).forEach((s, i) =>
      a(
        "skill-row-" + i,
        "content",
        row(
          `<div style="width:34px;height:34px;border:1px solid ${C.border};border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${
            ico("book", 17, C.muted)
          }</div><div style="flex:1;min-width:0;">${
            tx(s.title, 13, C.fg, 500)
          }${
            tx(
              phone
                ? (s.scope === "global"
                  ? "Global"
                  : s.scope === "user"
                  ? "My skills"
                  : "Organization") + " · v" + s.version
                : s.description,
              phone ? 11 : 12,
              C.muted,
              400,
              "padding-top:4px;",
            )
          }${
            phone
              ? tx(
                i === 0 ? "1 regression" : "Not evaluated",
                11,
                i === 0 ? "var(--color-warning)" : C.muted,
                400,
                "padding-top:3px;",
              )
              : ""
          }</div>` + (phone ? "" : tx(
            s.scope === "global"
              ? "Global"
              : s.scope === "user"
              ? "My skills"
              : "Organization",
            13,
            C.fg,
            400,
            "width:140px;",
          ) +
            tx(
              s.status === "Draft" ? "—" : "v" + s.version,
              13,
              C.fg,
              400,
              "width:100px;",
            ) +
            tx(
              i === 0 ? "1 regression" : "Not evaluated",
              12,
              i === 0 ? "var(--color-warning)" : C.muted,
              400,
              "width:140px;",
            )) +
            `<div style="width:85px;display:flex;justify-content:flex-end;">${
              badge(s.status)
            }</div>`,
          `min-height:${
            phone ? 62 : 60
          }px;padding-bottom:12px;border-bottom:1px solid ${C.border};gap:12px;`,
        ),
      )
    );
    return b;
  }
  a(
    "detail-tabs",
    "content",
    row(
      ["Files", "Test cases", "Evaluations", "Versions"].map((t) =>
        tx(
          t,
          phone ? 12 : 13,
          ((evaluation && t === "Evaluations") ||
              (cases && t === "Test cases") ||
              (!evaluation && !cases && t === "Files"))
            ? C.fg
            : C.muted,
          400,
          "padding:10px 0;",
        )
      ).join(""),
      `gap:${phone ? 20 : 24}px;border-bottom:1px solid ${C.border};`,
    ),
  );
  if (evaluation) {
    evaluationBody(b, phone);
    return b;
  }
  if (cases) {
    a(
      "case-intro",
      "content",
      row(
        `<div style="flex:1;">${tx("Research quality", 16, C.fg, 600)}${
          tx(
            "Versioned examples that define what good looks like.",
            13,
            C.muted,
          )
        }</div>` + button("Add test case", { icoName: "plus" }),
      ),
    );
    evaluationCases.forEach((c, i) =>
      a(
        "case-" + i,
        "content",
        `<div style="display:flex;flex-direction:column;gap:5px;padding-bottom:14px;border-bottom:1px solid ${C.border};">${
          tx(c.name, 13, C.fg, 500)
        }${tx(c.input, 12, C.muted)}${tx(c.expected, 13)}</div>`,
      )
    );
    return b;
  }
  const files = skillLibrary[0].files,
    selected = files.find((file) => file.path.endsWith(".py")),
    folders = [
      ...new Set(files.flatMap((file) => {
        const parts = file.path.split("/");
        return parts.slice(0, -1).map((_, index) =>
          parts.slice(0, index + 1).join("/")
        );
      })),
    ];
  a(
    "package",
    "content",
    `<div style="display:flex;flex-direction:${
      phone ? "column" : "row"
    };min-height:${
      phone ? 540 : 500
    }px;border:1px solid ${C.border};border-radius:6px;overflow:hidden;"></div>`,
  );
  a(
    "file-tree",
    "package",
    `<div style="display:flex;flex-direction:column;width:${
      phone ? "100%" : "220px"
    };${
      phone ? "height:300px;overflow:hidden;" : "flex-shrink:0;"
    }background:${C.bg};border-${
      phone ? "bottom" : "right"
    }:1px solid ${C.border};"></div>`,
  );
  a(
    "file-tree-head",
    "file-tree",
    row(
      `<div style="flex:1;">${tx("Files", 13, C.fg, 600)}${
        tx(files.length + " files", 12, C.muted)
      }</div>`,
      `min-height:64px;padding:14px 16px;border-bottom:1px solid ${C.border};`,
    ),
  );
  const desktopTree = folders.map((folder) => {
    const depth = folder.split("/").length - 1;
    return row(
      ico("down", 12, C.muted) + tx(folder.split("/").at(-1), 12, C.muted),
      `min-height:28px;padding:4px 8px 4px ${8 + depth * 14}px;`,
    ) + files.filter((file) =>
      file.path.slice(0, file.path.lastIndexOf("/")) === folder
    ).map((file) =>
      row(
        ico(
          file.language === "markdown" ? "book" : "file",
          14,
          file === selected ? C.accent : C.muted,
        ) +
          tx(
            file.path.split("/").at(-1),
            12,
            file === selected ? C.accent : C.fg,
            400,
            "font-family:Geist Mono;",
          ) + gap + (file.executable
            ? `<div style="width:6px;height:6px;border-radius:50%;background:${C.good};"></div>`
            : ""),
        `min-height:32px;padding:5px 8px 5px ${
          24 + depth * 14
        }px;border-radius:4px;background:${
          file === selected ? C.selected : "transparent"
        };`,
      )
    ).join("");
  }).join("") + files.filter((file) =>
    !file.path.includes("/")
  ).map((file) =>
    row(
      ico("book", 14, C.muted) +
        tx(file.path, 12, C.fg, 400, "font-family:Geist Mono;"),
      "min-height:32px;padding:5px 8px;",
    )
  ).join("");
  const mobileTree = ["guides", "references", "scripts"].map((folder) =>
    row(
      ico(folder === "scripts" ? "down" : "chevron", 12, C.muted) +
        tx(folder, 12, C.muted),
      `min-height:36px;padding:5px 8px;`,
    )
  ).join("") +
    row(
      ico("file", 14, C.accent) +
        tx(
          selected.path.split("/").at(-1),
          12,
          C.accent,
          400,
          "font-family:Geist Mono;",
        ) + gap +
        `<div style="width:6px;height:6px;border-radius:50%;background:${C.good};"></div>`,
      `min-height:38px;padding:5px 8px 5px 24px;border-radius:4px;background:${C.selected};`,
    ) +
    row(
      ico("file", 14, C.muted) +
        tx("normalize.mjs", 12, C.fg, 400, "font-family:Geist Mono;") + gap +
        `<div style="width:6px;height:6px;border-radius:50%;background:${C.good};"></div>`,
      "min-height:36px;padding:5px 8px 5px 24px;",
    ) +
    row(
      ico("book", 14, C.muted) +
        tx("SKILL.md", 12, C.fg, 400, "font-family:Geist Mono;"),
      "min-height:36px;padding:5px 8px;",
    );
  a(
    "file-list",
    "file-tree",
    `<div style="display:flex;flex-direction:column;padding:8px;gap:2px;overflow:hidden;">${
      phone ? mobileTree : desktopTree
    }</div>`,
  );
  a(
    "file-editor",
    "package",
    '<div style="display:flex;flex:1;min-width:0;flex-direction:column;"></div>',
  );
  a(
    "file-editor-head",
    "file-editor",
    row(
      `<div style="flex:1;">${tx(selected.path, 13, C.fg, 600)}${
        tx("Python · runnable", 12, C.muted)
      }</div>` +
        button("Run sample", { icoName: "play", quiet: true, mobile: phone }),
      `min-height:64px;padding:14px 16px;border-bottom:1px solid ${C.border};`,
    ),
  );
  a("file-source", "file-editor", pythonCode(phone));
  a(
    "file-state",
    "file-editor",
    tx(
      "Create a copy to edit this package. Published workflows stay pinned.",
      12,
      C.muted,
      400,
      `padding:11px 16px;border-top:1px solid ${C.border};`,
    ),
  );
  a(
    "runtime-rule",
    "content",
    tx(
      "Runnable allowlist: JavaScript (.js/.mjs) and Python (.py) in a pinned isolated runtime. Other package files remain inert.",
      12,
      C.muted,
      400,
      `padding:12px 14px;background:${C.bg};border:1px solid ${C.border};border-radius:6px;`,
    ),
  );
  return b;
}
function evaluationBody(b, phone) {
  const a = (...args) => b.chunks.push(chunk(...args));
  a(
    "evaluation-head",
    "content",
    row(
      `<div style="flex:1;">${
        tx("Research evaluations", phone ? 18 : 20, C.fg, 600)
      }${tx("Compare versions on the same cases.", 13, C.muted)}</div>` +
        button(phone ? "Run" : "Run evaluation", {
          primary: true,
          icoName: "play",
          mobile: phone,
        }),
    ),
  );
  a(
    "example",
    "content",
    `<div style="display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:1px solid ${C.border};border-radius:6px;background:${C.bg};">${
      tx("Example evaluation · Research quality v2", 13, C.fg, 500)
    }${tx("6 cases · Mock tools · Illustrative results", 12, C.muted)}</div>`,
  );
  a(
    "stats",
    "content",
    row(
      [["3", "Passed", C.good], ["1", "Failed", C.bad], ["1", "Error", C.fg], [
        "1",
        "Not scored",
        C.fg,
      ]].map(([n, l, c]) =>
        row(tx(n, 20, c, 500) + tx(l, 12, C.muted), "gap:6px;")
      ).join(""),
      `gap:${
        phone ? 14 : 32
      }px;padding-bottom:16px;border-bottom:1px solid ${C.border};`,
    ),
  );
  a(
    "comparison",
    "content",
    row(
      badge("Baseline · example v1") + tx("→", 13, C.muted) +
        badge("Candidate · example v2") + gap + tx("All results", 12, C.muted),
    ),
  );
  a(
    "eval-columns",
    "content",
    row(
      tx("Test case", 12, C.muted, 400, "flex:1;") +
        (phone ? "" : tx("Baseline", 12, C.muted, 400, "width:120px;") +
          tx("Candidate", 12, C.muted, 400, "width:120px;") +
          tx("Change", 12, C.muted, 400, "width:120px;")) +
        tx("Result", 12, C.muted, 400, "width:85px;text-align:right;"),
      `border-bottom:1px solid ${C.border};padding-bottom:10px;`,
    ),
  );
  evaluationCases.forEach((c, i) =>
    a(
      "eval-" + i,
      "content",
      row(
        `<div style="flex:1;">${tx(c.name, 13, C.fg, 500)}${
          phone
            ? tx(
              c.baseline.toFixed(2) + " → " +
                (c.score === null ? "—" : c.score.toFixed(2)) + " · " +
                (c.score === null
                  ? "Not measured"
                  : (c.score >= c.baseline ? "+" : "") +
                    (c.score - c.baseline).toFixed(2)),
              11,
              C.muted,
            )
            : ""
        }</div>` +
          (phone
            ? ""
            : tx(c.baseline.toFixed(2), 13, C.fg, 400, "width:120px;") +
              tx(
                c.score === null ? "—" : c.score.toFixed(2),
                13,
                C.fg,
                400,
                "width:120px;",
              ) + tx(
                c.score === null
                  ? "Not measured"
                  : (c.score >= c.baseline ? "+" : "") +
                    (c.score - c.baseline).toFixed(2),
                12,
                c.score === null
                  ? C.muted
                  : c.score < c.baseline
                  ? C.bad
                  : C.good,
                400,
                "width:120px;",
              )) +
          tx(
            c.status,
            12,
            c.status === "Passed"
              ? C.good
              : c.status === "Failed"
              ? C.bad
              : C.muted,
            400,
            "width:85px;text-align:right;",
          ),
        `min-height:34px;padding-bottom:10px;border-bottom:1px solid ${C.border};`,
      ),
    )
  );
  if (!phone) {
    a(
      "finding",
      "content",
      `<div style="display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid ${C.border};border-radius:6px;background:${C.bg};">${
        tx("Missing evidence · Regression", 13, C.bad, 500)
      }${
        tx(
          "The candidate claims a likely cause without supporting evidence. The rubric requires uncertainty and a request for the missing reproduction.",
          13,
        )
      }</div>`,
    );
  }
  a(
    "coverage",
    "content",
    tx(
      "4 of 6 cases scored. Errors and unscored cases are not passing quality results.",
      12,
      C.muted,
    ),
  );
}
function workflowLibrary() {
  const b = shell("workflow-library", "15 · Workflow library");
  const a = (...args) => b.chunks.push(chunk(...args));
  const lane = (text, width, color = C.fg, weight = 400) =>
    tx(text, 12, color, weight, `width:${width}px;flex-shrink:0;`);
  const workflowRow = (
    name,
    description,
    source,
    status,
    version,
    steps,
    iconName,
  ) =>
    row(
      `<div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;"><div style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;flex-shrink:0;border:1px solid ${C.border};border-radius:6px;">${
        ico(iconName, 18, C.muted)
      }</div><div style="min-width:0;">${tx(name, 13, C.fg, 500)}${
        tx(description, 12, C.muted, 400, "padding-top:4px;")
      }</div></div>` +
        `<div style="width:112px;flex-shrink:0;">${
          row(
            (source === "Bakery" ? ico("lock", 13, C.muted) : "") +
              tx(source, 12, C.fg),
            "gap:5px;",
          )
        }</div>` + `<div style="width:86px;flex-shrink:0;">${
        status === "Ready"
          ? tx(
            status,
            12,
            C.good,
            400,
            "padding:2px 7px;background:var(--color-success-surface);border-radius:4px;",
          )
          : badge(status)
      }</div>` + lane(version, 70) + lane(String(steps), 48) +
        `<div style="width:126px;display:flex;justify-content:flex-end;flex-shrink:0;gap:2px;">${
          button(source === "Bakery" ? "View" : "Open", { quiet: true })
        }${button("Copy", { quiet: true })}</div>`,
      `min-height:70px;padding:10px 16px;border-bottom:1px solid ${C.border};gap:12px;`,
    );
  a(
    "library-content",
    "main",
    `<div style="display:flex;flex-direction:column;padding:36px 40px;gap:0;"></div>`,
  );
  a(
    "library-title",
    "library-content",
    row(
      `<div style="flex:1;">${
        tx(
          "Workflows",
          28,
          C.fg,
          600,
          "line-height:36px;letter-spacing:-0.02em;",
        )
      }${
        tx(
          "Build once. Put your skills to work together.",
          14,
          C.muted,
          400,
          "padding-top:6px;",
        )
      }</div>` + button("Import", { icoName: "file" }) +
        button("New workflow", { primary: true, icoName: "plus" }),
      "align-items:flex-start;padding-bottom:22px;",
    ),
  );
  const sourceTabs = row(
    `<div style="display:flex;align-items:center;gap:5px;height:40px;border-bottom:2px solid ${C.fg};">${
      tx("All workflows", 13, C.fg, 500)
    }${
      tx("5", 12, C.muted)
    }</div><div style="display:flex;align-items:center;gap:5px;height:40px;">${
      tx("Organization", 13, C.muted)
    }${
      tx("2", 12, C.muted)
    }</div><div style="display:flex;align-items:center;gap:5px;height:40px;">${
      tx("Bakery", 13, C.muted)
    }${tx("3", 12, C.muted)}</div>`,
    "gap:18px;flex-shrink:0;",
  );
  const search =
    `<div style="display:flex;align-items:center;gap:7px;flex:1;min-width:180px;max-width:320px;min-height:36px;padding:7px 9px;border:1px solid ${C.strong};border-radius:4px;">${
      ico("search", 15, C.muted)
    }${tx("Search workflows…", 13, C.muted)}</div>`;
  const select = (label, width) =>
    `<div style="display:flex;align-items:center;justify-content:space-between;width:${width}px;min-height:36px;padding:7px 9px;border:1px solid ${C.strong};border-radius:4px;flex-shrink:0;">${
      tx(label, 13)
    }${ico("down", 13, C.muted)}</div>`;
  a(
    "controls",
    "library-content",
    row(
      sourceTabs + gap + search + select("All states", 118) +
        select("A–Z", 128),
      `border-bottom:1px solid ${C.border};gap:6px;`,
    ),
  );
  a(
    "catalog",
    "library-content",
    `<div layer-name="Filtered workflow catalog" style="display:flex;flex-direction:column;margin-top:14px;border:1px solid ${C.border};border-radius:6px;overflow:hidden;"></div>`,
  );
  a(
    "catalog-head",
    "catalog",
    row(
      tx("Workflow", 12, C.muted, 500, "flex:1;") +
        lane("Source", 112, C.muted, 500) + lane("Status", 86, C.muted, 500) +
        lane("Version", 70, C.muted, 500) + lane("Steps", 48, C.muted, 500) +
        `<div style="width:126px;flex-shrink:0;"></div>`,
      `min-height:40px;padding:8px 16px;background:${C.bg};gap:12px;`,
    ),
  );
  a(
    "workflow-implement",
    "catalog",
    workflowRow(
      "Implement",
      "Build from a plan, then check and review.",
      "Bakery",
      "Ready",
      "v1.0",
      6,
      "agent",
    ),
  );
  a(
    "workflow-delivery",
    "catalog",
    workflowRow(
      "Issue to delivery",
      "Research, plan and deliver across repositories.",
      "Organization",
      "Draft",
      "—",
      6,
      "flow",
    ),
  );
  a(
    "workflow-plan",
    "catalog",
    workflowRow(
      "Plan",
      "Turn research into a concrete plan.",
      "Bakery",
      "Ready",
      "v1.0",
      2,
      "plan",
    ),
  );
  a(
    "workflow-research",
    "catalog",
    workflowRow(
      "Research",
      "Investigate an issue and gather evidence.",
      "Bakery",
      "Ready",
      "v1.0",
      1,
      "search",
    ),
  );
  a(
    "workflow-copy",
    "catalog",
    workflowRow(
      "Research · Organization copy",
      "Copied from Bakery Research v1.0.",
      "Organization",
      "Draft",
      "—",
      1,
      "flow",
    ),
  );
  a(
    "catalog-foot",
    "catalog",
    row(
      tx("Showing 1–5 of 5 matching workflows", 12, C.muted) + gap +
        tx(
          "Previous",
          12,
          "var(--color-light-fg-disabled)",
          500,
          "padding:7px 12px;",
        ) +
        tx(
          "Next",
          12,
          "var(--color-light-fg-disabled)",
          500,
          "padding:7px 12px;",
        ),
      `min-height:56px;padding:8px 12px 8px 16px;background:${C.bg};`,
    ),
  );
  return b;
}
function skillVersionBoard() {
  const b = shell("skill-versions", "16 · Skill versions", {
    skills: true,
    detail: true,
  });
  b.chunks.find((c) => c.key === "header").html = b.chunks.find((c) =>
    c.key === "header"
  ).html.replace(">Research<", ">Release notes<");
  const a = (...args) => b.chunks.push(chunk(...args));
  a(
    "content",
    "main",
    `<div style="display:flex;flex-direction:column;padding:36px 40px;gap:22px;"></div>`,
  );
  a(
    "heading",
    "content",
    row(
      `<div style="flex:1;">${tx("Release notes", 20, C.fg, 600)}${
        tx("Organization · Version 4.0", 13, C.muted)
      }</div>` + button("Save draft", { primary: true }) +
        button("Evaluate", { icoName: "flask" }),
    ),
  );
  a(
    "tabs",
    "content",
    row(
      ["Files", "Test cases", "Evaluations", "Versions"].map((t) =>
        tx(t, 13, t === "Versions" ? C.fg : C.muted, 400, "padding:12px 0;")
      ).join(""),
      `gap:24px;border-bottom:1px solid ${C.border};`,
    ),
  );
  a(
    "notice",
    "content",
    tx(
      "Published versions are immutable. Update a workflow step explicitly to use a newer version.",
      13,
      C.muted,
      400,
      `padding:14px;background:${C.bg};border:1px solid ${C.border};border-radius:6px;`,
    ),
  );
  a(
    "columns",
    "content",
    row(
      tx("Version", 12, C.muted, 400, "width:180px;flex-shrink:0;") +
        tx("Change", 12, C.muted, 400, "flex:1;") +
        tx("Status", 12, C.muted, 400, "width:140px;flex-shrink:0;"),
    ),
  );
  for (const [i, v] of ["4.0", "3.0"].entries()) {
    a(
      "version-" + i,
      "content",
      row(
        tx("v" + v, 13, C.fg, 500, "width:180px;flex-shrink:0;") +
          `<div style="flex:1;">${
            tx(
              i
                ? "Initial organization version"
                : "Clarify migration notes and customer outcomes",
              13,
            )
          }${
            tx(
              i
                ? "2 workflow references stay pinned to this version"
                : "No workflows updated automatically",
              12,
              C.muted,
            )
          }</div>` + badge(i ? "Published" : "Published · latest"),
        `padding:16px 0;border-bottom:1px solid ${C.border};`,
      ),
    );
  }
  a(
    "upgrade",
    "content",
    row(
      ico("book") +
        `<div style="flex:1;">${
          tx("Workflow step · Write release notes", 13, C.fg, 500)
        }${
          tx("Currently uses v3.0. Compatible update available.", 12, C.muted)
        }</div>` + button("Update to v4.0", { primary: true }),
      `padding:20px;border:1px solid ${C.border};border-radius:6px;gap:14px;`,
    ),
  );
  return b;
}
function caseAuthorBoard() {
  const b = skillsBoard("case-authoring", "17 · Author a test case", {
    detail: true,
    cases: true,
  });
  const a = (...args) => b.chunks.push(chunk(...args));
  a(
    "scrim",
    "root",
    '<div style="position:absolute;inset:0;background:#10182766;"></div>',
  );
  a(
    "dialog",
    "root",
    `<div style="position:absolute;left:460px;top:175px;width:520px;display:flex;flex-direction:column;padding:24px;gap:20px;background:${C.surface};border:1px solid ${C.border};border-radius:8px;"></div>`,
  );
  a("dialog-title", "dialog", tx("Add a test case", 18, C.fg, 600));
  a(
    "dialog-help",
    "dialog",
    tx(
      "Save a new organization dataset revision. Existing cases and evaluation results stay unchanged.",
      13,
      C.muted,
    ),
  );
  a("case-name", "dialog", field("Name", "API unavailable during research"));
  a(
    "case-input",
    "dialog",
    field(
      "Input",
      "Research an issue while the API repository is unavailable.",
    ),
  );
  a(
    "case-expected",
    "dialog",
    field(
      "Expected behavior",
      "Preserve evidence, explain the interruption and keep downstream work blocked.",
    ),
  );
  a(
    "case-save",
    "dialog",
    row(gap + button("Cancel") + button("Save test case", { primary: true })),
  );
  return b;
}
function pickerBoard() {
  const b = graphBoard("step-picker", "18 · Add a step");
  const a = (...args) => b.chunks.push(chunk(...args));
  a(
    "picker",
    "canvas",
    `<div style="position:absolute;right:20px;top:64px;width:280px;display:flex;flex-direction:column;padding:16px;gap:12px;background:${C.surface};border:1px solid ${C.border};border-radius:8px;"></div>`,
  );
  a(
    "picker-title",
    "picker",
    row(tx("What happens next?", 14, C.fg, 500) + gap + ico("close")),
  );
  a("picker-search", "picker", field("Search", "Search skills and actions…"));
  a("picker-label", "picker", tx("Skills from your library", 11, C.muted));
  for (const [i, k] of skillLibrary.slice(0, 4).entries()) {
    a(
      "picker-row-" + i,
      "picker",
      row(
        ico(["search", "plan", "agent", "shield"][i]) +
          `<div style="flex:1;">${tx(k.title, 13, C.fg, 500)}${
            tx(k.description, 11, C.muted)
          }</div>`,
        "padding:8px 0;gap:10px;",
      ),
    );
  }
  a("controls-label", "picker", tx("Flow control", 11, C.muted));
  for (const [i, name] of ["Condition", "Repeat", "Wait"].entries()) {
    a(
      "control-" + i,
      "picker",
      row(
        ico(["branch", "loop", "clock"][i]) + tx(name, 13),
        "padding:6px 0;gap:10px;",
      ),
    );
  }
  a(
    "picker-create",
    "picker",
    button("Create a skill", { icoName: "plus", quiet: true }),
  );
  return b;
}
function darkBoard() {
  const b = graphBoard("canvas-dark", "19 · Workflow canvas · Dark");
  b.chunks.forEach((c) =>
    c.html = c.html.replaceAll("--color-light-", "--color-dark-").replaceAll(
      "--color-warning",
      "--color-dark-warning",
    ).replaceAll("--color-success", "--color-dark-success").replaceAll(
      "--color-destructive",
      "--color-dark-critical",
    ).replaceAll("#D6DBE2", "#26303D").replaceAll("#8792A1", "#7C8798")
  );
  return b;
}
export const revisedBoards = [
  graphBoard("canvas", "01 · Workflow canvas"),
  graphBoard("ai", "02 · Build with Bakery", { panel: "ai" }),
  graphBoard("setup", "03 · Configure a skill step", { panel: "setup" }),
  graphBoard("json", "04 · Canvas and JSON", { panel: "json" }),
  graphBoard("execution", "05 · Inspect execution", { run: true }),
  skillsBoard("skills", "06 · Skills library"),
  skillsBoard("skill-edit", "07 · Skill instructions", { detail: true }),
  skillsBoard("skill-cases", "08 · Skill test cases", {
    detail: true,
    cases: true,
  }),
  skillsBoard("evaluations", "09 · Evaluation comparison", {
    detail: true,
    evaluation: true,
  }),
  graphBoard("canvas-phone", "10 · Workflow outline · Phone", { phone: true }),
  graphBoard("ai-phone", "11 · Build with Bakery · Phone", {
    phone: true,
    panel: "ai",
    chatState: "intro",
  }),
  skillsBoard("skills-phone", "12 · Skills · Phone", { phone: true }),
  skillsBoard("skill-edit-phone", "13 · Instructions · Phone", {
    phone: true,
    detail: true,
  }),
  skillsBoard("eval-phone", "14 · Evaluations · Phone", {
    phone: true,
    detail: true,
    evaluation: true,
  }),
  workflowLibrary(),
  skillVersionBoard(),
  caseAuthorBoard(),
  pickerBoard(),
  darkBoard(),
  graphBoard("ai-auto", "20 · Auto-build draft and checkpoint", {
    panel: "ai",
    chatState: "auto",
  }),
  graphBoard("ai-review-phone", "21 · Review draft changes · Phone", {
    phone: true,
    panel: "ai",
    chatState: "review",
  }),
];
revisedBoards.find((b) => b.key === "ai-auto").chunks[0].html = revisedBoards
  .find((b) => b.key === "ai-auto").chunks[0].html.replace(
    "height:900px",
    "min-height:900px",
  );
for (
  const c of revisedBoards.find((b) => b.key === "ai-auto").chunks.filter((c) =>
    ["ai-test", "ai-undo"].includes(c.key)
  )
) c.html = c.html.replace('style="', 'style="align-self:flex-start;');
for (const board of revisedBoards) {
  const containers = new Set(board.chunks.map((c) => c.parent).filter(Boolean));
  for (const c of board.chunks) {
    if (!containers.has(c.key)) continue;
    const match = c.html.match(/^(<div[^>]*>)<\/div>$/s);
    if (match) {
      c.html = `${
        match[1]
      }<div layer-name="Layout anchor" style="position:absolute;left:0;top:0;width:1px;height:1px;background:#ffffff;opacity:0.01;"></div></div>`;
    }
  }
}
if (process.argv.includes("--write")) {
  writeFileSync(
    new URL("paper-revision-source.json", import.meta.url),
    JSON.stringify(revisedBoards, null, 2) + "\n",
  );
}
