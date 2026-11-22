import { assert, assertEquals } from "@std/assert";

// The desktop window's page is checked against what design-ux asked for and against the web's own
// files, so a later edit cannot drift from either without a test saying so.
const page = "apps/desktop/web";
const css = await Deno.readTextFile(`${page}/panel.css`);
const html = await Deno.readTextFile(`${page}/index.html`);
const js = await Deno.readTextFile(`${page}/panel.js`);
const tokens =
  await Deno.readTextFile("packages/ui/src/foundations/tokens.css") +
  await Deno.readTextFile("packages/ui/src/foundations/theme.css") +
  await Deno.readTextFile("packages/ui/src/foundations/focus.css");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert(match, `panel.css has a rule for ${selector}`);
  return match[1];
}

Deno.test("every token the panel uses is one the web defines", () => {
  const used = new Set(
    [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
  );
  assert(used.size > 10, "the panel uses the web's tokens");
  const missing = [...used].filter((name) => !tokens.includes(`${name}:`));
  assertEquals(missing, [], "tokens the web does not define");
});

Deno.test("the heading takes focus without a ring, because a heading is not a control", () => {
  const combined = [...css.matchAll(/\.panel__heading:focus[^{]*\{([^}]*)\}/g)]
    .map((m) => m[1]).join(" ");
  assert(
    /outline:\s*none/.test(combined),
    "a focused heading draws no outline",
  );
  assert(
    js.includes("heading.tabIndex = -1"),
    "the heading can still take focus",
  );
});

Deno.test("the sentence under each heading is the web's body size, 14 on 20", () => {
  assert(/font:\s*var\(--type-body\)/.test(rule(".panel__text")));
  assert(
    /--type-body:\s*400 14px\/20px/.test(tokens),
    "the web's body size is 14 on 20",
  );
});

Deno.test("Geist is bundled in the three weights the web uses, from the web's own files", async () => {
  for (const weight of ["400", "500", "600"]) {
    assert(
      new RegExp(`font-weight:\\s*${weight};[^}]*geist-${weight}\\.ttf`).test(
        css,
      ),
      `Geist ${weight} is declared`,
    );
    const file = await Deno.stat(
      `docs/technical-design/enterprise-mocks/fonts/geist-${weight}.ttf`,
    );
    assert(file.size > 10_000, `geist-${weight}.ttf exists in the repo`);
  }
  const sync = await Deno.readTextFile(
    "apps/desktop/scripts/sync-foundations.ts",
  );
  for (
    const name of [
      "geist-400.ttf",
      "geist-500.ttf",
      "geist-600.ttf",
      "geist-OFL.txt",
    ]
  ) {
    assert(sync.includes(name), `the sync script copies ${name}`);
  }
  assert(/--font-sans:\s*Geist/.test(tokens), "the web's text face is Geist");
});

Deno.test("the finishing box carries words beside its spinner", () => {
  assert(/case "working"/.test(js));
  assert(/detail\.text/.test(js), "the words come from the app");
});

Deno.test("nothing is inline, so the strict content security policy can hold", () => {
  assert(!/\sstyle\s*=/.test(html), "no style attribute");
  assert(!/\son[a-z]+\s*=/i.test(html), "no inline event handler");
  for (const tag of html.matchAll(/<script\b([^>]*)>/g)) {
    assert(
      /\bsrc\s*=/.test(tag[1]),
      `every script has a source: <script${tag[1]}>`,
    );
  }
  assert(!/<style\b/.test(html), "no style block");
  assert(
    !/\.setAttribute\(\s*["']style["']/.test(js),
    "no style attribute set from script",
  );
  assert(!/innerHTML\s*=/.test(js), "no markup built from strings");
});
