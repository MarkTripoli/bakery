import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkFile,
  checkUiArchitecture,
  NotAnalyzedModuleError,
  validateGuardrailContraction,
} from "../../scripts/check-ui-architecture.mjs";

const NODE_MODULES = fileURLToPath(
  new URL("../../packages/ui/node_modules", import.meta.url),
);
const BASELINES = "docs/technical-design/ui-baselines";

const COMPONENTS = {
  atoms: ["Text", "Button", "AuthHeading", "Checkbox", "TextInput"],
  templates: ["AuthEntry", "AppShell"],
  organisms: ["DataTable"],
};

const CATALOG = {
  entries: [
    ["ui.text", "Text", ["p"]],
    ["ui.button", "Button", ["button"]],
    ["ui.authHeading", "AuthHeading", []],
    ["ui.textInput", "TextInput", ["input"]],
    ["ui.checkbox", "Checkbox", ["input"]],
    ["ui.dataTable", "DataTable", ["table"]],
    ["template.authEntry", "AuthEntry", []],
    ["template.appShell", "AppShell", []],
  ].map(([id, name, replacesElements]) => ({
    id,
    name,
    requiredCases: [],
    usage: { replacesElements },
  })),
  compositions: [
    {
      id: "auth-entry",
      appliesTo: ["template.authEntry"],
      requires: [{ anyOf: ["ui.authHeading"] }, { anyOf: ["ui.button"] }],
      forbids: ["template.appShell"],
    },
    {
      id: "auth-screen",
      appliesTo: ["apps/web/src/screens/*Screen.tsx"],
      requires: [{ anyOf: ["ui.authHeading"] }],
      forbids: [],
    },
    {
      id: "queue",
      appliesTo: ["apps/web/src/queue/*Page.tsx", "apps/web/src/absent/**"],
      requires: [{ anyOf: ["ui.dataTable"] }],
      forbids: [],
    },
  ],
};

function workspace({ catalog = CATALOG, baseline } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bakery-ui-guardrails-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      workspaces: ["apps/*", "packages/*"],
    }),
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        lib: ["esnext", "dom"],
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        paths: { "@bakery/ui": ["./packages/ui/src/index.ts"] },
      },
      include: ["apps/*/src/**/*", "packages/*/src/**/*"],
    }),
  );
  const ui = join(root, "packages/ui");
  const exports = [];
  for (const [level, names] of Object.entries(COMPONENTS)) {
    mkdirSync(join(ui, "src", level), { recursive: true });
    for (const name of names) {
      writeFileSync(
        join(ui, "src", level, `${name}.ts`),
        `export function ${name}(_props: { children?: unknown }) { return null; }\n`,
      );
      exports.push(`export * from "./${level}/${name}";\n`);
    }
  }
  writeFileSync(
    join(ui, "package.json"),
    JSON.stringify({ name: "@bakery/ui", exports: { ".": "./src/index.ts" } }),
  );
  writeFileSync(join(ui, "src/index.ts"), exports.join(""));
  mkdirSync(join(root, "apps/web/src/queue"), { recursive: true });
  writeFileSync(
    join(root, "apps/web/package.json"),
    JSON.stringify({ name: "@bakery/web" }),
  );
  symlinkSync(NODE_MODULES, join(root, "node_modules"), "dir");
  mkdirSync(join(root, BASELINES), { recursive: true });
  writeFileSync(
    join(root, BASELINES, "components.json"),
    JSON.stringify(catalog),
  );
  if (baseline) {
    writeFileSync(
      join(root, BASELINES, "guardrail-baseline.json"),
      JSON.stringify({ schemaVersion: 1, entries: baseline }),
    );
  }
  return root;
}

function write(root, file, source) {
  writeFileSync(join(root, "apps/web/src", file), source);
}

function check(root) {
  return checkUiArchitecture({ root, print: () => {} }).diagnostics;
}

function withWorkspace(options, body) {
  const root = workspace(options);
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const importUi = (...names) =>
  `import { ${names.join(", ")} } from "@bakery/ui";\n`;

test("flags a raw element the catalog replaces and names the component", () => {
  withWorkspace({}, (root) => {
    write(
      root,
      "raw.tsx",
      `export const A = () => <p>hi</p>;\nexport const B = () => <table />;\n`,
    );
    const found = check(root);
    assert.deepEqual(found.map((d) => d.rule), [
      "ui/raw-element-in-app",
      "ui/raw-element-in-app",
    ]);
    assert.match(found[0].message, /<p>.*ui\.text \(Text\)/);
    assert.match(found[1].message, /<table>.*ui\.dataTable \(DataTable\)/);
  });
});

test("lists every catalog component that replaces a shared tag", () => {
  withWorkspace({}, (root) => {
    write(root, "input.tsx", "export const A = () => <input />;\n");
    const [diagnostic] = check(root);
    assert.match(diagnostic.message, /ui\.textInput \(TextInput\)/);
    assert.match(diagnostic.message, /ui\.checkbox \(Checkbox\)/);
  });
});

test("allows catalog components, unlisted tags, tests and stories", () => {
  withWorkspace({}, (root) => {
    write(
      root,
      "ok.tsx",
      `${
        importUi("Text")
      }export const A = () => <div><Text>x</Text><span /></div>;\n`,
    );
    write(root, "raw.test.tsx", "export const A = () => <p />;\n");
    write(root, "raw.stories.tsx", "export const A = () => <p />;\n");
    assert.deepEqual(check(root), []);
  });
});

test("catalog drives the rule: no replacesElements means no diagnostics", () => {
  const catalog = {
    ...CATALOG,
    entries: CATALOG.entries.map((entry) => ({
      ...entry,
      usage: { replacesElements: [] },
    })),
  };
  withWorkspace({ catalog }, (root) => {
    write(root, "raw.tsx", "export const A = () => <p />;\n");
    assert.deepEqual(check(root), []);
  });
});

test("baseline ledger allows listed hits, flags the excess and stale counts", () => {
  const baseline = (count) => [{
    rule: "ui/raw-element-in-app",
    file: "apps/web/src/raw.tsx",
    subject: "p",
    count,
  }];
  const source = "export const A = () => <><p /><p /></>;\n";
  withWorkspace({ baseline: baseline(2) }, (root) => {
    write(root, "raw.tsx", source);
    assert.deepEqual(check(root), []);
  });
  withWorkspace({ baseline: baseline(1) }, (root) => {
    write(root, "raw.tsx", source);
    const found = check(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, "ui/raw-element-in-app");
    assert.match(found[0].message, /ledger allows 1/);
  });
  withWorkspace({ baseline: baseline(3) }, (root) => {
    write(root, "raw.tsx", source);
    const found = check(root);
    assert.deepEqual(found.map((d) => d.rule), ["ui/guardrail-baseline-stale"]);
  });
});

test("ledger counts may only shrink against the base", () => {
  const key = "ui/raw-element-in-app|apps/web/src/a.tsx|p";
  assert.deepEqual(
    validateGuardrailContraction({
      baseCounts: new Map([[key, 2]]),
      candidateCounts: new Map([[key, 2]]),
    }),
    [],
  );
  assert.deepEqual(
    validateGuardrailContraction({
      baseCounts: new Map([[key, 2]]),
      candidateCounts: new Map([[key, 1]]),
    }),
    [],
  );
  const grew = validateGuardrailContraction({
    baseCounts: new Map([[key, 1]]),
    candidateCounts: new Map([[key, 2], ["other|b.tsx|p", 1]]),
  });
  assert.equal(grew.length, 2);
  assert.match(grew[0], /ui\/guardrail-baseline-grew/);
  assert.deepEqual(
    validateGuardrailContraction({
      baseCounts: null,
      candidateCounts: new Map([[key, 9]]),
    }),
    [],
  );
});

test("composition: every missing required group is named once per module", () => {
  withWorkspace({}, (root) => {
    write(
      root,
      "screen.tsx",
      `${
        importUi("AuthEntry", "Text")
      }export const A = () => <AuthEntry><Text>x</Text></AuthEntry>;\n`,
    );
    const found = check(root);
    assert.deepEqual(found.map((d) => d.rule), [
      "ui/composition-missing-required",
    ]);
    assert.match(
      found[0].message,
      /auth-entry requires one of ui\.authHeading/,
    );
    assert.match(found[0].message, /one of ui\.button/);
  });
});

test("composition: a forward id in a requires group is never rendered", () => {
  const catalog = {
    ...CATALOG,
    compositions: [{
      id: "queue",
      appliesTo: ["apps/web/src/queue/*Page.tsx"],
      requires: [{ anyOf: ["ui.dataTable", "ui.notYetShipped"] }],
      forbids: [],
    }],
  };
  withWorkspace({ catalog }, (root) => {
    write(
      root,
      "queue/OkPage.tsx",
      `${importUi("DataTable")}export const A = () => <DataTable />;\n`,
    );
    assert.deepEqual(check(root), []);
    write(
      root,
      "queue/BadPage.tsx",
      `${importUi("Text")}export const A = () => <Text>x</Text>;\n`,
    );
    const found = check(root);
    assert.deepEqual(found.map((d) => `${d.file}:${d.rule}`), [
      "apps/web/src/queue/BadPage.tsx:ui/composition-missing-required",
    ]);
    assert.match(found[0].message, /one of ui\.dataTable, ui\.notYetShipped/);
  });
});

test("composition: forbidden component is reported at its use", () => {
  withWorkspace({}, (root) => {
    write(
      root,
      "screen.tsx",
      `${
        importUi("AuthEntry", "AuthHeading", "Button", "AppShell")
      }export const A = () => (\n  <AuthEntry><AuthHeading /><Button /><AppShell /></AuthEntry>\n);\n`,
    );
    const found = check(root);
    assert.deepEqual(found.map((d) => d.rule), ["ui/composition-forbidden"]);
    assert.equal(found[0].line, 3);
    assert.match(found[0].message, /forbids template\.appShell/);
  });
});

test("composition: satisfied module, unrelated module and absent globs pass", () => {
  withWorkspace({}, (root) => {
    write(
      root,
      "screen.tsx",
      `${
        importUi("AuthEntry", "AuthHeading", "Button")
      }export const A = () => <AuthEntry><AuthHeading /><Button /></AuthEntry>;\n`,
    );
    write(
      root,
      "other.tsx",
      `${importUi("Text")}export const A = () => <Text>x</Text>;\n`,
    );
    assert.deepEqual(check(root), []);
  });
});

test("composition: glob targets require the group and resolve through barrels", () => {
  withWorkspace({}, (root) => {
    write(
      root,
      "queue/ListPage.tsx",
      `${importUi("Text")}export const A = () => <Text>x</Text>;\n`,
    );
    write(
      root,
      "queue/OkPage.tsx",
      `import * as UI from "@bakery/ui";\nexport const A = () => <UI.DataTable />;\n`,
    );
    write(
      root,
      "queue/helper.tsx",
      `${importUi("Text")}export const A = () => <Text>x</Text>;\n`,
    );
    const found = check(root);
    assert.deepEqual(found.map((d) => `${d.file}:${d.rule}`), [
      "apps/web/src/queue/ListPage.tsx:ui/composition-missing-required",
    ]);
  });
});

test("composition: glob-targeted composition passes a screen and fails one missing the heading", () => {
  withWorkspace({}, (root) => {
    mkdirSync(join(root, "apps/web/src/screens"), { recursive: true });
    write(
      root,
      "screens/GoodScreen.tsx",
      `${importUi("AuthHeading")}export const A = () => <AuthHeading />;\n`,
    );
    write(
      root,
      "screens/BadScreen.tsx",
      `${importUi("Text")}export const A = () => <Text>x</Text>;\n`,
    );
    const found = check(root).filter((d) => /auth-screen/.test(d.message));
    assert.deepEqual(found.map((d) => `${d.file}:${d.rule}`), [
      "apps/web/src/screens/BadScreen.tsx:ui/composition-missing-required",
    ]);
  });
});

test("checkFile returns the full-check diagnostics for that file only", () => {
  withWorkspace({}, (root) => {
    write(root, "a.tsx", "export const A = () => <p />;\n");
    write(
      root,
      "b.tsx",
      `${importUi("AuthEntry")}export const B = () => <AuthEntry />;\n`,
    );
    write(root, "clean.tsx", "export const C = () => <span />;\n");
    const all = check(root);
    assert.equal(all.length, 2);
    for (const file of ["a.tsx", "b.tsx", "clean.tsx"]) {
      const relativePath = `apps/web/src/${file}`;
      assert.deepEqual(
        checkFile(relativePath, { root }),
        all.filter((d) => d.file === relativePath),
      );
    }
    assert.deepEqual(checkFile("apps/web/src/clean.tsx", { root }), []);
  });
});

test("checkFile rejects paths outside the root", () => {
  withWorkspace({}, (root) => {
    assert.throws(() => checkFile("../outside.tsx", { root }), /outside/);
  });
});

test("without a catalog the new rules stay silent", () => {
  withWorkspace({}, (root) => {
    rmSync(join(root, BASELINES, "components.json"));
    write(root, "raw.tsx", "export const A = () => <p />;\n");
    assert.deepEqual(check(root), []);
  });
});

test("checkFile throws for a path that is not an analyzed module", () => {
  withWorkspace({}, (root) => {
    write(root, "ok.tsx", "export const A = () => null;\n");
    write(root, "notes.md", "# notes\n");
    assert.deepEqual(checkFile("apps/web/src/ok.tsx", { root }), []);
    for (
      const path of [
        "apps",
        "apps/web/src",
        "apps/web/src/notes.md",
        "elsewhere.ts",
      ]
    ) {
      assert.throws(
        () => checkFile(path, { root }),
        (error) =>
          error instanceof NotAnalyzedModuleError &&
          /not an analyzed UI module/.test(error.message),
        path,
      );
    }
  });
});
