import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFile } from "../../scripts/check-ui-architecture.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER = fileURLToPath(
  new URL("../../scripts/ui-catalog-mcp.mjs", import.meta.url),
);
const TOOL_NAMES = [
  "ui_find_component",
  "ui_component",
  "ui_composition",
  "ui_route_reference",
  "ui_check_file",
];

/** Spawns the server, sends every request line, and returns replies by id. */
function converse(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", () => {
      const replies = new Map();
      const lines = out.split("\n").filter(Boolean);
      for (const line of lines) {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0");
        replies.set(message.id, message);
      }
      resolve({ replies, lines, err });
    });
    for (const message of messages) {
      child.stdin.write(
        `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
      );
    }
    child.stdin.end();
  });
}

const call = (id, name, args) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const handshake = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

test("handshake, ping and tools/list expose five described read-only tools", async () => {
  const { replies, lines, err } = await converse([
    ...handshake,
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ]);
  assert.equal(err, "");
  assert.equal(lines.length, 3, "notifications get no reply");
  const init = replies.get(1).result;
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.equal(init.serverInfo.name, "bakery-ui");
  assert.match(init.instructions, /ui_find_component/);
  assert.match(init.instructions, /ui_check_file/);
  assert.deepEqual(replies.get(2).result, {});
  const { tools } = replies.get(3).result;
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES);
  for (const tool of tools) {
    assert(tool.description, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, "object");
    assert(tool.inputSchema.description, `${tool.name} schema description`);
    for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
      assert(schema.description, `${tool.name}.${field} needs a description`);
    }
    assert.equal(tool.annotations.readOnlyHint, true);
  }
});

test("ui_find_component maps a raw element to its catalog component", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_find_component", { element: "table" }),
    call(3, "ui_find_component", { need: "button", level: "atom" }),
    call(4, "ui_find_component", {}),
    call(5, "ui_find_component", { level: "galaxy" }),
  ]);
  const found = replies.get(2).result;
  assert.equal(found.isError, false);
  assert.equal(found.structuredContent.matches[0].id, "ui.dataTable");
  assert.deepEqual(JSON.parse(found.content[0].text), found.structuredContent);
  assert.equal(
    replies.get(3).result.structuredContent.matches[0].level,
    "atom",
  );
  assert.equal(replies.get(4).result.isError, true);
  assert.equal(replies.get(5).result.isError, true);
});

test("ui_component returns the full entry with Paper frames and alternatives", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_component", { id: "ui.text" }),
    call(3, "ui_component", { id: "ui.nope" }),
  ]);
  const entry = replies.get(2).result.structuredContent;
  assert.equal(entry.id, "ui.text");
  assert.equal(entry.storyTitle, "Bakery/Atoms/Text");
  assert(entry.paper.length > 0);
  const frame = entry.paper[0];
  assert.equal(
    frame.pageUrl,
    `https://app.paper.design/file/${frame.fileId}/${frame.pageId}`,
  );
  assert(entry.alternatives.every((alternative) => alternative.name));
  assert.equal(replies.get(3).result.isError, true);
});

const CONTRACT_AVAILABILITY_REASONS = [
  "no_active_profile",
  "repository_archived",
  "coding_agent_unbound",
  "coding_agent_disabled",
  "coding_agent_unbilled",
  "coding_agent_capability_denied",
  "coding_agent_unpriced",
  "profile_effect_denied",
  "budget_below_reservation",
  "budget_policy_unavailable",
  "application_archived",
];

const TASK_SESSION_ENTRIES = [
  {
    id: "ui.presetOption",
    name: "PresetOption",
    level: "molecule",
    storyTitle: "Bakery/Molecules/PresetOption",
    paperFrames: ["5J-0", "E8-0"],
  },
  {
    id: "ui.taskComposerForm",
    name: "TaskComposerForm",
    level: "organism",
    storyTitle: "Bakery/Organisms/TaskComposerForm",
    paperFrames: [],
  },
  {
    id: "ui.artifactPane",
    name: "ArtifactPane",
    level: "organism",
    storyTitle: "Bakery/Organisms/ArtifactPane",
    paperFrames: ["HU-0", "P6-0"],
  },
];

test("ui_component looks up and validates every task session catalog entry", async () => {
  const { replies } = await converse([
    ...handshake,
    ...TASK_SESSION_ENTRIES.map(({ id }, index) =>
      call(index + 2, "ui_component", { id })
    ),
  ]);
  TASK_SESSION_ENTRIES.forEach((expected, index) => {
    const result = replies.get(index + 2).result;
    assert.equal(result.isError, false, `${expected.id} lookup failed`);
    const entry = result.structuredContent;
    assert.equal(entry.id, expected.id);
    assert.equal(entry.name, expected.name);
    assert.equal(entry.level, expected.level);
    assert.equal(entry.storyTitle, expected.storyTitle);
    assert.equal(entry.status, "implemented");
    assert(entry.description.trim().length > 0, `${expected.id} description`);
    assert(entry.usage.whenToUse, `${expected.id} usage.whenToUse`);
    assert(entry.usage.whenNotToUse, `${expected.id} usage.whenNotToUse`);
    assert(entry.a11y.accessibleName, `${expected.id} accessible name`);
    assert(entry.tokens.length > 0, `${expected.id} tokens`);
    assert(entry.states.length > 0, `${expected.id} states`);
    assert.deepEqual(
      entry.paper.map((frame) => frame.frameId),
      expected.paperFrames,
    );
    for (const frame of entry.paper) {
      assert.equal(
        frame.pageUrl,
        `https://app.paper.design/file/${frame.fileId}/${frame.pageId}`,
      );
    }
    if (expected.paperFrames.length === 0) {
      assert.match(entry.paperAbsentReason, /Paper/);
    }
    if (expected.id === "ui.taskComposerForm") {
      // Every contract availability reason has its own catalogued state.
      for (const reason of CONTRACT_AVAILABILITY_REASONS) {
        assert(
          entry.states.includes(`setup-${reason}`),
          `${expected.id} lacks setup-${reason}`,
        );
      }
    }
  });
});

test("the removed session template is not in the catalog", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_component", { id: "template.taskSession" }),
  ]);
  assert.equal(replies.get(2).result.isError, true);
});

test("ui_find_component finds the task session components by need", async () => {
  const needs = [
    ["preset", "ui.presetOption"],
    ["task composer", "ui.taskComposerForm"],
    ["artifact pane", "ui.artifactPane"],
  ];
  const { replies } = await converse([
    ...handshake,
    ...needs.map(([need], index) =>
      call(index + 2, "ui_find_component", { need })
    ),
  ]);
  needs.forEach(([need, id], index) => {
    const ids = replies.get(index + 2).result.structuredContent.matches.map(
      (match) => match.id,
    );
    assert(ids.includes(id), `need ${JSON.stringify(need)} did not find ${id}`);
  });
});

test("ui_composition answers by id, by file and with no selector", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_composition", { id: "auth-entry" }),
    call(3, "ui_composition", {
      file: "apps/web/src/screens/SignInScreen.tsx",
    }),
    call(4, "ui_composition", {}),
    call(5, "ui_composition", { id: "missing" }),
  ]);
  const [authEntry] = replies.get(2).result.structuredContent.compositions;
  assert.equal(authEntry.id, "auth-entry");
  assert(authEntry.forbids.includes("template.appShell"));
  assert.deepEqual(
    replies.get(3).result.structuredContent.compositions.map((c) => c.id),
    ["auth-entry"],
  );
  assert(replies.get(4).result.structuredContent.compositions.length >= 2);
  assert.equal(replies.get(5).result.isError, true);
});

const SETTINGS_ENTRIES = [
  {
    id: "ui.themeChoice",
    need: "theme choice card preview",
    storyTitle: "Bakery/Molecules/ThemeChoice",
    frames: ["N1T-0", "N6E-0"],
  },
  {
    id: "ui.capabilityList",
    need: "capability list consent scopes",
    storyTitle: "Bakery/Molecules/CapabilityList",
    frames: ["TWJ-0", "KHJ-0"],
  },
  {
    id: "ui.settingsIndexRow",
    need: "settings index row",
    storyTitle: "Bakery/Molecules/SettingsIndexRow",
    frames: ["QM9-0"],
  },
];

test("ui_component and ui_find_component serve every settings entry", async () => {
  const { replies } = await converse([
    ...handshake,
    ...SETTINGS_ENTRIES.flatMap((entry, index) => [
      call(10 + index * 2, "ui_component", { id: entry.id }),
      call(11 + index * 2, "ui_find_component", { need: entry.need }),
    ]),
    call(30, "ui_component", { id: "ui.iconGlyph" }),
  ]);
  SETTINGS_ENTRIES.forEach((expected, index) => {
    const component = replies.get(10 + index * 2).result;
    assert.equal(component.isError, false, expected.id);
    const entry = component.structuredContent;
    assert.equal(entry.id, expected.id);
    assert.equal(entry.storyTitle, expected.storyTitle);
    assert(entry.description.length > 0);
    assert(entry.usage.whenToUse.length > 0);
    assert.deepEqual(
      entry.paper.map((frame) => frame.frameId).filter((id) =>
        expected.frames.includes(id)
      ),
      expected.frames,
    );
    for (const frame of entry.paper) {
      assert.equal(frame.fileId, "01M1X504XVC45FC0VDK857A37D");
      assert(["V-0", "O-0"].includes(frame.pageId));
    }
    const found = replies.get(11 + index * 2).result;
    assert.equal(found.isError, false, expected.need);
    assert(
      found.structuredContent.matches.some((match) => match.id === expected.id),
      `${expected.need} finds ${expected.id}`,
    );
  });
  assert(
    replies.get(30).result.structuredContent.variants.includes(
      "chevron-right",
    ),
  );
});

test("ui_composition returns the settings composition by id and by file", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_composition", { id: "settings" }),
    call(3, "ui_composition", {
      file: "apps/web/src/screens/AccountSettingsScreen.tsx",
    }),
  ]);
  const [settings] = replies.get(2).result.structuredContent.compositions;
  assert.equal(settings.id, "settings");
  assert(
    settings.requires.some((group) =>
      group.anyOf.includes("template.settingsContent")
    ),
  );
  assert(
    !settings.requires.some((group) =>
      group.anyOf.includes("ui.sectionNavigation")
    ),
  );
  assert(settings.appliesTo.includes(
    "apps/web/src/screens/AccountSettingsScreen.tsx",
  ));
  assert(
    replies.get(3).result.structuredContent.compositions.some((c) =>
      c.id === "settings"
    ),
  );
});

test("ui_route_reference returns the ledger entry, cases and reference PNGs", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_route_reference", { path: "/setup" }),
    call(3, "ui_route_reference", { path: "/not/a/route" }),
  ]);
  const { entry, cases } = replies.get(2).result.structuredContent;
  assert.equal(entry.path, "/setup");
  assert.equal(entry.status, "baselined");
  assert(entry.frames[0].pageUrl.startsWith("https://app.paper.design/file/"));
  assert.deepEqual(cases.map((c) => c.id), entry.cases);
  assert(cases.every((c) => c.referencePng && c.referencePngExists));
  assert.equal(replies.get(3).result.isError, true);
});

test("ui_route_reference follows the renamed settings routes and records the unmocked organization page", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_route_reference", { path: "/settings/security" }),
    call(3, "ui_route_reference", { path: "/settings/sessions" }),
    call(4, "ui_route_reference", { path: "/organization/settings" }),
    call(5, "ui_route_reference", { path: "/settings/account" }),
  ]);
  for (
    const [id, path] of [[2, "/settings/security"], [3, "/settings/sessions"]]
  ) {
    const { entry, cases } = replies.get(id).result.structuredContent;
    assert.equal(entry.path, path);
    assert.equal(entry.status, "baselined");
    assert.equal(entry.manifest, "auth");
    assert(cases.length > 0 && cases.every((c) => c.referencePngExists));
  }
  const organization = replies.get(4).result.structuredContent.entry;
  assert.equal(organization.status, "no-mock");
  assert.deepEqual(organization.frames, []);
  for (
    const manifest of [
      "auth-mocks",
      "settings-mocks",
      "enterprise-mocks",
      "worker-readiness",
    ]
  ) {
    assert(organization.rationale.includes(manifest), manifest);
  }
  assert.equal(replies.get(5).result.isError, true);
});

test("ui_route_reference serves the account security and connected client routes", async () => {
  const paths = [
    "/settings/security/password",
    "/settings/security/passkeys",
    "/settings/security/passkeys/new",
    "/account/reauthenticate",
    "/settings/clients",
    "/settings/clients/revoke",
    "/oauth/consent",
  ];
  const { replies } = await converse([
    ...handshake,
    ...paths.map((path, index) =>
      call(index + 2, "ui_route_reference", { path })
    ),
  ]);
  paths.forEach((path, index) => {
    const { entry, cases } = replies.get(index + 2).result.structuredContent;
    assert.equal(entry.path, path);
    assert.equal(entry.status, "baselined");
    assert.equal(entry.manifest, "auth");
    assert(cases.length > 0 && cases.every((c) => c.referencePngExists), path);
  });
});

test("ui_route_reference scores the personal settings screens from the settings manifest", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_route_reference", { path: "/settings/profile" }),
  ]);
  const { entry, cases } = replies.get(2).result.structuredContent;
  assert.equal(entry.status, "baselined");
  assert.equal(entry.manifest, "settings");
  assert.deepEqual(
    entry.frames.map((frame) => frame.frameId),
    ["HJE-0", "IG3-0"],
  );
  assert.deepEqual(entry.absentVariants.map((variant) => variant.theme), [
    "dark",
  ]);
  assert.deepEqual(
    cases.map((c) => c.id),
    ["profile.default.light.desktop", "profile.default.light.phone"],
  );
  assert(cases.every((c) => c.referencePngExists));
});

test("ui_route_reference scores Appearance in both themes and devices", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_route_reference", { path: "/settings/appearance" }),
  ]);
  const { entry, cases } = replies.get(2).result.structuredContent;
  assert.equal(entry.status, "baselined");
  assert.equal(entry.manifest, "settings");
  assert.deepEqual(
    entry.frames.map((frame) => frame.frameId),
    ["N1T-0", "N6E-0", "SGB-0", "SLW-0"],
  );
  assert.equal(cases.length, 4);
  assert(cases.every((c) => c.referencePngExists));
});

test("ui_route_reference records Your access as a dark-only scored screen", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_route_reference", { path: "/settings/access" }),
  ]);
  const { entry, cases } = replies.get(2).result.structuredContent;
  assert.equal(entry.status, "baselined");
  assert.equal(entry.manifest, "settings");
  assert.deepEqual(entry.absentVariants.map((variant) => variant.theme), [
    "light",
  ]);
  assert.deepEqual(
    cases.map((c) => c.id),
    ["your-access.developer.dark.desktop", "your-access.developer.dark.phone"],
  );
  assert(cases.every((c) => c.referencePngExists));
});

test("ui_route_reference scores the phone Settings index from QM9-0", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_route_reference", { path: "/settings" }),
  ]);
  const { entry, cases } = replies.get(2).result.structuredContent;
  assert.equal(entry.status, "baselined");
  assert.equal(entry.manifest, "settings");
  assert.deepEqual(entry.frames.map((frame) => frame.frameId), ["QM9-0"]);
  assert.deepEqual(cases.map((c) => c.id), [
    "section-index.default.light.phone",
  ]);
  assert(cases.every((c) => c.referencePngExists));
});

test("ui_check_file equals checkFile, the function CI runs", async () => {
  const files = [
    "apps/web/src/router.tsx",
    "apps/web/src/pages/SignInPage.tsx",
    "apps/web/src/pages/projects-onboarding/BindingSection.tsx",
    "apps/web/src/screens/SecurityHubScreen.tsx",
    "apps/web/src/screens/OrganizationSettingsScreen.tsx",
    "apps/web/src/pages/OrganizationSettingsPage.tsx",
  ];
  const { replies } = await converse([
    ...handshake,
    ...files.map((path, index) => call(index + 2, "ui_check_file", { path })),
  ]);
  files.forEach((path, index) => {
    const result = replies.get(index + 2).result;
    assert.equal(result.isError, false);
    assert.deepEqual(
      result.structuredContent.diagnostics,
      checkFile(path, { root: ROOT }),
    );
  });
});

test("ui_check_file reports a diagnostic checkFile also reports", async () => {
  const path = `apps/web/src/__mcp_probe_${process.pid}__.tsx`;
  const absolute = join(ROOT, path);
  writeFileSync(absolute, "export const Probe = () => <table />;\n");
  try {
    const { replies } = await converse([
      ...handshake,
      call(2, "ui_check_file", { path }),
    ]);
    const { diagnostics, clean } = replies.get(2).result.structuredContent;
    assert.equal(clean, false);
    assert.deepEqual(diagnostics.map((d) => d.rule), ["ui/raw-element-in-app"]);
    assert.match(diagnostics[0].message, /ui\.dataTable/);
    assert.deepEqual(diagnostics, checkFile(path, { root: ROOT }));
  } finally {
    rmSync(absolute, { force: true });
  }
});

test("ui_check_file errors on paths that are not analyzed modules", async () => {
  const paths = ["apps", "README.md", "docs/technical-design/README.md"];
  const { replies } = await converse([
    ...handshake,
    ...paths.map((path, index) => call(index + 2, "ui_check_file", { path })),
  ]);
  paths.forEach((path, index) => {
    const result = replies.get(index + 2).result;
    assert.equal(result.isError, true, path);
    assert.match(result.content[0].text, /not an analyzed UI module/);
    assert.throws(
      () => checkFile(path, { root: ROOT }),
      /not an analyzed UI module/,
    );
  });
});

test("paths outside the repository are rejected as tool errors", async () => {
  const { replies } = await converse([
    ...handshake,
    call(2, "ui_check_file", { path: "../outside.tsx" }),
    call(3, "ui_check_file", { path: "/etc/passwd" }),
    call(4, "ui_check_file", { path: "apps/web/src/../../../x.ts" }),
    call(5, "ui_composition", { file: "../../etc/hosts" }),
    call(6, "ui_check_file", { path: "apps/web/src/missing.tsx" }),
    call(7, "ui_check_file", { path: 42 }),
  ]);
  for (const id of [2, 3, 4, 5, 6, 7]) {
    const result = replies.get(id).result;
    assert.equal(result.isError, true, `request ${id}`);
  }
  assert.match(replies.get(2).result.content[0].text, /outside the repository/);
  assert.match(replies.get(3).result.content[0].text, /outside the repository/);
});

test("malformed input never crashes the server", async () => {
  const { replies } = await converse([
    "not json",
    "[]",
    { jsonrpc: "2.0", id: 1, method: "nope" },
    call(2, "ui_unknown", {}),
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: null },
    call(4, "ui_component", { id: "ui.text", extra: 1 }),
    { jsonrpc: "2.0", id: 5, method: "ping" },
  ]);
  assert.equal(replies.get(null).error.code, -32600);
  assert.equal(replies.get(1).error.code, -32601);
  assert.equal(replies.get(2).error.code, -32602);
  assert.equal(replies.get(3).error.code, -32602);
  assert.equal(replies.get(4).result.isError, true);
  assert.deepEqual(replies.get(5).result, {});
});
