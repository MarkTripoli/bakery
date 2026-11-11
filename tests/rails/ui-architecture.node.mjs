import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { checkUiArchitecture } from "../../scripts/check-ui-architecture.mjs";

const NODE_MODULES = fileURLToPath(
  new URL("../../packages/ui/node_modules", import.meta.url),
);
const ROOT_DIR = fileURLToPath(new URL("../..", import.meta.url));

function workspace({ paths = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bakery-ui-architecture-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture-workspace",
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
        paths: {
          "@bakery/ui": ["./packages/ui/src/index.ts"],
          ...paths,
        },
      },
      include: ["apps/*/src/**/*", "packages/*/src/**/*"],
    }),
  );
  const ui = join(root, "packages/ui");
  mkdirSync(join(ui, "src/atoms"), { recursive: true });
  mkdirSync(join(ui, "src/molecules"), { recursive: true });
  mkdirSync(join(ui, "src/organisms"), { recursive: true });
  writeFileSync(
    join(ui, "package.json"),
    JSON.stringify({ name: "@bakery/ui", exports: { ".": "./src/index.ts" } }),
  );
  writeFileSync(
    join(ui, "src/atoms/Text.ts"),
    [
      "export type TextProps = { children?: unknown };\n",
      "export function Text(_props: TextProps) { return null; }\n",
    ].join(""),
  );
  writeFileSync(
    join(ui, "src/molecules/Menu.ts"),
    "export function Menu() { return null; }\n",
  );
  writeFileSync(
    join(ui, "src/organisms/SectionNavigation.ts"),
    [
      "export type SectionNavigationItem = {\n",
      "  id: string;\n",
      "  label: string;\n",
      "  href: string;\n",
      "  matches?: readonly string[];\n",
      "};\n",
      "export function SectionNavigation(\n",
      "  _props: {\n",
      "    items: readonly SectionNavigationItem[];\n",
      "    currentPath: string;\n",
      "    label: string;\n",
      '    narrowMode: "index" | "menu";\n',
      "  },\n",
      ") { return null; }\n",
    ].join(""),
  );
  writeFileSync(
    join(ui, "src/index.ts"),
    [
      'export * from "./atoms/Text";\n',
      'export * from "./organisms/SectionNavigation";\n',
    ].join(""),
  );
  const web = join(root, "apps/web");
  mkdirSync(join(web, "src"), { recursive: true });
  writeFileSync(
    join(web, "package.json"),
    JSON.stringify({ name: "@bakery/web" }),
  );
  symlinkSync(NODE_MODULES, join(root, "node_modules"), "dir");
  return root;
}

function writeConsumer(root, fileName, source) {
  writeFileSync(join(root, "apps/web/src", fileName), source);
}

function run(root, options = {}) {
  const output = [];
  const result = checkUiArchitecture({
    root,
    print: (line) => output.push(line),
    ...options,
  });
  return { ...result, output };
}

function rules(diagnostics) {
  return diagnostics.map((diagnostic) => diagnostic.rule).sort();
}

test("accepts public imports, namespace imports, and safe spreads", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      [
        'import { Text } from "@bakery/ui";\n',
        'import * as UI from "@bakery/ui";\n',
        'const safe = { id: "a", onClick: () => {} };\n',
        "export function Example() {\n",
        "  return (\n",
        "    <>\n",
        "      <UI.Text>namespace</UI.Text>\n",
        "      <Text>named</Text>\n",
        "      <div {...safe} />\n",
        "    </>\n",
        "  );\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects @bakery/ui subpath imports", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      'import { Text } from "@bakery/ui/src/atoms/Text";\n',
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), ["ui/internal-module"]);
    assert.match(diagnostics[0].message, /public @bakery\/ui entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects aliased paths resolving inside @bakery/ui source", () => {
  const root = workspace({
    paths: { "@ui/internal": ["./packages/ui/src/atoms/Text"] },
  });
  try {
    writeConsumer(
      root,
      "example.tsx",
      'import { Text } from "@ui/internal";\n',
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), ["ui/internal-module"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects barrels re-exporting internal declarations", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "bridge.ts",
      'export * from "../../../packages/ui/src/atoms/Text";\n',
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), ["ui/internal-module"]);
    assert.match(diagnostics[0].file, /^apps\/web\/src\/bridge\.ts$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects literal dynamic imports of internal modules", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "lazy.ts",
      [
        "export const loadInternal = () =>\n",
        '  import("../../../packages/ui/src/atoms/Text");\n',
        'export const loadSubpath = () => import("@bakery/ui/atoms/Text");\n',
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/internal-module",
      "ui/internal-module",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects upward Atomic imports inside the UI package", () => {
  const root = workspace();
  try {
    writeFileSync(
      join(root, "packages/ui/src/atoms/Badge.ts"),
      'import { Menu } from "../molecules/Menu";\nexport function Badge() { return null; }\n',
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), ["ui/atomic-direction"]);
    assert.match(diagnostics[0].message, /atoms imports molecules/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects direct className and style attributes in consumers", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      [
        'import { Text } from "@bakery/ui";\n',
        "export function Example() {\n",
        "  return (\n",
        "    <>\n",
        "      <Text>ok</Text>\n",
        '      <div className="raw" />\n',
        '      <div style={{ color: "red" }} />\n',
        "    </>\n",
        "  );\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/no-style-escape",
      "ui/no-style-escape",
    ]);
    assert.match(diagnostics[0].file, /^apps\/web\/src\/example\.tsx$/);
    assert(diagnostics[0].line > 0);
    assert(diagnostics[0].column > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe JSX spreads and fails closed on untyped spreads", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      [
        "interface StyledProps {\n",
        "  className?: string;\n",
        "}\n",
        "declare const styled: StyledProps;\n",
        "declare const widened: any;\n",
        "export function Example() {\n",
        "  return (\n",
        "    <>\n",
        '      <div {...{ className: "raw" }} />\n',
        "      <div {...styled} />\n",
        "      <div {...widened} />\n",
        "    </>\n",
        "  );\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/no-style-escape",
      "ui/no-style-escape",
      "ui/untyped-style-spread",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid dynamic variants on @bakery/ui JSX", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      [
        'import { Text } from "@bakery/ui";\n',
        "export function Example() {\n",
        '  return <Text className="widened">invalid</Text>;\n',
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/invalid-semantic-variant",
      "ui/no-style-escape",
    ]);
    assert.equal(
      diagnostics.find((d) => d.rule === "ui/invalid-semantic-variant").line,
      3,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emits actionable source-located diagnostics", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      "export function Example() {\n  return <div style={{}} />;\n}\n",
    );
    const { output } = run(root);
    assert.equal(output.length, 1);
    assert.match(
      output[0],
      /^apps\/web\/src\/example\.tsx:2:\d+ \[ui\/no-style-escape\] style is unsupported; use an @bakery\/ui semantic variant or slot$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enforces import rules in JavaScript consumer source", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "legacy.js",
      [
        'import { Text } from "@bakery/ui";\n',
        'import { Menu } from "@bakery/ui/src/molecules/Menu";\n',
        "export const loadInternal = () =>\n",
        '  import("../../../packages/ui/src/atoms/Text");\n',
        "export const rendered = () => Text;\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/internal-module",
      "ui/internal-module",
    ]);
    assert.match(diagnostics[0].file, /^apps\/web\/src\/legacy\.js$/);
    assert(diagnostics[0].line > 0);
    assert(diagnostics[0].column > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts compliant JavaScript consumer source", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "legacy.js",
      [
        'import { Text } from "@bakery/ui";\n',
        "export const rendered = () => Text;\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const SECTION_CONTRACT_IMPORT =
  'import { SectionNavigation, type SectionNavigationItem } from "@bakery/ui";\n';

function sectionListModule({ rendered = true, extra = "" } = {}) {
  return [
    SECTION_CONTRACT_IMPORT,
    "const sections: readonly SectionNavigationItem[] = [\n",
    '  { id: "overview", label: "Overview", href: "/app/overview" },\n',
    '  { id: "detail", label: "Detail", href: "/app/detail", matches: ["/app/detail/history"] },\n',
    "];\n",
    extra,
    rendered
      ? [
        "export function Example() {\n",
        "  return (\n",
        "    <SectionNavigation\n",
        '      currentPath="/app/overview"\n',
        "      items={sections}\n",
        '      label="App sections"\n',
        '      narrowMode="index"\n',
        "    />\n",
        "  );\n",
        "}\n",
      ].join("")
      : "export const exported = sections;\n",
  ].join("");
}

function satisfiesListModule() {
  return [
    SECTION_CONTRACT_IMPORT,
    "const sections = [\n",
    '  { id: "overview", label: "Overview", href: "/app/overview" },\n',
    '  { id: "detail", label: "Detail", href: "/app/detail", matches: ["/app/detail/history"] },\n',
    "] satisfies readonly SectionNavigationItem[];\n",
    "export function Example() {\n",
    "  return (\n",
    "    <SectionNavigation\n",
    '      currentPath="/app/overview"\n',
    "      items={sections}\n",
    '      label="App sections"\n',
    '      narrowMode="index"\n',
    "    />\n",
    "  );\n",
    "}\n",
  ].join("");
}

test("discovers compliant ordered section routes", () => {
  const root = workspace();
  try {
    writeConsumer(root, "sections.tsx", sectionListModule());
    const { diagnostics, sectionRoutes } = run(root);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(sectionRoutes, [
      {
        file: "apps/web/src/sections.tsx",
        id: "overview",
        href: "/app/overview",
        matches: [],
        fixture: false,
      },
      {
        file: "apps/web/src/sections.tsx",
        id: "detail",
        href: "/app/detail",
        matches: ["/app/detail/history"],
        fixture: false,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers a second independent Settings list", () => {
  const root = workspace();
  try {
    writeConsumer(root, "settings.tsx", sectionListModule());
    writeConsumer(
      root,
      "settings-archive.tsx",
      [
        SECTION_CONTRACT_IMPORT,
        "const archived: readonly SectionNavigationItem[] = [\n",
        '  { id: "billing", label: "Billing", href: "/settings/billing" },\n',
        '  { id: "usage", label: "Usage", href: "/settings/usage" },\n',
        "];\n",
        "export function Archive() {\n",
        "  return (\n",
        "    <SectionNavigation\n",
        '      currentPath="/settings/billing"\n',
        "      items={archived}\n",
        '      label="Archive sections"\n',
        '      narrowMode="menu"\n',
        "    />\n",
        "  );\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics, sectionRoutes } = run(root);
    assert.deepEqual(diagnostics, []);
    assert.equal(sectionRoutes.length, 4);
    assert.deepEqual(
      [...new Set(sectionRoutes.map((route) => route.file))].sort(),
      [
        "apps/web/src/settings-archive.tsx",
        "apps/web/src/settings.tsx",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifies fixture paths as fixture-proven routes", () => {
  const root = workspace();
  try {
    mkdirSync(join(root, "apps/web/src/fixtures"), { recursive: true });
    writeFileSync(
      join(root, "apps/web/src/fixtures/sections.tsx"),
      sectionListModule(),
    );
    const { diagnostics, sectionRoutes } = run(root);
    assert.deepEqual(diagnostics, []);
    assert.equal(sectionRoutes.length, 2);
    assert(sectionRoutes.every((route) => route.fixture));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires a SectionNavigation use in the owning module", () => {
  const root = workspace();
  try {
    writeConsumer(root, "orphan.tsx", sectionListModule({ rendered: false }));
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), ["ui/section-route-unrendered"]);
    assert.match(diagnostics[0].file, /^apps\/web\/src\/orphan\.tsx$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate section route ids and paths", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "duplicates.tsx",
      [
        SECTION_CONTRACT_IMPORT,
        "const sections: readonly SectionNavigationItem[] = [\n",
        '  { id: "same", label: "First", href: "/app/same" },\n',
        '  { id: "same", label: "Second", href: "/app/same" },\n',
        "];\n",
        "export function Example() {\n",
        "  return (\n",
        "    <SectionNavigation\n",
        '      currentPath="/app/same"\n',
        "      items={sections}\n",
        '      label="Duplicates"\n',
        '      narrowMode="index"\n',
        "    />\n",
        "  );\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/section-route-duplicate-id",
      "ui/section-route-duplicate-path",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects conflicting and non-descendant retention paths", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "conflicts.tsx",
      [
        SECTION_CONTRACT_IMPORT,
        "const sections: readonly SectionNavigationItem[] = [\n",
        '  { id: "one", label: "One", href: "/app", matches: ["/app/two"] },\n',
        '  { id: "two", label: "Two", href: "/app/two" },\n',
        '  { id: "three", label: "Three", href: "/app/three", matches: ["/elsewhere"] },\n',
        "];\n",
        "export function Example() {\n",
        "  return (\n",
        "    <SectionNavigation\n",
        '      currentPath="/app/one"\n',
        "      items={sections}\n",
        '      label="Conflicts"\n',
        '      narrowMode="index"\n',
        "    />\n",
        "  );\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/section-route-conflict",
      "ui/section-route-nondescendant",
    ]);
    assert.match(
      diagnostics.find((diagnostic) =>
        diagnostic.rule === "ui/section-route-conflict"
      )
        .message,
      /\/app\/two/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers newly checked-out consumer packages without a list", () => {
  const root = workspace();
  try {
    const plugin = join(root, "packages/plugin-fixture");
    mkdirSync(join(plugin, "src"), { recursive: true });
    writeFileSync(
      join(plugin, "package.json"),
      JSON.stringify({ name: "@bakery/plugin-fixture" }),
    );
    writeFileSync(
      join(plugin, "src/index.tsx"),
      [
        'import { Text } from "@bakery/ui";\n',
        "export function Plugin() {\n",
        '  return <div className="raw"><Text>plugin</Text></div>;\n',
        "}\n",
      ].join(""),
    );
    const { diagnostics, consumers } = run(root);
    assert.deepEqual(rules(diagnostics), ["ui/no-style-escape"]);
    assert.match(
      diagnostics[0].file,
      /^packages\/plugin-fixture\/src\/index\.tsx$/,
    );
    assert.deepEqual(consumers, ["@bakery/plugin-fixture"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function gitMaybe(args, cwd) {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

function gitRevParse(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function pluginPackage(root) {
  const plugin = join(root, "packages/plugin-fixture");
  mkdirSync(join(plugin, "src"), { recursive: true });
  writeFileSync(
    join(plugin, "package.json"),
    JSON.stringify({ name: "@bakery/plugin-fixture" }),
  );
  writeFileSync(
    join(plugin, "src/index.tsx"),
    [
      'import { Text } from "@bakery/ui";\n',
      "export function Plugin() {\n",
      "  return <Text>plugin</Text>;\n",
      "}\n",
    ].join(""),
  );
  return plugin;
}

function writeCatalog(root, ids) {
  const dir = join(root, "docs/technical-design/ui-baselines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "components.json"),
    JSON.stringify({
      entries: ids.map((id) => ({ id, requiredCases: [] })),
    }),
  );
}

function writeEvidenceIdentities(root, { visual }) {
  const dir = join(root, "docs/technical-design/ui-baselines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "paper-baselines.json"),
    JSON.stringify({
      schemaVersion: 1,
      cases: visual.map((id) => ({ id })),
    }),
  );
}

function writeLedger(root, records) {
  const dir = join(root, "docs/technical-design/ui-baselines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "coverage-removals.json"),
    `${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`,
  );
}

function contractionFixture({
  removePlugin = true,
  records,
  catalog,
  evidence,
} = {}) {
  const root = workspace();
  try {
    const plugin = pluginPackage(root);
    if (catalog) writeCatalog(root, catalog.base);
    if (evidence) writeEvidenceIdentities(root, evidence.base);
    git(["init"], root);
    git(["config", "user.email", "fixture@example.com"], root);
    git(["config", "user.name", "Fixture"], root);
    git(["add", "-A"], root);
    git(["commit", "-m", "base"], root);
    const baseSha = gitRevParse(root);
    if (removePlugin) rmSync(plugin, { recursive: true, force: true });
    if (catalog) writeCatalog(root, catalog.candidate);
    if (evidence) writeEvidenceIdentities(root, evidence.candidate);
    if (records) {
      writeLedger(
        root,
        typeof records === "function" ? records(baseSha) : records,
      );
    }
    return { root, baseSha };
  } catch (cause) {
    rmSync(root, { recursive: true, force: true });
    throw cause;
  }
}

function removalRecord(baseSha, overrides = {}) {
  return {
    baseSha,
    kind: "ui-consumer",
    identity: "@bakery/plugin-fixture",
    rationale: "The fixture package is no longer checked out.",
    retired: true,
    ...overrides,
  };
}

test("fails closed on unauthorized coverage removals", () => {
  const { root, baseSha } = contractionFixture();
  try {
    assert.throws(
      () => run(root, { base: baseSha }),
      /unauthorized removal of ui-consumer @bakery\/plugin-fixture/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts one exact new removal record", () => {
  const { root, baseSha } = contractionFixture({
    records: (resolved) => [removalRecord(resolved)],
  });
  try {
    const result = run(root, { base: baseSha });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.baseSha, baseSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes catalog removals from the materialized merge base", () => {
  const { root, baseSha } = contractionFixture({
    removePlugin: false,
    catalog: { base: ["ui.a", "ui.b"], candidate: ["ui.a"] },
    records: (resolved) => [{
      baseSha: resolved,
      kind: "catalog-id",
      identity: "ui.b",
      rationale: "The component left the catalog with this change.",
      replacement: "ui.a",
    }],
  });
  try {
    const result = run(root, { base: baseSha });
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on unauthorized visual baseline removals", () => {
  const { root, baseSha } = contractionFixture({
    removePlugin: false,
    evidence: {
      base: { visual: ["ui.button.paper"] },
      candidate: { visual: [] },
    },
  });
  try {
    assert.throws(
      () => run(root, { base: baseSha }),
      /unauthorized removal of visual-baseline ui\.button\.paper/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects stale, pre-existing, wildcard, duplicate, blank, and ambiguous records", () => {
  const cases = [
    {
      name: "stale base SHA",
      records: () => [removalRecord("0".repeat(40))],
      pattern: /stale base SHA/,
    },
    {
      name: "pre-existing identity",
      removePlugin: false,
      records: (resolved) => [removalRecord(resolved)],
      pattern: /already present in the candidate/,
    },
    {
      name: "wildcard identity",
      records: (
        resolved,
      ) => [removalRecord(resolved, { identity: "@bakery/*" })],
      pattern: /wildcard removal identity/,
    },
    {
      name: "duplicate records",
      records: (resolved) => [removalRecord(resolved), removalRecord(resolved)],
      pattern: /duplicate removal record/,
    },
    {
      name: "blank rationale",
      records: (resolved) => [removalRecord(resolved, { rationale: "   " })],
      pattern: /blank rationale/,
    },
    {
      name: "ambiguous disposition with both",
      records: (resolved) => [removalRecord(resolved, {
        replacement: "@bakery/web",
        retired: true,
      })],
      pattern: /ambiguous disposition/,
    },
    {
      name: "ambiguous disposition with neither",
      records: (resolved) => [{
        baseSha: resolved,
        kind: "ui-consumer",
        identity: "@bakery/plugin-fixture",
        rationale: "The fixture package is no longer checked out.",
      }],
      pattern: /ambiguous disposition/,
    },
  ];
  for (const scenario of cases) {
    const { root, baseSha } = contractionFixture({
      removePlugin: scenario.removePlugin ?? true,
      records: scenario.records,
    });
    try {
      assert.throws(
        () => run(root, { base: baseSha }),
        scenario.pattern,
        scenario.name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("resolves a bare pull-request base ref through origin", () => {
  const { root, baseSha } = contractionFixture({
    records: (resolved) => [removalRecord(resolved)],
  });
  const origin = `${root}-origin`;
  try {
    git(["init", "--bare", origin]);
    git(["remote", "add", "origin", origin], root);
    git(["push", "origin", "HEAD:refs/heads/main"], root);
    git(["checkout", "--detach"], root);
    gitMaybe(["branch", "-D", "main"], root);
    gitMaybe(["branch", "-D", "master"], root);
    const result = run(root, { base: "main" });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.baseSha, baseSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("prefers origin/main over a divergent local main branch", () => {
  const { root, baseSha } = contractionFixture({
    records: (resolved) => [removalRecord(resolved)],
  });
  const origin = `${root}-origin`;
  try {
    git(["init", "--bare", origin]);
    git(["remote", "add", "origin", origin], root);
    git(["push", "origin", `${baseSha}:refs/heads/main`], root);
    git(["add", "-A"], root);
    git(["commit", "-m", "candidate"], root);
    const candidateSha = gitRevParse(root);
    git(["checkout", "-B", "main", candidateSha], root);
    git(["fetch", "origin"], root);
    const result = run(root, { base: "main" });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.baseSha, baseSha);
    assert.notEqual(candidateSha, baseSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("resolves a slash-containing pull-request base ref through origin", () => {
  const { root, baseSha } = contractionFixture({
    records: (resolved) => [removalRecord(resolved)],
  });
  const origin = `${root}-origin`;
  const previous = process.env.GITHUB_BASE_REF;
  try {
    git(["init", "--bare", origin]);
    git(["remote", "add", "origin", origin], root);
    git([
      "push",
      "origin",
      "HEAD:refs/heads/ci/issue-245-trusted-bootstrap",
    ], root);
    git(["fetch", "origin"], root);
    process.env.GITHUB_BASE_REF = "ci/issue-245-trusted-bootstrap";
    const result = run(root);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.baseSha, baseSha);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("fails closed when a bare base ref has no origin counterpart", () => {
  const { root } = contractionFixture({
    records: () => [],
  });
  try {
    assert.throws(
      () => run(root, { base: "ghost-branch" }),
      /cannot resolve contraction base/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when an explicit base ref looks like a git option", () => {
  const { root } = contractionFixture({
    records: () => [],
  });
  try {
    assert.throws(
      () => run(root, { base: "--octopus" }),
      /cannot resolve contraction base "--octopus"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers the contraction base in a shallow checkout", () => {
  const { root, baseSha } = contractionFixture({
    records: (resolved) => [removalRecord(resolved)],
  });
  const origin = `${root}-origin`;
  try {
    git(["init", "--bare", origin]);
    git(["remote", "add", "origin", origin], root);
    git(["push", "origin", "HEAD:refs/heads/main"], root);
    gitMaybe(["branch", "-D", "main"], root);
    gitMaybe(["branch", "-D", "master"], root);
    git(["fetch", "--depth=1", "origin", "main"], root);
    git(["update-ref", "-d", "refs/remotes/origin/main"], root);
    const result = run(root, { base: "main" });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.baseSha, baseSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("falls back to origin/main when GITHUB_BASE_REF is blank", () => {
  const { root, baseSha } = contractionFixture({
    records: (resolved) => [removalRecord(resolved)],
  });
  const origin = `${root}-origin`;
  const previous = process.env.GITHUB_BASE_REF;
  try {
    git(["init", "--bare", origin]);
    git(["remote", "add", "origin", origin], root);
    git(["push", "origin", "HEAD:refs/heads/main"], root);
    process.env.GITHUB_BASE_REF = "";
    const result = run(root);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.baseSha, baseSha);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("uses explicit base despite an invalid GITHUB_BASE_REF", () => {
  const { root, baseSha } = contractionFixture({
    records: (resolved) => [removalRecord(resolved)],
  });
  const previous = process.env.GITHUB_BASE_REF;
  try {
    process.env.GITHUB_BASE_REF = "missing-base";
    const result = run(root, { base: baseSha });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.baseSha, baseSha);
    assert.ok(
      result.output.some((line) =>
        line.startsWith(`Contraction base ${baseSha} (`)
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects removals when origin/main points at the committed candidate", () => {
  const { root, baseSha } = contractionFixture();
  const origin = `${root}-origin`;
  try {
    git(["init", "--bare", origin]);
    git(["remote", "add", "origin", origin], root);
    git(["add", "-A"], root);
    git(["commit", "-m", "candidate"], root);
    git(["push", "origin", "HEAD:refs/heads/main"], root);
    assert.throws(
      () => run(root, { base: "origin/main^" }),
      /unauthorized removal of ui-consumer @bakery\/plugin-fixture/,
    );
    assert.notEqual(gitRevParse(root), baseSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("uses current origin/main for a feature branch contraction", () => {
  const { root } = contractionFixture();
  const origin = `${root}-origin`;
  try {
    git(["init", "--bare", origin]);
    git(["remote", "add", "origin", origin], root);
    git(["push", "origin", "HEAD:refs/heads/main"], root);
    assert.throws(
      () => run(root, { base: "origin/main" }),
      /unauthorized removal of ui-consumer @bakery\/plugin-fixture/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("rejects union-typed and type-parameter JSX spreads", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      [
        "interface SafeProps {\n",
        "  id: string;\n",
        "}\n",
        "interface StyledProps {\n",
        "  className?: string;\n",
        "}\n",
        "declare const unionProps: SafeProps | StyledProps;\n",
        "export function Slot<T extends object>(props: T) {\n",
        "  return <div {...props} />;\n",
        "}\n",
        "export function Example() {\n",
        "  return <div {...unionProps} />;\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/no-style-escape",
      "ui/untyped-style-spread",
    ]);
    assert.match(
      diagnostics.find((diagnostic) =>
        diagnostic.rule === "ui/untyped-style-spread"
      )
        .message,
      /cannot be proven free/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects object-literal, accessor, and index-signature style spreads", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      [
        "declare const indexed: Record<string, string>;\n",
        "export function Example() {\n",
        "  return (\n",
        "    <>\n",
        '      <div {...{ ["className"]: "raw" }} />\n',
        '      <div {...{ get className() { return "raw"; } }} />\n',
        "      <div {...indexed} />\n",
        "    </>\n",
        "  );\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/no-style-escape",
      "ui/no-style-escape",
      "ui/no-style-escape",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves upward Atomic imports through root and intermediate barrels", () => {
  const root = workspace();
  try {
    writeFileSync(
      join(root, "packages/ui/src/organisms/index.ts"),
      'export { SectionNavigation } from "./SectionNavigation";\n',
    );
    writeFileSync(
      join(root, "packages/ui/src/atoms/Badge.ts"),
      'import { SectionNavigation } from "../index";\nexport function Badge() { return SectionNavigation; }\n',
    );
    const rootBarrel = run(root);
    assert.deepEqual(rules(rootBarrel.diagnostics), ["ui/atomic-direction"]);
    assert.match(rootBarrel.diagnostics[0].message, /atoms imports organisms/);

    writeFileSync(
      join(root, "packages/ui/src/atoms/Badge.ts"),
      'import { SectionNavigation } from "../organisms";\nexport function Badge() { return SectionNavigation; }\n',
    );
    const intermediate = run(root);
    assert.deepEqual(rules(intermediate.diagnostics), ["ui/atomic-direction"]);
    assert.match(
      intermediate.diagnostics[0].message,
      /atoms imports organisms/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a downward Atomic barrel import", () => {
  const root = workspace();
  try {
    writeFileSync(
      join(root, "packages/ui/src/atoms/index.ts"),
      'export { Text } from "./Text";\n',
    );
    writeFileSync(
      join(root, "packages/ui/src/organisms/UsesText.ts"),
      'import { Text } from "../atoms";\nexport function UsesText() { return Text; }\n',
    );
    const { diagnostics } = run(root);
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects namespace imports of higher Atomic levels through the root barrel", () => {
  const root = workspace();
  try {
    writeFileSync(
      join(root, "packages/ui/src/atoms/Badge.ts"),
      'import * as ui from "../index";\nexport function Badge() { return ui.SectionNavigation; }\n',
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), ["ui/atomic-direction"]);
    assert.match(diagnostics[0].message, /atoms imports organisms/);
    assert.match(diagnostics[0].file, /^packages\/ui\/src\/atoms\/Badge\.ts$/);
    assert(diagnostics[0].line > 0);
    assert(diagnostics[0].column > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a downward namespace import of a lower Atomic level", () => {
  const root = workspace();
  try {
    writeFileSync(
      join(root, "packages/ui/src/atoms/index.ts"),
      'export { Text } from "./Text";\n',
    );
    writeFileSync(
      join(root, "packages/ui/src/organisms/UsesText.ts"),
      'import * as atoms from "../atoms";\nexport function UsesText() { return atoms.Text; }\n',
    );
    const { diagnostics } = run(root);
    assert.deepEqual(diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects internal source imported through a valid .js specifier", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "example.tsx",
      [
        'import { Text } from "../../../packages/ui/src/atoms/Text.js";\n',
        "export function Example() {\n",
        "  return <Text>ok</Text>;\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics, consumers } = run(root);
    assert.deepEqual(rules(diagnostics), ["ui/internal-module"]);
    assert.match(diagnostics[0].file, /^apps\/web\/src\/example\.tsx$/);
    assert.deepEqual(consumers, ["@bakery/web"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers compliant satisfies-declared section routes", () => {
  const root = workspace();
  try {
    writeConsumer(root, "satisfies.tsx", satisfiesListModule());
    const { diagnostics, sectionRoutes } = run(root);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      sectionRoutes.map((route) => route.id),
      ["overview", "detail"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate satisfies-declared section routes", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "satisfies.tsx",
      [
        SECTION_CONTRACT_IMPORT,
        "const sections = [\n",
        '  { id: "same", label: "First", href: "/app/same" },\n',
        '  { id: "same", label: "Second", href: "/app/same" },\n',
        "] satisfies readonly SectionNavigationItem[];\n",
        "export function Example() {\n",
        "  return (\n",
        "    <SectionNavigation\n",
        '      currentPath="/app/same"\n',
        "      items={sections}\n",
        '      label="Duplicates"\n',
        '      narrowMode="index"\n',
        "    />\n",
        "  );\n",
        "}\n",
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/section-route-duplicate-id",
      "ui/section-route-duplicate-path",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function appRouteModule(
  entries,
  specimens = entries.map((entry) => entry.path),
) {
  return [
    "declare function createRoute(options: { path: string }): unknown;\n",
    `export const routeCoverage = ${JSON.stringify(entries)} as const;\n`,
    ...specimens.map((path, index) =>
      `const route${index} = createRoute({ path: ${JSON.stringify(path)} });\n`
    ),
  ].join("");
}

const STATUS_APP_ROUTE = {
  id: "status",
  path: "/",
  classification: "production",
  states: ["loading", "ready", "error"],
};

test("discovers literal app routes and route states", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "router.ts",
      appRouteModule([
        STATUS_APP_ROUTE,
        {
          id: "fixture-empty",
          path: "/__fixtures__/empty",
          classification: "fixture",
          states: ["empty"],
        },
      ]),
    );
    const { diagnostics, appRoutes, identitySets } = run(root);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      appRoutes.map((route) => route.id),
      ["status", "fixture-empty"],
    );
    assert(identitySets["app-route"].has(
      "apps/web/src/router.ts|production|status|/",
    ));
    assert(identitySets["route-state"].has(
      "apps/web/src/router.ts|status|loading",
    ));
    assert(identitySets["route-state"].has(
      "apps/web/src/router.ts|fixture-empty|empty",
    ));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate app route identities and states", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "router.ts",
      appRouteModule([
        STATUS_APP_ROUTE,
        { ...STATUS_APP_ROUTE, states: ["ready", "ready"] },
      ], ["/"]),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/app-route-duplicate-id",
      "ui/app-route-duplicate-path",
      "ui/route-state-duplicate",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed app route metadata and omitted states", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "router.ts",
      [
        'const computedId = "status";\n',
        "declare function createRoute(options: { path: string }): unknown;\n",
        "export const routeCoverage = [\n",
        '  { id: computedId, path: "/", classification: "production", states: ["ready"] },\n',
        '  { id: "empty-state", path: "/empty", classification: "production", states: [] },\n',
        '  { id: "unknown-state", path: "/unknown", classification: "production", states: ["spinning"] },\n',
        "] as const;\n",
        'const rootRoute = createRoute({ path: "/" });\n',
        'const emptyRoute = createRoute({ path: "/empty" });\n',
        'const unknownRoute = createRoute({ path: "/unknown" });\n',
      ].join(""),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/app-route-invalid",
      "ui/app-route-untracked-specimen",
      "ui/route-state-invalid",
      "ui/route-state-missing",
      "ui/route-state-missing",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires each app route metadata entry to match a specimen", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "router.ts",
      appRouteModule([STATUS_APP_ROUTE], ["/different"]),
    );
    const { diagnostics } = run(root);
    assert.deepEqual(rules(diagnostics), [
      "ui/app-route-missing-specimen",
      "ui/app-route-untracked-specimen",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function routeContractionFixture(baseEntries, candidateEntries) {
  const root = workspace();
  try {
    writeConsumer(root, "router.ts", appRouteModule(baseEntries));
    git(["init"], root);
    git(["config", "user.email", "fixture@example.com"], root);
    git(["config", "user.name", "Fixture"], root);
    git(["add", "-A"], root);
    git(["commit", "-m", "base"], root);
    const baseSha = gitRevParse(root);
    writeConsumer(root, "router.ts", appRouteModule(candidateEntries));
    return { root, baseSha };
  } catch (cause) {
    rmSync(root, { recursive: true, force: true });
    throw cause;
  }
}

test("fails closed when an app route identity contracts", () => {
  const appearance = {
    id: "appearance",
    path: "/settings/appearance",
    classification: "production",
    states: ["ready"],
  };
  const { root, baseSha } = routeContractionFixture(
    [STATUS_APP_ROUTE, appearance],
    [STATUS_APP_ROUTE],
  );
  try {
    assert.throws(
      () => run(root, { base: baseSha }),
      (cause) => {
        assert.match(
          cause.message,
          /unauthorized removal of app-route apps\/web\/src\/router\.ts\|production\|appearance\|\/settings\/appearance/,
        );
        assert.match(
          cause.message,
          /unauthorized removal of route-state apps\/web\/src\/router\.ts\|appearance\|ready/,
        );
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when a route state identity contracts", () => {
  const { root, baseSha } = routeContractionFixture(
    [STATUS_APP_ROUTE],
    [{ ...STATUS_APP_ROUTE, states: ["loading", "ready"] }],
  );
  try {
    assert.throws(
      () => run(root, { base: baseSha }),
      /unauthorized removal of route-state apps\/web\/src\/router\.ts\|status\|error/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs both checker CLIs under the current toolchain", () => {
  const architectureScript = fileURLToPath(
    new URL("../../scripts/check-ui-architecture.mjs", import.meta.url),
  );
  let result;
  try {
    execFileSync(process.execPath, [
      architectureScript,
      "--base",
      "ghost-branch",
    ], {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    result = cause;
  }
  assert(result, "expected the architecture CLI to execute its check");
  assert.equal(result.status, 1);
  assert.match(
    String(result.stderr),
    /cannot resolve contraction base "ghost-branch"/,
  );

  const exportsScript = fileURLToPath(
    new URL("../../packages/ui/scripts/check-exports.mjs", import.meta.url),
  );
  const output = execFileSync(
    process.execPath,
    [exportsScript],
    { cwd: ROOT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(output, /Resolved runtime exports \(\d+\):/);
});

const REFERENCE_DIRECTORY = "docs/technical-design/ui-baselines";
const REFERENCE_FILE_ID = "01M1X504XVC45FC0VDK857A37D";
const FIXTURE_ROUTE = {
  id: "fixture-auth",
  path: "/__fixtures__/auth/$state",
  classification: "fixture",
  states: ["default"],
};

function referenceFrame(overrides = {}) {
  return {
    fileId: REFERENCE_FILE_ID,
    pageId: "V-0",
    frameId: "HJD-0",
    device: "desktop",
    theme: "light",
    state: "default",
    ...overrides,
  };
}

function baselinedEntry(overrides = {}) {
  return {
    routeId: "status",
    path: "/",
    status: "baselined",
    manifest: "auth",
    frames: [referenceFrame()],
    cases: ["status.default.light.desktop"],
    ...overrides,
  };
}

function writeReferenceFiles(
  root,
  {
    entries,
    cases,
    raw,
    enterpriseCases,
    settingsCases,
    entitlementsCases,
    artifactsCases,
  },
) {
  const dir = join(root, REFERENCE_DIRECTORY);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "route-references.json"),
    raw ?? `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`,
  );
  if (enterpriseCases) {
    writeFileSync(
      join(dir, "enterprise-baselines.json"),
      JSON.stringify({ schemaVersion: 2, cases: enterpriseCases }),
    );
  }
  if (settingsCases) {
    writeFileSync(
      join(dir, "settings-baselines.json"),
      JSON.stringify({ schemaVersion: 2, cases: settingsCases }),
    );
  }
  if (entitlementsCases) {
    writeFileSync(
      join(dir, "entitlements-baselines.json"),
      JSON.stringify({ schemaVersion: 2, cases: entitlementsCases }),
    );
  }
  if (artifactsCases) {
    writeFileSync(
      join(dir, "artifacts-baselines.json"),
      JSON.stringify({ schemaVersion: 2, cases: artifactsCases }),
    );
  }
  if (cases) {
    writeFileSync(
      join(dir, "paper-baselines.json"),
      JSON.stringify({ schemaVersion: 2, cases }),
    );
  }
}

const STATUS_CASE = {
  id: "status.default.light.desktop",
  frameId: "HJD-0",
  candidate: { route: "/__fixtures__/auth/status-default" },
};

function referenceWorkspace(
  {
    entries,
    cases = [STATUS_CASE],
    routes = [STATUS_APP_ROUTE, FIXTURE_ROUTE],
    raw,
    // Planned entries name the enterprise manifest, so a workspace carries one
    // by default; pass `null` to leave the file absent.
    enterpriseCases = [{ id: "queue.default.light.desktop" }],
    // The settings manifest is absent by default, as it is on main until the
    // first settings cases land; pass cases to create it.
    settingsCases = null,
    // The entitlements manifest is absent by default, like settings; planned
    // entitlements entries need it to exist.
    entitlementsCases = null,
    artifactsCases = null,
  },
) {
  const root = workspace();
  writeConsumer(root, "router.ts", appRouteModule(routes));
  writeReferenceFiles(root, {
    entries,
    cases,
    raw,
    enterpriseCases,
    settingsCases,
    entitlementsCases,
    artifactsCases,
  });
  return root;
}

function referenceRules(options) {
  const root = referenceWorkspace(options);
  try {
    return rules(run(root).diagnostics);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a ledger that covers every production route", () => {
  assert.deepEqual(referenceRules({ entries: [baselinedEntry()] }), []);
});

test("accepts no-mock, debt, and planned entries with rationale", () => {
  const entries = [
    {
      routeId: "status",
      path: "/",
      status: "no-mock",
      rationale: "Searched all Paper artboards for status; none exists.",
      frames: [],
    },
    {
      routeId: "tasks",
      path: "/tasks",
      status: "planned",
      rationale: "Ships on a later branch.",
      manifest: "enterprise",
      frames: [referenceFrame({ frameId: "5J-0", pageId: "E-0" })],
      cases: ["queue.default.light.desktop"],
    },
  ];
  assert.deepEqual(referenceRules({ entries }), []);
  const debt = [{
    routeId: "status",
    path: "/",
    status: "debt",
    rationale: "Frame exists; no golden yet. Searched Paper page E-0.",
    frames: [referenceFrame()],
  }];
  assert.deepEqual(referenceRules({ entries: debt }), []);
});

test("rejects a production route with no ledger entry", () => {
  assert.deepEqual(referenceRules({ entries: [] }), [
    "ui/route-reference-missing",
  ]);
});

test("rejects a baselined frame without a matching manifest case", () => {
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry({ cases: ["status.other.light.desktop"] })],
    }),
    ["ui/route-reference-unbaselined", "ui/route-reference-unbaselined"],
  );
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry()],
      cases: [{ ...STATUS_CASE, frameId: "OTHER-0" }],
    }),
    ["ui/route-reference-unbaselined"],
  );
});

test("rejects a baselined case whose candidate route is missing or not a fixture", () => {
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry()],
      cases: [{ ...STATUS_CASE, candidate: {} }],
    }),
    ["ui/route-reference-unbaselined"],
  );
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry()],
      cases: [{ ...STATUS_CASE, candidate: { route: "/__fixtures__/nope/x" } }],
    }),
    ["ui/route-reference-unbaselined"],
  );
});

test("rejects a baselined entry whose manifest file is absent", () => {
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry({ manifest: "enterprise" })],
      enterpriseCases: null,
    }),
    ["ui/route-reference-unbaselined"],
  );
});

const PROFILE_CASE = {
  id: "profile.default.light.desktop",
  frameId: "HJE-0",
  candidate: { route: "/__fixtures__/auth/status-default" },
};

const settingsEntry = (overrides = {}) =>
  baselinedEntry({
    manifest: "settings",
    frames: [referenceFrame({ frameId: "HJE-0", pageId: "O-0" })],
    cases: ["profile.default.light.desktop"],
    ...overrides,
  });

const ARTIFACT_CASE = {
  id: "artifact.default.light.desktop",
  frameId: "ARTIFACT-0",
  candidate: { route: "/__fixtures__/auth/status-default" },
};

const artifactsEntry = (overrides = {}) =>
  baselinedEntry({
    manifest: "artifacts",
    frames: [referenceFrame({ frameId: "ARTIFACT-0", pageId: "E05" })],
    cases: [ARTIFACT_CASE.id],
    ...overrides,
  });

test("accepts a baselined entry on the artifacts manifest", () => {
  assert.deepEqual(
    referenceRules({
      entries: [artifactsEntry()],
      artifactsCases: [ARTIFACT_CASE],
    }),
    [],
  );
});

const CONVERSATION_CASE = {
  id: "conversation.default.light.desktop",
  frameId: "CONV-0",
  candidate: { route: "/__fixtures__/auth/status-default" },
};

const withConversation = (overrides = {}) =>
  baselinedEntry({
    additionalManifests: [{
      manifest: "enterprise",
      frames: [referenceFrame({ frameId: "CONV-0", pageId: "p-18-0" })],
      cases: [CONVERSATION_CASE.id],
      ...overrides,
    }],
  });

test("accepts a baselined entry that also lists cases from another manifest", () => {
  assert.deepEqual(
    referenceRules({
      entries: [withConversation()],
      enterpriseCases: [CONVERSATION_CASE],
    }),
    [],
  );
});

test("checks additional manifest cases like the entry's own cases", () => {
  // Case absent: the case and its now uncovered frame are both reported.
  assert.deepEqual(
    referenceRules({
      entries: [withConversation({ cases: ["conversation.nope"] })],
      enterpriseCases: [CONVERSATION_CASE],
    }),
    ["ui/route-reference-unbaselined", "ui/route-reference-unbaselined"],
  );
  // A frame whose listed case scores another frame.
  assert.deepEqual(
    referenceRules({
      entries: [withConversation()],
      enterpriseCases: [{ ...CONVERSATION_CASE, frameId: "OTHER-0" }],
    }),
    ["ui/route-reference-unbaselined"],
  );
  // A candidate route that matches no fixture route.
  assert.deepEqual(
    referenceRules({
      entries: [withConversation()],
      enterpriseCases: [{
        ...CONVERSATION_CASE,
        candidate: { route: "/__fixtures__/nope/x" },
      }],
    }),
    ["ui/route-reference-unbaselined"],
  );
  // The additional manifest file is missing.
  assert.deepEqual(
    referenceRules({ entries: [withConversation()], enterpriseCases: null }),
    ["ui/route-reference-unbaselined"],
  );
});

test("rejects additional manifests on unbaselined entries or repeating a manifest", () => {
  const planned = plannedEnterprise({
    additionalManifests: [{
      manifest: "auth",
      frames: [referenceFrame()],
      cases: [STATUS_CASE.id],
    }],
  });
  assert.deepEqual(
    referenceRules({ entries: [baselinedEntry(), planned] }),
    ["ui/route-reference-invalid"],
  );
  assert.deepEqual(
    referenceRules({
      entries: [withConversation({ manifest: "auth" })],
      enterpriseCases: [CONVERSATION_CASE],
    }),
    ["ui/route-reference-invalid"],
  );
});

test("rejects an additional manifest case another entry already claims", () => {
  const other = plannedEnterprise({ cases: [CONVERSATION_CASE.id] });
  assert.deepEqual(
    referenceRules({
      entries: [withConversation(), other],
      enterpriseCases: [CONVERSATION_CASE],
    }),
    ["ui/route-reference-invalid"],
  );
});

test("accepts planned artifacts cases before their route ships", () => {
  assert.deepEqual(
    referenceRules({
      entries: [
        baselinedEntry(),
        artifactsEntry({
          routeId: "artifact-page",
          path: "/artifacts/$artifactId",
          status: "planned",
          rationale: "Reference exists before the artifact page ships.",
        }),
      ],
      artifactsCases: [ARTIFACT_CASE],
    }),
    [],
  );
});

test("rejects planned artifacts cases after their route ships", () => {
  assert.deepEqual(
    referenceRules({
      entries: [artifactsEntry({
        status: "planned",
        rationale: "Reference exists before the artifact page ships.",
      })],
      artifactsCases: [ARTIFACT_CASE],
    }),
    ["ui/route-reference-planned-present"],
  );
});

test("rejects artifacts references without their manifest", () => {
  assert.deepEqual(
    referenceRules({ entries: [artifactsEntry()] }),
    ["ui/route-reference-unbaselined"],
  );
});

test("accepts a baselined entry on the settings manifest", () => {
  assert.deepEqual(
    referenceRules({
      entries: [settingsEntry()],
      settingsCases: [PROFILE_CASE],
    }),
    [],
  );
});

test("rejects a baselined settings entry whose manifest file is absent", () => {
  assert.deepEqual(
    referenceRules({ entries: [settingsEntry()], settingsCases: null }),
    ["ui/route-reference-unbaselined"],
  );
});

test("rejects a baselined settings case or frame missing from the manifest", () => {
  assert.deepEqual(
    referenceRules({
      entries: [settingsEntry({ cases: ["other.default.light.desktop"] })],
      settingsCases: [PROFILE_CASE],
    }),
    ["ui/route-reference-unbaselined", "ui/route-reference-unbaselined"],
  );
  assert.deepEqual(
    referenceRules({
      entries: [settingsEntry()],
      settingsCases: [{ ...PROFILE_CASE, frameId: "OTHER-0" }],
    }),
    ["ui/route-reference-unbaselined"],
  );
});

test("rejects a planned entry on the settings manifest even over real cases", () => {
  const planned = settingsEntry({
    routeId: "later",
    path: "/later",
    status: "planned",
    rationale: "Settings cannot defer scoring.",
  });
  const seen = referenceRules({
    entries: [baselinedEntry(), planned],
    settingsCases: [PROFILE_CASE],
  });
  assert.ok(seen.includes("ui/route-reference-invalid"), seen.join());
});

const plannedEntitlements = (overrides = {}) => ({
  routeId: "organization-sso",
  path: "/organization/sso",
  status: "planned",
  rationale: "Ships in a later E16 phase.",
  manifest: "entitlements",
  frames: [referenceFrame({ frameId: "2DA1-0", pageId: "p-17-0" })],
  cases: ["sso.list.light.desktop"],
  ...overrides,
});

const ENTITLEMENTS_CASE = { id: "sso.list.light.desktop" };

test("accepts a planned entry on the entitlements manifest", () => {
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry(), plannedEntitlements()],
      entitlementsCases: [ENTITLEMENTS_CASE],
    }),
    [],
  );
});

test("rejects a planned entitlements entry whose manifest file is missing", () => {
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry(), plannedEntitlements()],
      entitlementsCases: null,
    }),
    ["ui/route-reference-invalid"],
  );
});

test("rejects a planned entitlements case absent from its manifest", () => {
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry(), plannedEntitlements()],
      entitlementsCases: [{ id: "other.case" }],
    }),
    ["ui/route-reference-invalid"],
  );
});

test("rejects a planned entry whose route now exists", () => {
  assert.deepEqual(
    referenceRules({
      entries: [
        baselinedEntry({
          status: "planned",
          rationale: "Not shipped yet.",
          manifest: "enterprise",
          cases: ["queue.default.light.desktop"],
        }),
      ],
    }),
    ["ui/route-reference-planned-present"],
  );
});

const plannedEnterprise = (overrides = {}) => ({
  routeId: "tasks",
  path: "/tasks",
  status: "planned",
  rationale: "Ships on a later branch.",
  manifest: "enterprise",
  frames: [referenceFrame({ frameId: "5J-0", pageId: "E-0" })],
  cases: ["queue.default.light.desktop"],
  ...overrides,
});

test("rejects a planned entry on the auth manifest, even over real auth cases", () => {
  const fake = plannedEnterprise({
    routeId: "fake-dodge",
    path: "/fake",
    manifest: "auth",
    cases: ["status.default.light.desktop"],
  });
  const rulesSeen = referenceRules({ entries: [baselinedEntry(), fake] });
  assert.ok(rulesSeen.includes("ui/route-reference-invalid"), rulesSeen.join());
});

test("rejects one case claimed by two ledger entries", () => {
  const entries = [
    baselinedEntry(),
    plannedEnterprise(),
    plannedEnterprise({ routeId: "tasks-twin", path: "/tasks-twin" }),
  ];
  assert.deepEqual(referenceRules({ entries }), [
    "ui/route-reference-invalid",
  ]);
  const baselinedDup = [
    baselinedEntry(),
    plannedEnterprise({
      routeId: "other",
      path: "/other",
      cases: ["queue.default.light.desktop"],
    }),
    baselinedEntry({
      routeId: "dup",
      path: "/dup",
      manifest: "enterprise",
      cases: ["queue.default.light.desktop"],
    }),
  ];
  assert.ok(
    referenceRules({ entries: baselinedDup }).includes(
      "ui/route-reference-invalid",
    ),
  );
});

test("rejects a planned case absent from an existing enterprise manifest", () => {
  const entries = [baselinedEntry(), plannedEnterprise()];
  assert.deepEqual(
    referenceRules({ entries, enterpriseCases: [{ id: "other.case" }] }),
    ["ui/route-reference-invalid"],
  );
  assert.deepEqual(
    referenceRules({
      entries,
      enterpriseCases: [{ id: "queue.default.light.desktop" }],
    }),
    [],
  );
});

test("rejects a planned entry whose enterprise manifest file is missing", () => {
  assert.deepEqual(
    referenceRules({
      entries: [baselinedEntry(), plannedEnterprise()],
      enterpriseCases: null,
    }),
    ["ui/route-reference-invalid"],
  );
});

test("rejects a case id listed twice within one ledger entry", () => {
  assert.deepEqual(
    referenceRules({
      entries: [
        baselinedEntry(),
        plannedEnterprise({
          cases: [
            "queue.default.light.desktop",
            "queue.default.light.desktop",
          ],
        }),
      ],
    }),
    ["ui/route-reference-invalid"],
  );
  assert.deepEqual(
    referenceRules({
      entries: [
        baselinedEntry({
          cases: [
            "status.default.light.desktop",
            "status.default.light.desktop",
          ],
        }),
      ],
    }),
    ["ui/route-reference-invalid"],
  );
});

test("rejects stale entries for routes that left routeCoverage", () => {
  const entries = [
    baselinedEntry(),
    baselinedEntry({
      routeId: "gone",
      path: "/gone",
      manifest: "auth",
      cases: ["gone.default.light.desktop"],
    }),
  ];
  assert.deepEqual(referenceRules({ entries }), ["ui/route-reference-stale"]);
  assert.deepEqual(
    referenceRules({ entries: [baselinedEntry({ path: "/moved" })] }),
    ["ui/route-reference-stale"],
  );
});

test("rejects an invalid ledger with located diagnostics", () => {
  const blank = {
    routeId: "status",
    path: "/",
    status: "debt",
    frames: [referenceFrame()],
  };
  assert.deepEqual(referenceRules({ entries: [blank] }), [
    "ui/route-reference-invalid",
  ]);
  assert.deepEqual(referenceRules({ raw: "{ not json" }), [
    "ui/route-reference-invalid",
  ]);
  const duplicate = [baselinedEntry(), baselinedEntry()];
  assert.deepEqual(referenceRules({ entries: duplicate }), [
    "ui/route-reference-invalid",
  ]);
  const extra = [{ ...baselinedEntry(), surprise: true }];
  assert.deepEqual(referenceRules({ entries: extra }), [
    "ui/route-reference-invalid",
  ]);
});

function debtLedgerFixture(baseEntries, candidateEntries) {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "router.ts",
      appRouteModule([STATUS_APP_ROUTE, FIXTURE_ROUTE]),
    );
    writeReferenceFiles(root, {
      entries: baseEntries,
      cases: [STATUS_CASE],
    });
    git(["init"], root);
    git(["config", "user.email", "fixture@example.com"], root);
    git(["config", "user.name", "Fixture"], root);
    git(["add", "-A"], root);
    git(["commit", "-m", "base"], root);
    const baseSha = gitRevParse(root);
    writeReferenceFiles(root, {
      entries: candidateEntries,
      cases: [STATUS_CASE],
    });
    return { root, baseSha };
  } catch (cause) {
    rmSync(root, { recursive: true, force: true });
    throw cause;
  }
}

const STATUS_DEBT = {
  routeId: "status",
  path: "/",
  status: "debt",
  rationale: "Frame exists; no golden yet. Searched Paper page E-0.",
  frames: [referenceFrame()],
};

test("fails when route reference debt grows against the merge base", () => {
  const { root, baseSha } = debtLedgerFixture(
    [baselinedEntry()],
    [STATUS_DEBT],
  );
  try {
    assert.throws(
      () => run(root, { base: baseSha }),
      /\[ui\/route-reference-debt-grew\] route status/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts debt that stays or shrinks against the merge base", () => {
  const same = debtLedgerFixture([STATUS_DEBT], [STATUS_DEBT]);
  try {
    assert.doesNotThrow(() => run(same.root, { base: same.baseSha }));
  } finally {
    rmSync(same.root, { recursive: true, force: true });
  }
  const shrunk = debtLedgerFixture([STATUS_DEBT], [baselinedEntry()]);
  try {
    assert.doesNotThrow(() => run(shrunk.root, { base: shrunk.baseSha }));
  } finally {
    rmSync(shrunk.root, { recursive: true, force: true });
  }
});

const TASK_DETAIL_DEBT = {
  routeId: "task-detail",
  path: "/tasks/$taskId",
  status: "debt",
  rationale:
    "Frames exist; no honest golden yet. Searched Paper page E-0 for the task session.",
  frames: [referenceFrame({ frameId: "HU-0", pageId: "E-0" })],
};

test("exempts a debt entry from the stale rule until its route exists", () => {
  // Route absent: planned and debt entries are both accepted ahead of the route.
  assert.deepEqual(
    referenceRules({ entries: [baselinedEntry(), TASK_DETAIL_DEBT] }),
    [],
  );
  // Route present: the normal rules apply, so a moved path is stale.
  const taskRoute = {
    id: "task-detail",
    path: "/tasks/$taskId",
    classification: "production",
    states: ["default"],
  };
  const routes = [STATUS_APP_ROUTE, FIXTURE_ROUTE, taskRoute];
  assert.deepEqual(
    referenceRules({ routes, entries: [baselinedEntry(), TASK_DETAIL_DEBT] }),
    [],
  );
  assert.deepEqual(
    referenceRules({
      routes,
      entries: [
        baselinedEntry(),
        { ...TASK_DETAIL_DEBT, path: "/tasks/$id" },
      ],
    }),
    ["ui/route-reference-stale"],
  );
  // A non-debt, non-planned entry for an absent route is still stale.
  assert.deepEqual(
    referenceRules({
      entries: [
        baselinedEntry(),
        baselinedEntry({
          routeId: "task-detail",
          path: "/tasks/$taskId",
          cases: ["task.default.light.desktop"],
        }),
      ],
    }),
    ["ui/route-reference-stale"],
  );
});

test("does not fire debt-grew for unchanged debt whose route has since landed", () => {
  const taskRoute = {
    id: "task-detail",
    path: "/tasks/$taskId",
    classification: "production",
    states: ["default"],
  };
  const root = workspace();
  try {
    writeConsumer(
      root,
      "router.ts",
      appRouteModule([STATUS_APP_ROUTE, FIXTURE_ROUTE]),
    );
    const entries = [baselinedEntry(), TASK_DETAIL_DEBT];
    writeReferenceFiles(root, { entries, cases: [STATUS_CASE] });
    git(["init"], root);
    git(["config", "user.email", "fixture@example.com"], root);
    git(["config", "user.name", "Fixture"], root);
    git(["add", "-A"], root);
    git(["commit", "-m", "base"], root);
    const baseSha = gitRevParse(root);
    // Head: the route now exists; the ledger is byte-identical.
    writeConsumer(
      root,
      "router.ts",
      appRouteModule([STATUS_APP_ROUTE, FIXTURE_ROUTE, taskRoute]),
    );
    assert.doesNotThrow(() => run(root, { base: baseSha }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats the branch that introduces the ledger as having no debt baseline", () => {
  const root = workspace();
  try {
    writeConsumer(
      root,
      "router.ts",
      appRouteModule([STATUS_APP_ROUTE, FIXTURE_ROUTE]),
    );
    git(["init"], root);
    git(["config", "user.email", "fixture@example.com"], root);
    git(["config", "user.name", "Fixture"], root);
    git(["add", "-A"], root);
    git(["commit", "-m", "base"], root);
    const baseSha = gitRevParse(root);
    writeReferenceFiles(root, { entries: [STATUS_DEBT], cases: [STATUS_CASE] });
    assert.doesNotThrow(() => run(root, { base: baseSha }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when a ledger entry is deleted against the merge base", () => {
  const { root, baseSha } = debtLedgerFixture(
    [baselinedEntry()],
    [],
  );
  try {
    assert.throws(
      () => run(root, { base: baseSha }),
      /unauthorized removal of route-reference status/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const RULE_BASE = {
  entries: [
    {
      id: "ui.text",
      requiredCases: [],
      usage: { replacesElements: ["p", "span"] },
    },
    { id: "ui.x", requiredCases: [] },
  ],
  compositions: [
    {
      id: "work-queue",
      appliesTo: ["page.a", "apps/web/src/pages/*.tsx"],
      requires: [{ anyOf: ["ui.b", "ui.a"] }, { anyOf: ["ui.c"] }],
      forbids: ["ui.x", "ui.y"],
    },
    { id: "other", appliesTo: [], requires: [], forbids: [] },
  ],
};

function ruleFixture(mutate, records) {
  const root = workspace();
  const dir = join(root, "docs/technical-design/ui-baselines");
  mkdirSync(dir, { recursive: true });
  const write = (catalog) =>
    writeFileSync(join(dir, "components.json"), JSON.stringify(catalog));
  write(RULE_BASE);
  git(["init"], root);
  git(["config", "user.email", "fixture@example.com"], root);
  git(["config", "user.name", "Fixture"], root);
  git(["add", "-A"], root);
  git(["commit", "-m", "base"], root);
  const baseSha = gitRevParse(root);
  const candidate = structuredClone(RULE_BASE);
  mutate(candidate);
  write(candidate);
  if (records) writeLedger(root, records(baseSha));
  return { root, baseSha };
}

const RULE_WEAKENINGS = [
  [
    "a replaced element tag",
    (c) => (c.entries[0].usage.replacesElements = ["span"]),
    "replaces:ui.text:p",
  ],
  [
    "a composition",
    (c) => c.compositions.pop(),
    "composition:other",
  ],
  [
    "a requires group",
    (c) => c.compositions[0].requires.pop(),
    "requires:work-queue:ui.c",
  ],
  [
    "an alternative added to a requires group",
    (c) => c.compositions[0].requires[0].anyOf.push("ui.d"),
    "requires:work-queue:ui.a|ui.b",
  ],
  [
    "a forbidden id",
    (c) => c.compositions[0].forbids.pop(),
    "forbids:work-queue:ui.y",
  ],
  [
    "an appliesTo entry",
    (c) => c.compositions[0].appliesTo.shift(),
    "applies:work-queue:page.a",
  ],
];

for (const [label, mutate, identity] of RULE_WEAKENINGS) {
  test(`catalog rule: removing ${label} needs a ledger record`, () => {
    const bare = ruleFixture(mutate);
    try {
      assert.throws(
        () => run(bare.root, { base: bare.baseSha }),
        new RegExp(
          `unauthorized removal of catalog-rule ${
            identity.replace(/[|.]/g, "\\$&")
          }`,
        ),
      );
    } finally {
      rmSync(bare.root, { recursive: true, force: true });
    }
    const ledgered = ruleFixture(mutate, (baseSha) => [
      removalRecord(baseSha, {
        kind: "catalog-rule",
        identity,
        rationale: "The rule is intentionally relaxed.",
      }),
    ]);
    try {
      const result = run(ledgered.root, { base: ledgered.baseSha });
      assert.deepEqual(result.diagnostics, []);
    } finally {
      rmSync(ledgered.root, { recursive: true, force: true });
    }
  });
}

test("catalog rule: tightening or adding rules needs no ledger record", () => {
  const { root, baseSha } = ruleFixture((c) => {
    c.entries[0].usage.replacesElements.push("div");
    c.compositions[0].requires.push({ anyOf: ["ui.z"] });
    c.compositions[0].requires[0].anyOf.pop();
    c.compositions[0].forbids.push("ui.w");
    c.compositions[0].appliesTo.push("apps/web/src/new/*.tsx");
    c.compositions.push({
      id: "fresh",
      appliesTo: [],
      requires: [],
      forbids: [],
    });
  });
  try {
    assert.deepEqual(run(root, { base: baseSha }).diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
