import { assertEquals, assertThrows } from "@std/assert";
import {
  deriveRepositoryInspectionConfig,
  RepositoryInspectionError,
} from "../../apps/server/src/modules/projects/repository-inspect.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import type {
  RepositoryInspectionSourceEnvelope,
  RepositoryObservedProfileConfig,
  RepositoryVersionedProfileConfig,
} from "../../packages/contracts/src/repository-inspection.ts";

const baseline: RepositoryVersionedProfileConfig = {
  schemaVersion: 1,
  workflow: { kind: "fixed" },
  branches: { base: "release/main", allowedPatterns: ["feature/*", "fix/*"] },
  worktree: { root: ".bakery/scoped/worktrees" },
};

async function source(
  files: Record<string, string>,
): Promise<RepositoryInspectionSourceEnvelope> {
  const entries = await Promise.all(
    Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(async ([path, content]) => {
        const bytes = new TextEncoder().encode(content);
        return {
          path,
          mode: "100644" as const,
          sha256: await sha256Hex(content),
          contentBase64: btoa(String.fromCharCode(...bytes)),
        };
      }),
  );
  return {
    organizationId: "00000000-0000-4000-8000-000000000001",
    applicationId: "00000000-0000-4000-8000-000000000002",
    repositoryId: "00000000-0000-4000-8000-000000000003",
    source: {
      mappingRevision: "policy-regression-1",
      mappingDigest: "a".repeat(64),
      baseSha: "b".repeat(40),
      manifestDigest: await sha256Hex(canonicalJson(entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        sha256: entry.sha256,
        size: atob(entry.contentBase64).length,
      })))),
    },
    entries,
  };
}

function manifestChecks(config: RepositoryObservedProfileConfig) {
  return config.checkPolicy.checks.filter((check) =>
    check.id.startsWith("manifest.")
  ).map(({ template, tool, paths, required }) => ({
    template,
    tool,
    paths,
    required,
  }));
}

const unsupported = {
  template: "unsupported.v1" as const,
  tool: null,
  paths: [],
  required: true,
};

Deno.test("inspection retains every unknown package script and Deno task as a blocking unsupported check", async () => {
  const scripts = {
    build: "npm run build",
    clean: "rm -rf dist",
    empty: "",
    environment: "NODE_OPTIONS=--require=./hook.js node --check main.js",
    malformed: { command: "node --check main.js" },
    missing: null,
    pipeline: "node --check main.js | cat",
  };
  const tasks = {
    compound: "deno check main.ts && deno test",
    install: "deno install npm:typescript",
    malformed: false,
    test: "deno test --allow-all",
  };
  const config = deriveRepositoryInspectionConfig(
    baseline,
    await source({
      "package.json": JSON.stringify({ scripts }),
      "tools/deno.json": JSON.stringify({ tasks }),
      "main.js": "const answer = 42;",
      "tools/main.ts": "const answer: number = 42;",
    }),
  );
  assertEquals(
    manifestChecks(config),
    Array.from({
      length: Object.keys(scripts).length + Object.keys(tasks).length,
    }, () => unsupported),
  );
  assertEquals(config.checkPolicy.tools.filter((tool) => tool.required), [
    { tool: "git", required: true },
  ]);
});

Deno.test("inspection admits only pinned syntax files and dependency-free Deno files relative to each manifest", async () => {
  const config = deriveRepositoryInspectionConfig(
    baseline,
    await source({
      "package.json": JSON.stringify({
        scripts: {
          cjs: "node --check common.cjs",
          js: "node --check main.js",
          mjs: "node --check module.mjs",
        },
      }),
      "common.cjs": "module.exports = 42;",
      "main.js": "const answer = 42;",
      "module.mjs": 'import "file:///outside.mjs"; export const answer = 42;',
      "tools/deno.json": JSON.stringify({
        tasks: { check: "deno check src/main.ts helper.js" },
      }),
      "tools/src/main.ts": "const answer: number = 42;",
      "tools/helper.js": "const helper = 1;",
    }),
  );
  assertEquals(manifestChecks(config), [
    {
      template: "node.syntax.v1",
      tool: "node",
      paths: ["common.cjs"],
      required: true,
    },
    {
      template: "node.syntax.v1",
      tool: "node",
      paths: ["main.js"],
      required: true,
    },
    {
      template: "node.syntax.v1",
      tool: "node",
      paths: ["module.mjs"],
      required: true,
    },
    {
      template: "deno.check.v1",
      tool: "deno",
      paths: ["tools/src/main.ts", "tools/helper.js"],
      required: true,
    },
  ]);
  assertEquals(config.checkPolicy.tools.filter((tool) => tool.required), [
    { tool: "git", required: true },
    { tool: "deno", required: true },
    { tool: "node", required: true },
  ]);
  assertEquals(
    config.checkPolicy.checks.filter((check) =>
      check.template === "tool.version.v1"
    )
      .map(({ tool, required }) => ({ tool, required })),
    config.checkPolicy.tools,
  );
});

Deno.test("inspection rejects argv expansions, flags, whitespace variants, absent files and unsupported extensions", async () => {
  const commands = [
    "node --check main.js other.js",
    "node --check missing.js",
    "node --check main.ts",
    "node --check main.jsx",
    "deno check main.mjs",
    "deno check missing.ts",
    "deno check --allow-read main.ts",
    "node --check -- main.js",
    "node --check 'main.js'",
    'node --check "main.js"',
    "node --check *.js",
    "node --check ${TARGET}",
    "node --check main.js; true",
    "node --check main.js || true",
    "node --check main.js > result.txt",
    "node --check main.js\nnode --check other.js",
    " node --check main.js",
    "node --check main.js ",
    "node  --check main.js",
    "node --check\tmain.js",
    "deno check main.ts  other.ts",
    "deno check --config=outside.json main.ts",
  ];
  for (const command of commands) {
    const config = deriveRepositoryInspectionConfig(
      baseline,
      await source({
        "package.json": JSON.stringify({ scripts: { check: command } }),
        "main.js": "const answer = 42;",
        "other.js": "const other = 1;",
        "main.ts": "const answer: number = 42;",
        "other.ts": "const other: number = 1;",
        "main.jsx": "const answer = 42;",
        "main.mjs": "export const answer = 42;",
      }),
    );
    assertEquals(manifestChecks(config), [unsupported], command);
  }
});

Deno.test("inspection never admits unsafe path arguments even when an entry has that exact name", async () => {
  const paths = [
    "../escape.js",
    "/etc/config.js",
    "./main.js",
    "src//main.js",
    "src/../main.js",
    ".git/config.js",
    "src/.GIT/config.js",
    "-main.js",
    "main\\.js",
    `${"a".repeat(510)}.js`,
    `${"dir/".repeat(16)}main.js`,
  ];
  for (const path of paths) {
    const config = deriveRepositoryInspectionConfig(
      baseline,
      await source({
        "package.json": JSON.stringify({
          scripts: { check: `node --check ${path}` },
        }),
        [path]: "const answer = 42;",
      }),
    );
    assertEquals(manifestChecks(config), [unsupported], path);
  }
  const nested = deriveRepositoryInspectionConfig(
    baseline,
    await source({
      "tools/deno.json": JSON.stringify({
        tasks: { check: "deno check ../outside.ts" },
      }),
      "tools/../outside.ts": "const answer: number = 42;",
      "outside.ts": "const answer: number = 42;",
    }),
  );
  assertEquals(manifestChecks(nested), [unsupported]);
});

Deno.test("inspection denies Deno dependency and compiler directive escapes instead of resolving them", async () => {
  const contents = [
    'import "./local.ts";',
    'import "/outside.ts";',
    'import "file:///outside.ts";',
    'import "https://example.test/module.ts";',
    'import "npm:package";',
    'import "jsr:@scope/package";',
    'export { value } from "../outside.ts";',
    'const load = import("../outside.ts");',
    'const load = require("../outside.ts");',
    '/// <reference path="/outside.d.ts" />',
    '/// <reference types="https://example.test/types.d.ts" />',
    "const answer = 42; //# sourceMappingURL=file:///outside.map",
    "const answer = 42; //# sourceURL=file:///outside.ts",
    'const load = \\u0069mport("../outside.ts");',
  ];
  for (const content of contents) {
    const config = deriveRepositoryInspectionConfig(
      baseline,
      await source({
        "deno.json": JSON.stringify({ tasks: { check: "deno check main.ts" } }),
        "main.ts": content,
        "local.ts": "export const value = 42;",
      }),
    );
    assertEquals(manifestChecks(config), [unsupported], content);
    assertEquals(
      config.checkPolicy.tools.find((tool) => tool.tool === "deno"),
      {
        tool: "deno",
        required: false,
      },
    );
  }
});

Deno.test("inspection preserves baseline context across v1 and observed v2 while deriving a fresh policy", async () => {
  const initial = structuredClone(baseline);
  const prior = deriveRepositoryInspectionConfig(
    initial,
    await source({
      "package.json": JSON.stringify({ scripts: { old: "npm test" } }),
    }),
  );
  const envelope = await source({
    "package.json": JSON.stringify({
      scripts: { check: "node --check main.js" },
    }),
    "main.js": "const answer = 42;",
  });
  const priorSnapshot = structuredClone(prior);
  for (const input of [initial, prior]) {
    const config = deriveRepositoryInspectionConfig(input, envelope);
    assertEquals({
      schemaVersion: config.schemaVersion,
      workflow: config.workflow,
      branches: config.branches,
      worktree: config.worktree,
    }, {
      schemaVersion: 2,
      workflow: { kind: "fixed" },
      branches: {
        base: "release/main",
        allowedPatterns: ["feature/*", "fix/*"],
      },
      worktree: { root: ".bakery/scoped/worktrees" },
    });
    assertEquals(manifestChecks(config), [
      {
        template: "node.syntax.v1",
        tool: "node",
        paths: ["main.js"],
        required: true,
      },
    ]);
  }
  assertEquals(initial, baseline);
  assertEquals(prior, priorSnapshot);
});

Deno.test("inspection blocks malformed manifest command maps and unparsed JSONC", async () => {
  for (
    const [path, content] of [
      ["package.json", '{"scripts": null}'],
      ["package.json", '{"scripts": ["node --check main.js"]}'],
      ["package.json", '{"scripts": "node --check main.js"}'],
      ["deno.json", '{"tasks": null}'],
      ["deno.json", "not JSON"],
      [
        "deno.jsonc",
        '{ // repository task\n "tasks": {"check": "deno check main.ts"}}',
      ],
    ]
  ) {
    const config = deriveRepositoryInspectionConfig(
      baseline,
      await source({
        [path]: content,
        "main.js": "const answer = 42;",
        "main.ts": "const answer: number = 42;",
      }),
    );
    assertEquals(manifestChecks(config), [unsupported], `${path}: ${content}`);
  }
});

Deno.test("inspection retains all required commands at the policy bound and rejects overflow rather than truncating", async () => {
  const scripts = Object.fromEntries(
    Array.from({ length: 60 }, (_, index) => [`check${index}`, "npm test"]),
  );
  const config = deriveRepositoryInspectionConfig(
    baseline,
    await source({
      "package.json": JSON.stringify({ scripts }),
    }),
  );
  assertEquals(
    manifestChecks(config),
    Array.from({ length: 60 }, () => unsupported),
  );
  const overflow = await source({
    "package.json": JSON.stringify({
      scripts: { ...scripts, overflow: "npm test" },
    }),
  });
  const error = assertThrows(
    () => deriveRepositoryInspectionConfig(baseline, overflow),
    RepositoryInspectionError,
  );
  assertEquals(error.code, "source_limit");
});

Deno.test("inspection blocks Deno compiler settings for tasks and inherited package scripts without disabling Node checks", async () => {
  const settings = [
    { compilerOptions: { noUnusedLocals: true } },
    { compilerOptions: { types: ["file:///outside.d.ts"] } },
    { compilerOptions: { lib: ["dom"] } },
    { compilerOptions: null },
    { compilerOptions: [] },
    { compilerOptions: "strict" },
    { unstable: ["webgpu"] },
    { unstable: null },
    { workspace: ["tools"] },
  ];
  for (const setting of settings) {
    const config = deriveRepositoryInspectionConfig(
      baseline,
      await source({
        "deno.json": JSON.stringify({
          ...setting,
          tasks: { check: "deno check main.ts" },
        }),
        "main.ts": "const unused: number = 42;",
        "tools/package.json": JSON.stringify({
          scripts: { deno: "deno check main.ts", node: "node --check main.js" },
        }),
        "tools/main.ts": "const unused: number = 42;",
        "tools/main.js": "const unused = 42;",
      }),
    );
    assertEquals(manifestChecks(config), [
      unsupported,
      unsupported,
      {
        template: "node.syntax.v1",
        tool: "node",
        paths: ["tools/main.js"],
        required: true,
      },
    ], JSON.stringify(setting));
  }
});

Deno.test("inspection uses the nearest Deno config and leaves unrelated formatting and sibling settings alone", async () => {
  const config = deriveRepositoryInspectionConfig(
    baseline,
    await source({
      "deno.json": JSON.stringify({
        compilerOptions: { noUnusedLocals: true },
      }),
      "other/deno.json": JSON.stringify({
        compilerOptions: { types: ["file:///outside.d.ts"] },
      }),
      "tools/deno.json": JSON.stringify({
        compilerOptions: {},
        unstable: [],
        workspace: [],
        fmt: { lineWidth: 80 },
        lint: { rules: { tags: ["recommended"] } },
        tasks: { check: "deno check main.ts" },
      }),
      "tools/main.ts": "const unused: number = 42;",
      "tools/sub/package.json": JSON.stringify({
        scripts: { check: "deno check main.ts" },
      }),
      "tools/sub/main.ts": "const unused: number = 42;",
    }),
  );
  assertEquals(manifestChecks(config), [
    {
      template: "deno.check.v1",
      tool: "deno",
      paths: ["tools/main.ts"],
      required: true,
    },
    {
      template: "deno.check.v1",
      tool: "deno",
      paths: ["tools/sub/main.ts"],
      required: true,
    },
  ]);
});

Deno.test("inspection cannot bypass an ancestor workspace compiler policy with an empty member config", async () => {
  const config = deriveRepositoryInspectionConfig(
    baseline,
    await source({
      "deno.json": JSON.stringify({
        workspace: ["tools"],
        compilerOptions: { noUnusedLocals: true },
      }),
      "tools/deno.json": JSON.stringify({
        tasks: { check: "deno check main.ts" },
      }),
      "tools/main.ts": "const unused: number = 42;",
    }),
  );
  assertEquals(manifestChecks(config), [unsupported]);
});

Deno.test("inspection blocks package Deno scripts when their nearest JSONC config cannot be safely interpreted", async () => {
  const config = deriveRepositoryInspectionConfig(
    baseline,
    await source({
      "tools/deno.jsonc":
        '{ // compiler policy\n "compilerOptions": {"noUnusedLocals": true}}',
      "tools/package.json": JSON.stringify({
        scripts: { deno: "deno check main.ts", node: "node --check main.js" },
      }),
      "tools/main.ts": "const unused: number = 42;",
      "tools/main.js": "const unused = 42;",
    }),
  );
  assertEquals(manifestChecks(config), [
    unsupported,
    unsupported,
    {
      template: "node.syntax.v1",
      tool: "node",
      paths: ["tools/main.js"],
      required: true,
    },
  ]);
});
