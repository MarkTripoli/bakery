// Holds the three V-0 frame fixes the UX designer specified on #331, #333 and
// #334 against the committed design source, so a later re-export cannot quietly
// reintroduce the broken clients row, the wrapped consent lede or the preview-only
// passkey controls and copy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) =>
  JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const readText = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const source = read("docs/technical-design/auth-mocks/paper-source.json");
const manifest = read("docs/technical-design/auth-mocks/paper-manifest.json");
const baselines = read(
  "docs/technical-design/ui-baselines/paper-baselines.json",
);
const strings = read("packages/i18n/locales/en.json");
const mock = readText("docs/technical-design/auth-mocks/auth.js");

const THEMES = ["light", "dark"];
const DEVICES = ["desktop", "phone"];

const frameOf = (screen, state, theme, device) => {
  const frame = source.screens.find((entry) =>
    entry.id === screen && entry.state === state && entry.theme === theme &&
    entry.device === device
  );
  assert.ok(
    frame,
    `paper-source.json has no ${screen}.${state}.${theme}.${device}`,
  );
  return frame;
};
const manifestFrameOf = (screen, state, theme, device) => {
  const frame = manifest.screens.find((entry) =>
    entry.id === screen && entry.state === state && entry.theme === theme &&
    entry.device === device
  );
  assert.ok(
    frame,
    `paper-manifest.json has no ${screen}.${state}.${theme}.${device}`,
  );
  return frame;
};
const htmlOf = (frame, predicate) => {
  const placement = frame.groups.find((group) => predicate(group.name));
  return placement ? source.groups[placement.key].html : null;
};

// #331: the clients row is the `sessions.default` row box — 760x79.5 at the
// same origin — with the name over its caption and Revoke access hugging its
// own content at the row's trailing edge, not stretched across it. The phone
// frame takes the same anatomy but not the same box: at 390px the 23-character
// name and 57-character caption cannot each hold one line in what is left of
// the 358px row after the 36px icon column and the hug-width button, so the
// row is 358x142.5 rather than the spec's 358x79.5 (reported on #331).
test("#331 the clients.default row is the sessions row box in every variant", () => {
  for (const theme of THEMES) {
    const desktop = frameOf("clients", "default", theme, "desktop");
    assert.deepEqual(
      { width: desktop.width, height: desktop.height },
      { width: 1440, height: 960 },
      `clients.default.${theme}.desktop frame`,
    );
    const row = desktop.groups.find((group) =>
      group.name.startsWith("item: Local development client")
    );
    assert.ok(row, `clients.default.${theme}.desktop has no client row`);
    assert.deepEqual(
      { x: row.x, y: row.y, width: row.width, height: row.height },
      { x: 248, y: 272, width: 760, height: 79.5 },
      `clients.default.${theme}.desktop row box`,
    );
  }

  for (const theme of THEMES) {
    for (const device of DEVICES) {
      const frame = frameOf("clients", "default", theme, device);
      const row = frame.groups.find((group) =>
        group.name.startsWith("item: Local development client")
      );
      const html = source.groups[row.key].html;
      // The name and its caption are text again: the broken artboard starved
      // the column to 0px, which dropped both of them from the export. The
      // exporter emits one node per rendered line, so the phone frame's
      // wrapped lines concatenate back to the same two strings.
      const text = [...html.matchAll(/white-space:pre;">([^<]*)</g)]
        .map((match) => match[1]).join("");
      assert.ok(
        text.includes("Local development client"),
        `clients.default.${theme}.${device} lost the client name`,
      );
      assert.ok(
        text.includes(
          "Northstar · Read work and artifacts, start and steer tasks",
        ),
        `clients.default.${theme}.${device} lost the grant caption`,
      );
      // The action hugs its content at the row's trailing edge instead of
      // claiming the whole row.
      const action =
        /layer-name="btn secondary full surface" style="[^"]*?left:([\d.]+)px;[^"]*?width:([\d.]+)px/
          .exec(html);
      assert.ok(
        action,
        `clients.default.${theme}.${device} has no Revoke access button`,
      );
      const [left, width] = [Number(action[1]), Number(action[2])];
      assert.ok(
        width < row.width / 2,
        `clients.default.${theme}.${device} Revoke access is ${width}px of a ${row.width}px row`,
      );
      assert.equal(
        left + width,
        row.width,
        `clients.default.${theme}.${device} Revoke access is not at the row's trailing edge`,
      );
    }
  }
});

test("#331 the clients.default artboards are the standard settings frames", () => {
  for (const theme of THEMES) {
    assert.equal(
      manifestFrameOf("clients", "default", theme, "desktop").height,
      960,
    );
    assert.equal(
      manifestFrameOf("clients", "default", theme, "phone").height,
      844,
    );
  }
});

// #333: the lede keeps its sentence and takes the 3px it needs, so the phone
// frame is the 1042px Paper frame again instead of one wrap taller.
test("#333 the consent.default phone lede fits on one line at 361px", () => {
  for (const theme of THEMES) {
    const frame = frameOf("consent", "default", theme, "phone");
    assert.deepEqual(
      { width: frame.width, height: frame.height },
      { width: 390, height: 1042 },
      `consent.default.${theme}.phone frame`,
    );
    const lede = frame.groups.find((group) =>
      group.name.endsWith(
        "Review what this client can access before you continue.",
      )
    );
    assert.ok(lede, `consent.default.${theme}.phone has no lede`);
    assert.deepEqual(
      { x: lede.x, y: lede.y, width: lede.width, height: lede.height },
      { x: 16, y: 168, width: 361, height: 21 },
      `consent.default.${theme}.phone lede box`,
    );
  }
  // The rule is "keep the sentence": the copy is unchanged and unwrapped.
  assert.match(
    mock,
    /Review what this client can access before you continue\./,
  );
});

// #334: no preview-only control or caption on the prompt artboard, and the
// success notice is the string the product actually ships.
test("#334 passkey-add.prompt carries no preview-only control or caption", () => {
  for (const theme of THEMES) {
    for (const device of DEVICES) {
      const frame = frameOf("passkey-add", "prompt", theme, device);
      const placeholders = frame.groups.filter((group) =>
        /complete device check|no real passkey prompt is opened/.test(
          group.name,
        )
      );
      assert.deepEqual(
        placeholders.map((group) => group.name),
        [],
        `passkey-add.prompt.${theme}.${device} still carries preview-only nodes`,
      );
      // Cancel is real: the person can abort the ceremony mid-prompt.
      assert.ok(
        htmlOf(frame, (name) => name.startsWith("text-link: Cancel")),
        `passkey-add.prompt.${theme}.${device} lost its Cancel link`,
      );
    }
  }
  assert.ok(!mock.includes("Preview: complete device check"));
  assert.ok(
    !mock.includes("Design preview · no real passkey prompt is opened"),
  );
});

test("#334 password.success states the shipped success notice", () => {
  const shipped = strings["settings.password.successNotice"];
  assert.equal(
    shipped,
    "Your current session stays signed in. Other sessions were signed out.",
  );
  assert.ok(
    mock.includes(shipped),
    "the mock does not carry the shipped notice",
  );
  assert.ok(!mock.includes("remains signed in in this preview"));
  for (const theme of THEMES) {
    for (const device of DEVICES) {
      const frame = frameOf("password", "success", theme, device);
      const notice = htmlOf(frame, (name) => name.startsWith("notice success"));
      assert.ok(
        notice,
        `password.success.${theme}.${device} has no success notice`,
      );
      for (const word of shipped.split(" ")) {
        assert.ok(
          notice.includes(word),
          `password.success.${theme}.${device} notice is missing "${word}"`,
        );
      }
    }
  }
});

// The three exceptions existed only because the artboards carried the defects
// above; with the frames fixed the cases are scored, not excluded.
test("the three fixed states are scored cases, not exclusions", () => {
  const fixed = [
    ["clients", "default"],
    ["passkey-add", "prompt"],
    ["password", "success"],
  ];
  for (const [screen, state] of fixed) {
    assert.ok(
      !baselines.excluded.some((entry) =>
        entry.screen === screen && entry.state === state
      ),
      `${screen}.${state} is still excluded`,
    );
  }
  const ids = new Set(baselines.cases.map((entry) => entry.id));
  const restored = [
    ...fixed.flatMap(([screen, state]) =>
      THEMES.flatMap((theme) =>
        DEVICES.map((device) => `${screen}.${state}.${theme}.${device}`)
      )
    ),
    ...THEMES.map((theme) => `consent.default.${theme}.phone`),
  ];
  for (const id of restored) {
    assert.ok(ids.has(id), `paper-baselines.json has no case ${id}`);
  }
});
