import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type CssPolicy,
  discoverStylesheets,
  formatCssDefect,
  validateCss,
} from "../../scripts/ui-css.ts";
import {
  type PaperManifest as PaperTokenManifest,
  type TokenManifest,
  validateManifest,
  validatePaperAlignment,
} from "../../scripts/generate-ui-tokens.ts";
import {
  type EvidenceSuite,
  type PaperBaselineManifest,
  type PaperManifest,
  type PaperSpecimensManifest,
  type RuntimeManifest,
  validateCatalogLifecycle,
  validateCatalogSemantics,
  validateCoveragePlan,
  validateDesignImages,
  validateRuntimeManifest,
  validateVisualClosure,
} from "../../scripts/verify-ui-stories.ts";

const root = decodeURIComponent(new URL("../..", import.meta.url).pathname);
const read = async (path: string) => await Deno.readTextFile(`${root}${path}`);

const profileManifests = {
  "K-0": JSON.parse(
    await read("docs/technical-design/worker-readiness/paper-manifest.json"),
  ) as PaperManifest,
};

async function coverageFixture() {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const suites = await Promise.all(catalog.evidenceSuites.map(
    async (suite: EvidenceSuite): Promise<EvidenceSuite> => ({
      ...suite,
      source: await read(suite.path),
    }),
  ));
  return { catalog, runtime, suites };
}

function validateOrThrow(
  path: string,
  source: string,
  generatedVariables: ReadonlySet<string>,
  policy: CssPolicy = "shared",
) {
  const defects = validateCss(path, source, generatedVariables, policy);
  if (defects.length) {
    throw new Error(defects.map(formatCssDefect).join("\n"));
  }
}

const valid: TokenManifest = {
  schemaVersion: 1,
  source: { fileId: "paper", revision: "r1", digest: "0".repeat(64) },
  roles: [],
};

Deno.test("token validator rejects duplicate roles", async () => {
  const manifest = {
    ...valid,
    roles: [
      {
        id: "color.canvas",
        cssVariable: "--color-canvas",
        category: "color",
        values: { value: "#fff" },
      },
      {
        id: "color.canvas",
        cssVariable: "--color-other",
        category: "color",
        values: { value: "#000" },
      },
    ],
  };
  await assertRejects(
    () => validateManifest(manifest),
    Error,
    "duplicate role",
  );
});

Deno.test("token validator rejects missing theme pair", async () => {
  const manifest = {
    ...valid,
    roles: [{
      id: "color.canvas",
      cssVariable: "--color-canvas",
      category: "color",
      values: { light: "#fff" },
    }],
  };
  await assertRejects(() => validateManifest(manifest), Error, "theme pair");
});

Deno.test("token validator rejects unsupported categories", async () => {
  const manifest = {
    ...valid,
    roles: [{
      id: "color.canvas",
      cssVariable: "--color-canvas",
      category: "unsupported",
      values: { value: "#fff" },
    }],
  };
  await assertRejects(
    () => validateManifest(manifest),
    Error,
    "Unsupported token category",
  );
});

Deno.test("token validator rejects mixed and unsafe values", async () => {
  const mixed = {
    ...valid,
    roles: [{
      id: "color.canvas",
      cssVariable: "--color-canvas",
      category: "color",
      values: { value: "#fff", dark: "#000" },
    }],
  };
  await assertRejects(() => validateManifest(mixed), Error, "Mixed");
  const unsafe = {
    ...valid,
    roles: [{
      id: "color.canvas",
      cssVariable: "--color-canvas",
      category: "color",
      values: { value: "red;" },
    }],
  };
  await assertRejects(() => validateManifest(unsafe), Error, "Unsafe");
  for (const value of ["red/*", "red*/"]) {
    const comment = {
      ...valid,
      roles: [{
        id: "color.canvas",
        cssVariable: "--color-canvas",
        category: "color",
        values: { value },
      }],
    };
    await assertRejects(() => validateManifest(comment), Error, "Unsafe");
  }
});

Deno.test("token validator rejects unknown value keys", async () => {
  const manifest = {
    ...valid,
    roles: [{
      id: "color.canvas",
      cssVariable: "--color-canvas",
      category: "color",
      values: { value: "#fff", unexpected: "#000" },
    }],
  };
  await assertRejects(
    () => validateManifest(manifest),
    Error,
    "Unknown or incomplete token value keys",
  );
});

Deno.test("pinned colour roles resolve to the Paper token export", async () => {
  const manifest = JSON.parse(
    await read("docs/technical-design/ui-baselines/tokens.json"),
  ) as TokenManifest;
  const paper = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-tokens.json"),
  ) as PaperTokenManifest;

  validatePaperAlignment(manifest, paper);

  const colorRoles = manifest.roles.filter((role) => role.category === "color");
  assert(colorRoles.length > 0, "expected colour roles in the manifest");
  for (const role of colorRoles) {
    assert(
      Object.hasOwn(role, "paper"),
      `color role missing a paper mapping or explicit null: ${role.id}`,
    );
    if (role.paper === null) {
      assert(
        role.rationale?.trim(),
        `color role with no Paper mapping needs a rationale: ${role.id}`,
      );
    }
  }

  const destructive = manifest.roles.find((role) =>
    role.id === "color.destructive"
  );
  const destructivePaper = destructive?.paper as
    | { light: string; dark: string }
    | undefined;
  assert(destructivePaper?.light, "expected color.destructive Paper mapping");

  const corrupted: TokenManifest = {
    ...manifest,
    roles: manifest.roles.map((role) =>
      role.id === "color.destructive"
        ? { ...role, values: { ...role.values, light: "#000000" } }
        : role
    ),
  };
  assertThrows(
    () => validatePaperAlignment(corrupted, paper),
    Error,
    "does not match Paper",
  );

  const unknownPaperName: TokenManifest = {
    ...manifest,
    roles: manifest.roles.map((role) =>
      role.id === "color.destructive"
        ? {
          ...role,
          paper: {
            light: "--color-does-not-exist",
            dark: destructivePaper!.dark,
          },
        }
        : role
    ),
  };
  assertThrows(
    () => validatePaperAlignment(unknownPaperName, paper),
    Error,
    "Unknown Paper token",
  );

  const missingRationale: TokenManifest = {
    ...manifest,
    roles: manifest.roles.map((role) =>
      role.id === "color.status.neutral"
        ? { ...role, rationale: undefined }
        : role
    ),
  };
  assertThrows(
    () => validatePaperAlignment(missingRationale, paper),
    Error,
    "needs a rationale",
  );
});

Deno.test("discovered stylesheets consume generated semantic roles", async () => {
  const manifest = JSON.parse(
    await read("docs/technical-design/ui-baselines/tokens.json"),
  ) as TokenManifest;
  const generatedVariables = new Set(
    manifest.roles.map((role) => role.cssVariable),
  );
  const generated = await Promise.all([
    read("packages/ui/src/foundations/tokens.css"),
    read("packages/ui/src/foundations/theme.css"),
  ]);
  for (const role of manifest.roles) {
    assert(
      generated.some((css) => css.includes(`${role.cssVariable}:`)),
      `Generated output is missing ${role.cssVariable}`,
    );
  }
  const stylesheets = await discoverStylesheets(root);
  assert(stylesheets.length > 0, "discovery found no stylesheets");
  const discoveredPaths = stylesheets.map((stylesheet) => stylesheet.path);
  assert(
    discoveredPaths.includes("packages/ui/src/atoms/atoms.css"),
    "discovery must keep scanning the shared component styles",
  );
  for (
    const generatedPath of [
      "packages/ui/src/foundations/tokens.css",
      "packages/ui/src/foundations/theme.css",
      "packages/ui/src/foundations/index.css",
    ]
  ) {
    assert(
      !discoveredPaths.includes(generatedPath),
      `discovery must exclude ${generatedPath}`,
    );
  }
  for (const stylesheet of stylesheets) {
    const expectedPolicy = stylesheet.path.startsWith("packages/ui/")
      ? "shared"
      : "consumer";
    assertEquals(
      stylesheet.policy,
      expectedPolicy,
      `unexpected policy for ${stylesheet.path}`,
    );
    const source = await read(stylesheet.path);
    const defects = validateCss(
      stylesheet.path,
      source,
      generatedVariables,
      stylesheet.policy,
    );
    assertEquals(
      defects,
      [],
      `Unexpected CSS defects:\n${defects.map(formatCssDefect).join("\n")}`,
    );
  }
});

Deno.test("shared CSS rail rejects raw visual values", () => {
  const generatedVariables = new Set(["--color-fg", "--type-body"]);
  assertThrows(
    () =>
      validateOrThrow(
        "fixture.css",
        ".bad { color: #fff; }",
        generatedVariables,
      ),
    Error,
    "raw color",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "fixture.css",
        ".bad { color: rebeccapurple; }",
        generatedVariables,
      ),
    Error,
    "raw color",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "fixture.css",
        ".bad { background: oklch(60% 0.2 240); }",
        generatedVariables,
      ),
    Error,
    "raw color",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "fixture.css",
        ".bad { font-size: 13px; }",
        generatedVariables,
      ),
    Error,
    "raw typography",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "fixture.css",
        ".bad { box-shadow: 0 1px 2px #000; }",
        generatedVariables,
      ),
    Error,
    "raw color",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "fixture.css",
        ".bad { z-index: 1; }",
        generatedVariables,
      ),
    Error,
    "raw visual value",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "fixture.css",
        ":root { --gutter: 16px; }",
        generatedVariables,
      ),
    Error,
    "raw responsive value",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "fixture.css",
        "@media (max-width: 700px) {}",
        generatedVariables,
      ),
    Error,
    "raw media query",
  );
  assertEquals(
    (() => {
      validateOrThrow(
        "fixture.css",
        ".ok { color: var(--color-fg); font: var(--type-body); }",
        generatedVariables,
      );
      return true;
    })(),
    true,
  );
});

Deno.test("consumer CSS may reference only generated semantic variables", () => {
  const generatedVariables = new Set([
    "--color-fg",
    "--type-body",
    "--space-4",
  ]);
  assertEquals(
    validateCss(
      "apps/web/src/theme.css",
      ".ok { color: var(--color-fg); font: var(--type-body); }\n",
      generatedVariables,
      "consumer",
    ),
    [],
  );
  assertThrows(
    () =>
      validateOrThrow(
        "apps/web/src/theme.css",
        ".bad { color: #fff; }",
        generatedVariables,
        "consumer",
      ),
    Error,
    "raw color",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "apps/web/src/theme.css",
        ".bad { padding: var(--gutter); }",
        generatedVariables,
        "consumer",
      ),
    Error,
    "unknown variable --gutter",
  );
  assertThrows(
    () =>
      validateOrThrow(
        "apps/web/src/theme.css",
        ".panel { max-inline-size: 24rem; }",
        generatedVariables,
        "consumer",
      ),
    Error,
    "raw structural value",
  );
  assertEquals(
    validateCss(
      "packages/ui/src/panel.css",
      ".panel { max-inline-size: 24rem; }\n",
      generatedVariables,
      "shared",
    ),
    [],
  );
  assertEquals(
    validateCss(
      "packages/ui/src/layout.css",
      "@media (min-width: 744px) { .l { padding: var(--gutter); } }\n:root { --gutter: var(--space-4); }\n",
      generatedVariables,
      "shared",
    ),
    [],
  );
});

Deno.test("tokenized dialog width accepts multiline CSS and rejects raw substitutes", () => {
  const variables = new Set([
    "--layout-dialog",
    "--space-10",
    "--space-8",
  ]);
  const value =
    "min(calc(var(--layout-dialog) - var(--space-10)), calc(100dvi -\n    var(--space-8)))";
  const source = `.dialog { inline-size: ${value}; }`;
  assertEquals(validateCss("fixture.css", source, variables), []);
  assertEquals(
    validateCss("fixture.css", source.replaceAll("\n    ", " "), variables),
    [],
  );
  for (
    const replacement of [
      value.replace("var(--space-10)", "40px"),
      value.replace("var(--space-8)", "32px"),
      value.replace("100dvi", "90dvi"),
      value.replace("--space-8", "--missing-gutter"),
    ]
  ) {
    assert(
      validateCss(
        "fixture.css",
        `.dialog { inline-size: ${replacement}; }`,
        variables,
      )
        .some((defect) => defect.message.startsWith("raw structural value")),
    );
  }
  assert(
    validateCss("apps/web/src/theme.css", source, variables, "consumer")
      .some((defect) => defect.message.startsWith("raw structural value")),
  );
});

Deno.test("consumer CSS may not redefine generated semantic variables", () => {
  const generatedVariables = new Set(["--color-fg", "--space-4"]);
  const defects = validateCss(
    "apps/web/src/theme.css",
    "div { --color-fg: red; --space-4: 99px; color: var(--color-fg); padding: var(--space-4); }\n",
    generatedVariables,
    "consumer",
  );
  assertEquals(
    defects.map((defect) => defect.message),
    [
      "consumer CSS may not redefine generated variable --color-fg",
      "consumer CSS may not redefine generated variable --space-4",
    ],
  );
  assertEquals(defects[0].line, 1);
  assertEquals(defects[0].column, 7);
});

Deno.test("shared CSS may still redefine generated variables", () => {
  const generatedVariables = new Set(["--color-fg", "--color-text"]);
  assertEquals(
    validateCss(
      "packages/ui/src/atoms/atoms.css",
      ".ok { --color-fg: var(--color-text); color: var(--color-fg); }\n",
      generatedVariables,
      "shared",
    ),
    [],
  );
});

Deno.test("CSS defects carry exact file, line, and column locations", () => {
  const source =
    ".a {\n  color: var(--color-fg);\n}\n\n.b {\n  color: #fff;\n}\n";
  const defects = validateCss(
    "apps/web/src/bad.css",
    source,
    new Set(["--color-fg"]),
    "consumer",
  );
  const bare = defects.find((defect) => defect.message === "raw color");
  assert(bare);
  assertEquals(bare.path, "apps/web/src/bad.css");
  assertEquals(bare.line, 6);
  assertEquals(bare.column, 10);
  const declared = defects.find((defect) =>
    defect.message === "raw color color: #fff"
  );
  assert(declared);
  assertEquals(declared.line, 6);
  assertEquals(declared.column, 3);
});

Deno.test("newly discovered paths validate under their package policy", () => {
  const generatedVariables = new Set(["--color-fg"]);
  assertEquals(
    validateCss(
      "packages/ui/src/organisms/NewComponent.css",
      ".new { color: var(--color-fg); max-inline-size: 24rem; }\n",
      generatedVariables,
      "shared",
    ),
    [],
  );
  const defects = validateCss(
    "packages/plugin/src/new.css",
    ".new { color: var(--color-fg); max-inline-size: 24rem; }\n",
    generatedVariables,
    "consumer",
  );
  assertEquals(
    defects.map((defect) => defect.message),
    ["raw structural value max-inline-size: 24rem"],
  );
  assertEquals(defects[0].path, "packages/plugin/src/new.css");
});

function canonicalCatalogJson(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === "object") {
      return Object.keys(node as Record<string, unknown>).sort().reduce(
        (accumulator, key) => {
          accumulator[key] = sort((node as Record<string, unknown>)[key]);
          return accumulator;
        },
        {} as Record<string, unknown>,
      );
    }
    return node;
  };
  return JSON.stringify(sort(value));
}

Deno.test("catalog revision matches its canonical content digest", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const { revision, ...content } = catalog;
  assert(typeof revision === "string" && revision.length === 64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalCatalogJson(content)),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(revision, hex);
});

Deno.test("runtime matrix covers every catalog required case", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const index = JSON.parse(
    await read("packages/ui/storybook-static/index.json"),
  );
  const indexEntries = Array.isArray(index.entries)
    ? index.entries
    : Object.values(index.entries);
  assertEquals(validateRuntimeManifest(runtime, catalog, indexEntries), []);
});

Deno.test("Paper semantic coverage is narrow, non-empty, and linked", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const index = JSON.parse(
    await read("packages/ui/storybook-static/index.json"),
  );
  const indexEntries = Array.isArray(index.entries)
    ? index.entries
    : Object.values(index.entries);
  const wide = runtime.cases.find((entry) =>
    entry.id === "ui.sectionNavigationWide.contract.desktop-light-fine"
  );
  assert(wide);

  const empty = structuredClone(runtime);
  const emptyWide = empty.cases.find((entry) => entry.id === wide.id);
  assert(emptyWide);
  emptyWide.semanticCoverage = { variants: [], states: ["default"] };
  assert(
    validateRuntimeManifest(empty, catalog, indexEntries).some((error) =>
      error.includes("semanticCoverage.variants must be a non-empty array")
    ),
  );

  const outsideCanonical = structuredClone(runtime);
  const outsideWide = outsideCanonical.cases.find((entry) =>
    entry.id === wide.id
  );
  assert(outsideWide);
  outsideWide.semanticCoverage = {
    variants: ["not-a-section-navigation-variant"],
    states: ["default"],
  };
  assert(
    validateRuntimeManifest(outsideCanonical, catalog, indexEntries).some(
      (error) => error.includes("semanticCoverage.variants must be a subset"),
    ),
  );

  const unlinked = structuredClone(runtime);
  const unlinkedCase = unlinked.cases.find((entry) =>
    entry.catalogId === "ui.text"
  );
  assert(unlinkedCase);
  unlinkedCase.semanticCoverage = { variants: ["body"], states: ["default"] };
  assert(
    validateRuntimeManifest(unlinked, catalog, indexEntries).some((error) =>
      error.includes("semanticCoverage requires paperBaselineId")
    ),
  );
});

Deno.test("implemented catalog entries require export, story, and runtime coverage", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const entry = catalog.entries[0];
  const incomplete = structuredClone(catalog);
  incomplete.entries[0].status = "implemented";
  incomplete.entries[0].id = "ui.missing";
  const errors = validateCatalogLifecycle(
    incomplete,
    "",
    [],
    runtime,
  );
  assert(
    errors.some((error) =>
      error.includes("ui.missing") && error.includes("public package export")
    ),
  );
  assert(
    errors.some((error) =>
      error.includes("ui.missing") && error.includes("Storybook")
    ),
  );
  assert(
    errors.some((error) =>
      error.includes("ui.missing") && error.includes("runtime")
    ),
  );
  assert(entry.status === "specified" || entry.status === "implemented");
});

Deno.test("required catalog cases cover every approved semantic variant and state", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const fixture = structuredClone(catalog);
  fixture.entries[0].requiredCases[0].states = ["default"];
  assert(
    validateCatalogSemantics(fixture).some((error) =>
      error.includes("ui.text") &&
      error.includes("does not cover every approved state")
    ),
  );
});

Deno.test("runtime matrix rail rejects duplicate and unknown mappings", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const index = JSON.parse(
    await read("packages/ui/storybook-static/index.json"),
  );
  const indexEntries = Array.isArray(index.entries)
    ? index.entries
    : Object.values(index.entries);
  const fixture = JSON.parse(JSON.stringify(runtime)) as RuntimeManifest;
  fixture.cases[0].storyId = "missing-story";
  fixture.cases.push({ ...fixture.cases[1], id: fixture.cases[0].id });
  const errors = validateRuntimeManifest(fixture, catalog, indexEntries);
  assert(errors.some((error) => error.includes("unknown Storybook story")));
  assert(errors.some((error) => error.includes("is duplicated")));
});

Deno.test("runtime matrix accepts schema-valid new contexts", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const index = JSON.parse(
    await read("packages/ui/storybook-static/index.json"),
  );
  const indexEntries = Array.isArray(index.entries)
    ? index.entries
    : Object.values(index.entries);
  const fixture = structuredClone(runtime) as RuntimeManifest;
  fixture.contexts["extended-pointer-coarse"] = {
    ...fixture.contexts["desktop-coarse"],
  };
  const template = fixture.cases.find((entry) =>
    entry.context === "desktop-coarse"
  );
  assert(template);
  fixture.cases.push({
    ...template,
    id: "ui.text.contract.extended-pointer-coarse",
    context: "extended-pointer-coarse",
    paperBaselineId: undefined,
  });
  assertEquals(
    validateRuntimeManifest(fixture, catalog, indexEntries, false),
    [],
  );
});

Deno.test("runtime matrix still requires aggregate context axes", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const index = JSON.parse(
    await read("packages/ui/storybook-static/index.json"),
  );
  const indexEntries = Array.isArray(index.entries)
    ? index.entries
    : Object.values(index.entries);
  const fixture = structuredClone(runtime) as RuntimeManifest;
  for (const context of Object.values(fixture.contexts)) {
    context.theme = "dark";
  }
  const errors = validateRuntimeManifest(fixture, catalog, indexEntries, false);
  assert(errors.some((error) => error.includes("must cover light theme")));
});

Deno.test("real UI coverage closes every catalog obligation", async () => {
  const { catalog, runtime, suites } = await coverageFixture();
  assertEquals(validateCoveragePlan(catalog, runtime, suites), []);
});

Deno.test("lifecycle verification rejects forged implementation evidence", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const entry = structuredClone(catalog.entries[0]);
  const runtimeCase = runtime.cases.find((candidate) =>
    candidate.catalogId === entry.id
  );
  assert(runtimeCase);
  const fixtureRuntime = {
    ...runtime,
    cases: [{ ...runtimeCase, storyId: "forged-story" }],
  };
  const errors = validateCatalogLifecycle(
    { ...catalog, entries: [entry] },
    '// export * from "./atoms/Text";',
    [{
      id: entry.id,
      source: "./src/atoms/missing.stories.tsx",
      title: entry.storyTitle,
      storyId: runtimeCase.storyId,
      sourceExists: false,
      requiredCases: ["contract"],
    }],
    fixtureRuntime,
    new Map([[entry.id, "// export function Text() {}"]]),
  );
  assert(errors.some((error) => error.includes("public package export")));
  assert(errors.some((error) => error.includes("real Storybook binding")));
  assert(
    errors.some((error) => error.includes("real Storybook story")),
  );
  assert(errors.some((error) => error.includes("real source declaration")));
});

Deno.test("lifecycle verification rejects extra Storybook required cases", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const publicExports = await read("packages/ui/src/index.ts");
  const entry = catalog.entries[0];
  const runtimeCase = runtime.cases.find((candidate) =>
    candidate.catalogId === entry.id
  );
  assert(runtimeCase);
  const errors = validateCatalogLifecycle(
    { ...catalog, entries: [entry] },
    publicExports,
    [{
      id: entry.id,
      source: "./atoms/Text.stories.tsx",
      title: entry.storyTitle,
      storyId: runtimeCase.storyId,
      sourceExists: true,
      requiredCases: [
        ...entry.requiredCases.map((required: { id: string }) => required.id),
        "unexpected",
      ],
    }],
    runtime,
    new Map([[
      entry.id,
      await read("packages/ui/src/atoms/Text.tsx"),
    ]]),
  );
  assert(
    errors.some((error) =>
      error.includes("does not exactly map required cases")
    ),
  );
});

Deno.test("visual closure rejects orphaned Paper baselines", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const baselines = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-baselines.json"),
  ) as PaperBaselineManifest;
  const paperManifest = JSON.parse(
    await read("docs/technical-design/auth-mocks/paper-manifest.json"),
  ) as PaperManifest;
  const paperSpecimens = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-specimens.json"),
  ) as PaperSpecimensManifest;
  const fixture = structuredClone(baselines);
  fixture.cases.push({
    id: "ui.orphan.paper",
    reference: "specimen",
    frameId: "orphan-frame",
    pageId: "orphan-page",
    catalogId: "ui.text",
    requiredStoryCase: "contract",
  });
  const errors = validateVisualClosure(
    catalog,
    runtime,
    fixture,
    paperManifest,
    paperSpecimens,
    profileManifests,
  );
  assert(errors.includes("Paper baseline ui.orphan.paper is orphaned"));
});

Deno.test("design image validation rejects metadata dimension drift", async () => {
  const baselines = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-baselines.json"),
  ) as PaperBaselineManifest;
  const fixture = structuredClone(baselines);
  const designCase = fixture.cases.find((candidate) =>
    candidate.reference === "design"
  );
  assert(designCase && designCase.reference === "design");
  designCase.image.height += 1;

  const errors = await validateDesignImages(fixture);
  assert(
    errors.some((error) =>
      error.includes(`${designCase.id} recorded image`) &&
      error.includes("differs from the committed PNG")
    ),
  );
});

Deno.test("visual closure requires independent Paper specimen provenance", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const baselines = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-baselines.json"),
  ) as PaperBaselineManifest;
  const paperManifest = JSON.parse(
    await read("docs/technical-design/auth-mocks/paper-manifest.json"),
  ) as PaperManifest;
  const specimens = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-specimens.json"),
  ) as PaperSpecimensManifest;
  assertEquals(
    validateVisualClosure(
      catalog,
      runtime,
      baselines,
      paperManifest,
      specimens,
      profileManifests,
    ),
    [],
  );

  const wrongFile = structuredClone(baselines);
  wrongFile.source = { fileId: "wrong-file" };
  assert(
    validateVisualClosure(
      catalog,
      runtime,
      wrongFile,
      paperManifest,
      specimens,
      profileManifests,
    )
      .some((error) => error.includes("source.fileId does not match")),
  );

  const wrongPage = structuredClone(baselines);
  const pageCase = wrongPage.cases.find((entry) =>
    entry.id === "ui.sectionNavigationWide.paper"
  );
  assert(pageCase && pageCase.reference === "specimen");
  pageCase.pageId = "wrong-page";
  assert(
    validateVisualClosure(
      catalog,
      runtime,
      wrongPage,
      paperManifest,
      specimens,
      profileManifests,
    )
      .some((error) => error.includes("pageId does not match")),
  );

  const wrongFrame = structuredClone(baselines);
  const frameCase = wrongFrame.cases.find((entry) =>
    entry.id === "ui.sectionNavigationWide.paper"
  );
  assert(frameCase && frameCase.reference === "specimen");
  frameCase.frameId = "wrong-frame";
  assert(
    validateVisualClosure(
      catalog,
      runtime,
      wrongFrame,
      paperManifest,
      specimens,
      profileManifests,
    ).some((error) => error.includes("frameId does not match")),
  );

  const missingRecord = structuredClone(specimens);
  missingRecord.specimens = missingRecord.specimens.filter((
    entry: PaperSpecimensManifest["specimens"][number],
  ) => entry.id !== "ui.sectionNavigationWide.paper");
  assert(
    validateVisualClosure(
      catalog,
      runtime,
      baselines,
      paperManifest,
      missingRecord,
      profileManifests,
    ).some((error) => error.includes("has no matching paper specimen record")),
  );
});

Deno.test("visual closure rejects a design case whose id mismatches its design fields", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const baselines = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-baselines.json"),
  ) as PaperBaselineManifest;
  const paperManifest = JSON.parse(
    await read("docs/technical-design/auth-mocks/paper-manifest.json"),
  ) as PaperManifest;
  const paperSpecimens = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-specimens.json"),
  );
  const fixture = structuredClone(baselines);
  fixture.cases.push({
    id: "login.github-disabled.light.desktop",
    reference: "design",
    frameId: "HJD-0",
    pageId: "V-0",
    design: {
      screen: "login",
      state: "github-disabled",
      theme: "light",
      // Mismatched on purpose: the id above says "desktop" but this design
      // field says "phone", so the id no longer derives from the fields.
      device: "phone",
    },
    imagePath:
      "docs/technical-design/ui-baselines/paper/design/login--github-disabled--light--desktop.png",
    imageSha256: "0".repeat(64),
    viewport: { width: 1440, height: 960 },
    artboard: { width: 1440, height: 960 },
    image: { width: 1440, height: 960 },
    dpr: 1,
    theme: "light",
    pointer: "fine",
    locale: "en-US",
    direction: "ltr",
    browser: "chromium",
    os: "linux-x64",
    fontDigests: {},
    candidate: {
      route: "/__fixtures__/auth/sign-in-unavailable",
      session: "anonymous",
    },
  });
  const errors = validateVisualClosure(
    catalog,
    runtime,
    fixture,
    paperManifest,
    paperSpecimens,
    profileManifests,
  );
  assert(
    errors.some((error) =>
      error.includes(
        "Paper design case login.github-disabled.light.desktop id does not match its design fields",
      )
    ),
  );
});

Deno.test("visual closure rejects a derived design image taller than its artboard", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const runtime = JSON.parse(
    await read("docs/technical-design/ui-baselines/runtime-cases.json"),
  ) as RuntimeManifest;
  const baselines = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-baselines.json"),
  ) as PaperBaselineManifest;
  const paperManifest = JSON.parse(
    await read("docs/technical-design/auth-mocks/paper-manifest.json"),
  ) as PaperManifest;
  const paperSpecimens = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-specimens.json"),
  );
  const fixture = structuredClone(baselines);
  const derived = fixture.cases.find((baselineCase) =>
    baselineCase.reference === "design" &&
    baselineCase.id === "register.default.light.phone"
  );
  assert(derived && derived.reference === "design");
  // The core derivation may release height (omitted GitHub block) but never
  // add it: a taller image means the mock grew content Paper never had.
  derived.image = { width: 390, height: derived.artboard.height + 1 };
  const errors = validateVisualClosure(
    catalog,
    runtime,
    fixture,
    paperManifest,
    paperSpecimens,
    profileManifests,
  );
  assert(
    errors.some((error) =>
      error.includes("register.default.light.phone image height") &&
      error.includes("exceeds artboard height")
    ),
  );
  // Without the derivation any height difference is drift.
  const undelivered = structuredClone(fixture);
  delete undelivered.reference?.capabilities;
  const strict = undelivered.cases.find((baselineCase) =>
    baselineCase.reference === "design" &&
    baselineCase.id === "register.default.light.phone"
  );
  assert(strict && strict.reference === "design");
  strict.image = { width: 390, height: strict.artboard.height - 1 };
  const strictErrors = validateVisualClosure(
    catalog,
    runtime,
    undelivered,
    paperManifest,
    paperSpecimens,
    profileManifests,
  );
  assert(
    strictErrors.some((error) =>
      error.includes("register.default.light.phone image height") &&
      error.includes("differs from artboard height")
    ),
  );
});

Deno.test("coverage rail rejects duplicate and unknown classifications", async () => {
  const { catalog, runtime, suites } = await coverageFixture();
  const duplicate = structuredClone(catalog);
  duplicate.entries[0].coverage.automated["pointer:coarse"] = [
    `runtime:${runtime.cases[0].id}`,
  ];
  const duplicateErrors = validateCoveragePlan(
    duplicate,
    runtime,
    suites,
  );
  assert(
    duplicateErrors.some((error) =>
      error.includes("pointer:coarse is classified 2 times")
    ),
  );

  const unknown = structuredClone(catalog);
  unknown.entries[0].coverage.automated["state:unknown"] = [
    `runtime:${runtime.cases[0].id}`,
  ];
  const unknownErrors = validateCoveragePlan(
    unknown,
    runtime,
    suites,
  );
  assert(
    unknownErrors.some((error) =>
      error.includes("classifies unknown identifier state:unknown")
    ),
  );
});

Deno.test("coverage rail rejects unknown suites and empty automated evidence", async () => {
  const { catalog, runtime, suites } = await coverageFixture();
  const unknownSuite = structuredClone(catalog);
  unknownSuite.entries[0].coverage.automated["theme:dark"] = [
    "suite:storybook.missing",
  ];
  const suiteErrors = validateCoveragePlan(
    unknownSuite,
    runtime,
    suites,
  );
  assert(
    suiteErrors.some((error) => error.includes("unknown evidence suite")),
  );

  const empty = structuredClone(catalog);
  empty.entries[0].coverage.automated["state:default"] = [];
  const emptyErrors = validateCoveragePlan(
    empty,
    runtime,
    suites,
  );
  assert(
    emptyErrors.some((error) =>
      error.includes("empty automated reference list")
    ),
  );
});

Deno.test("coverage rail rejects suites that do not exercise the cited dimension", async () => {
  const { catalog, runtime, suites } = await coverageFixture();
  const mismatchedSuites = structuredClone(suites);
  const darkAxe = mismatchedSuites.find((suite) =>
    suite.id === "suite.storybook.canonical-dark-axe"
  );
  assert(darkAxe);
  darkAxe.dimensions = ["layout"];

  const errors = validateCoveragePlan(
    catalog,
    runtime,
    mismatchedSuites,
  );
  assert(
    errors.some((error) =>
      error.includes(
        "theme:dark references evidence suite suite:storybook.canonical-dark-axe which does not declare the theme dimension",
      )
    ),
  );

  const valueMismatchedSuites = structuredClone(suites);
  const reflow = valueMismatchedSuites.find((suite) =>
    suite.id === "suite.storybook.canonical-reflow"
  );
  assert(reflow);
  reflow.coveredIdentifiers = ["layout:sheet"];
  const valueErrors = validateCoveragePlan(
    catalog,
    runtime,
    valueMismatchedSuites,
  );
  assert(
    valueErrors.some((error) =>
      error.includes(
        "layout:pane references evidence suite suite:storybook.canonical-reflow which does not cover that value",
      )
    ),
  );
});

Deno.test("coverage rail rejects runtime cases in the wrong context", async () => {
  const { catalog, runtime, suites } = await coverageFixture();
  const mismatchedRuntime = structuredClone(runtime);
  mismatchedRuntime.contexts["desktop-light-fine"].theme = "dark";
  const errors = validateCoveragePlan(
    catalog,
    mismatchedRuntime,
    suites,
  );
  assert(
    errors.some((error) =>
      error.includes("theme:light") &&
      error.includes("does not exercise that value")
    ),
  );
});

Deno.test("coverage rail rejects a runtime scenario cited for another state", async () => {
  const { catalog, runtime, suites } = await coverageFixture();
  const fixtureCatalog = structuredClone(catalog);
  const fixtureRuntime = structuredClone(runtime);
  const entry = fixtureCatalog.entries.find((candidate: { id: string }) =>
    candidate.id === "ui.dialog"
  );
  const runtimeCase = fixtureRuntime.cases.find((candidate) =>
    candidate.id === "ui.dialog.contract.desktop-light-fine"
  );
  assert(entry);
  assert(runtimeCase);
  entry.coverage.automated = {
    ...entry.coverage.automated,
    "state:open": [`runtime:${runtimeCase.id}`],
  };
  const errors = validateCoveragePlan(
    fixtureCatalog,
    fixtureRuntime,
    suites,
  );
  assert(
    errors.some((error) =>
      error.includes("state:open") &&
      error.includes("does not exercise that value")
    ),
  );
});

Deno.test("coverage rail rejects blank dispositions", async () => {
  const { catalog, runtime, suites } = await coverageFixture();
  const blankReason = structuredClone(catalog);
  blankReason.entries[0].coverage.notApplicable["pointer:coarse"] = "";
  const reasonErrors = validateCoveragePlan(
    blankReason,
    runtime,
    suites,
  );
  assert(
    reasonErrors.some((error) =>
      error.includes("unreasoned not-applicable disposition")
    ),
  );
});

Deno.test("partitioned catalog cases preserve complete state and variant coverage", async () => {
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const enrollment = catalog.entries.find((entry: { id: string }) =>
    entry.id === "template.workerEnrollmentInstructions"
  );
  assert(enrollment);
  assertEquals(
    validateCatalogSemantics({ ...catalog, entries: [enrollment] }),
    [],
  );
  for (const mutation of ["missing", "unknown", "empty", "legacy"] as const) {
    const entry = structuredClone(enrollment);
    if (mutation === "missing") {
      entry.requiredCases = entry.requiredCases.filter((
        item: { states: string[] },
      ) => !item.states.includes("expired"));
    }
    if (mutation === "unknown") entry.requiredCases[0].states = ["invented"];
    if (mutation === "empty") entry.requiredCases[0].variants = [];
    if (mutation === "legacy") delete entry.requiredCaseCoverage;
    assert(
      validateCatalogSemantics({ ...catalog, entries: [entry] }).length > 0,
      mutation,
    );
  }
});

Deno.test("source-shaped stories bind positive K-0 states and cannot mask or substitute negative cases", async () => {
  const { catalog, runtime } = await coverageFixture();
  const baselines = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-baselines.json"),
  ) as PaperBaselineManifest;
  const manifest = JSON.parse(
    await read("docs/technical-design/auth-mocks/paper-manifest.json"),
  ) as PaperManifest;
  const specimens = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-specimens.json"),
  ) as PaperSpecimensManifest;
  const validate = (r: RuntimeManifest, b: PaperBaselineManifest) =>
    validateVisualClosure(catalog, r, b, manifest, specimens, profileManifests);
  assertEquals(validate(runtime, baselines), []);
  const wrongState = structuredClone(runtime);
  const item = wrongState.cases.find((item) =>
    item.paperBaselineId === "enrollment.listening.light.phone"
  );
  assert(item);
  item.args = { state: "reconnecting" };
  assert(
    validate(wrongState, baselines).some((error) =>
      error.includes("story capture binding")
    ),
  );
  const masked = structuredClone(baselines);
  const design = masked.cases.find((item) =>
    item.id === "enrollment.start.light.phone"
  );
  assert(design?.reference === "design");
  design.comparisonRegion = { x: 0, y: 0, width: 100, height: 100 };
  assert(
    validate(runtime, masked).some((error) =>
      error.includes("unmasked full frame")
    ),
  );
  const missing = structuredClone(runtime);
  missing.cases = missing.cases.filter((item) =>
    item.paperBaselineId !== "enrollment.start.light.phone"
  );
  assert(
    validate(missing, baselines).some((error) =>
      error.includes("enrollment.start.light.phone is orphaned")
    ),
  );
});

Deno.test("command CodeBlock preserves K-0 invariant Paper roles and enrollment usage", async () => {
  const manifest = JSON.parse(
    await read("docs/technical-design/ui-baselines/tokens.json"),
  ) as TokenManifest;
  const paper = JSON.parse(
    await read("docs/technical-design/ui-baselines/paper-tokens.json"),
  ) as PaperTokenManifest;
  await validateManifest(manifest);
  validatePaperAlignment(manifest, paper);
  for (
    const [suffix, value] of [
      ["surface", "#12161E"],
      ["border-strong", "#3D4655"],
      ["fg-secondary", "#A3ACBA"],
    ]
  ) {
    const role = manifest.roles.find((r) => r.id === `color.dark.${suffix}`);
    assertEquals(role?.values, { value });
    assertEquals(role?.paper, { value: `--color-dark-${suffix}` });
    assert(role?.rationale?.includes("9ZB-0.react-css.txt:68-69"));
  }
  const css = await read("packages/ui/src/data.css");
  const command = css.match(/\.ui-code-block--command\s*\{([^}]+)\}/)?.[1];
  assert(command);
  for (
    const declaration of [
      "background: var(--color-dark-surface)",
      "border: var(--border-default) solid var(--color-dark-border-strong)",
      "color: var(--color-dark-fg-secondary)",
      "border-radius: var(--radius-overlay)",
      "padding: var(--space-4)",
      "font: var(--type-data)",
      "white-space: pre-wrap",
    ]
  ) assert(command.includes(declaration), declaration);
  for (
    const [id, value] of [
      ["radius.overlay", "8px"],
      ["space.4", "16px"],
      ["type.data", "400 13px/20px var(--font-mono)"],
    ]
  ) {
    assertEquals(manifest.roles.find((r) => r.id === id)?.values, { value });
  }
  const syntax = manifest.roles.find((r) => r.id === "color.syntax.surface");
  assertEquals(syntax?.values, { light: "#111827", dark: "#0B0E14" });
  const catalog = JSON.parse(
    await read("docs/technical-design/ui-baselines/components.json"),
  );
  const entry = catalog.entries.find((e: { id: string }) =>
    e.id === "ui.codeBlock"
  );
  assertEquals(entry.variants, ["plain", "syntax", "command"]);
  assertEquals(entry.requiredCases[0].variants, entry.variants);
  assert(
    (await read("packages/ui/src/organisms/CodeBlock.stories.tsx")).includes(
      'variant="command"',
    ),
  );
  assert(
    (await read("packages/ui/src/templates/WorkerEnrollmentInstructions.tsx"))
      .includes('variant="command"'),
  );
  assert(
    !(await read("packages/ui/src/templates/worker-enrollment.css")).includes(
      ".ui-code-block",
    ),
  );
});
