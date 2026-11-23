import { assert, assertEquals } from "@std/assert";
import {
  BakeryPackageSchema,
  buildPackage,
  exportReferences,
  importReferences,
  packageDefects,
  type PackageItemDraft,
  rawBindingsIn,
  unsafePackagePath,
} from "../../packages/contracts/src/library-packages.ts";
import { canonicalJson } from "../../packages/contracts/src/workflow-compiler/canonical.ts";

// #426. A T0 package is validated data, addressed by digest, and it carries
// nothing that belongs to one installation (chapter 25 section 6, O6, O7).

const workflow = (definition: unknown): PackageItemDraft => ({
  kind: "workflow",
  key: "triage",
  data: {
    slug: "triage",
    name: "Triage",
    description: "Sort what arrives.",
    definition: canonicalJson(definition),
    openBindings: [],
  },
});

const kind: PackageItemDraft = {
  kind: "artifactKind",
  key: "brief",
  data: {
    key: "brief",
    name: "Brief",
    description: "A short statement of what to build.",
    text: true,
    facts: [],
    rules: [{ type: "nonEmpty", severity: "require", options: {} }],
  },
};

Deno.test("a built package parses and has no defects", async () => {
  const pkg = await buildPackage("Starter", [
    workflow({ steps: [{ id: "a", uses: "noop" }] }),
    kind,
  ]);
  assertEquals(BakeryPackageSchema.safeParse(pkg).success, true);
  assertEquals(await packageDefects(pkg), []);
});

Deno.test("the same items always give the same package digest", async () => {
  const items = [workflow({ steps: [] }), kind];
  assertEquals(
    (await buildPackage("A", items)).packageDigest,
    (await buildPackage("B", items)).packageDigest,
  );
});

Deno.test("a changed item no longer matches its digest, and so does the package", async () => {
  const pkg = await buildPackage("Starter", [workflow({ steps: [] })]);
  const tampered = structuredClone(pkg);
  tampered.items[0]!.data = {
    ...(tampered.items[0]!.data as object),
    name: "Changed",
  } as never;
  const codes = (await packageDefects(tampered)).map((d) => d.code);
  assert(codes.includes("digest_mismatch"));
});

Deno.test("an edited item list fails the package digest", async () => {
  const pkg = await buildPackage("Starter", [workflow({ steps: [] }), kind]);
  const dropped = { ...pkg, items: pkg.items.slice(0, 1) };
  assertEquals(
    (await packageDefects(dropped)).map((d) => d.code),
    ["package_digest_mismatch"],
  );
});

Deno.test("an item that appears twice is refused", async () => {
  const pkg = await buildPackage("Starter", [
    workflow({ steps: [] }),
    workflow({ steps: [] }),
  ]);
  assert((await packageDefects(pkg)).some((d) => d.code === "duplicate_item"));
});

Deno.test("an item keyed differently from its slug is refused, because the importer reads both", async () => {
  const pkg = await buildPackage("Starter", [
    { ...workflow({ steps: [] }), key: "other-key" },
  ]);
  const defects = await packageDefects(pkg);
  assertEquals(defects.map((d) => d.code), ["key_slug_mismatch"]);
  assertEquals(defects[0].path, ["items", 0, "key"]);
  assertEquals(
    (await packageDefects(
      await buildPackage("Starter", [workflow({ steps: [] })]),
    ))
      .length,
    0,
  );
});

Deno.test("grants, credentials, connections, repository bindings, runs and activations never travel", async () => {
  for (
    const member of [
      "grants",
      "credentials",
      "connection",
      "repositoryProfileId",
      "runHistory",
      "activations",
      "api_key",
      "secret",
    ]
  ) {
    const pkg = await buildPackage("Starter", [
      workflow({ steps: [{ id: "a", with: { nested: { [member]: "x" } } }] }),
    ]);
    const found = (await packageDefects(pkg)).filter((d) =>
      d.code === "installation_only_member"
    );
    assertEquals(found.length, 1, member);
    assertEquals(found[0]!.path.at(-1), member);
  }
});

Deno.test("a definition that is not canonical JSON is refused", async () => {
  const pkg = await buildPackage("Starter", [workflow({ b: 1, a: 2 })]);
  const loose = structuredClone(pkg);
  const data = loose.items[0]!.data as { definition: string };
  data.definition = '{"b":1,"a":2}';
  const codes = (await packageDefects(loose)).map((d) => d.code);
  assert(codes.includes("workflow_definition_not_canonical"));
});

Deno.test("the format has no field that accepts code or an unknown member", () => {
  const extra = BakeryPackageSchema.safeParse({
    formatVersion: 1,
    name: "x",
    items: [],
    packageDigest: "0".repeat(64),
    script: "evil()",
  });
  assertEquals(extra.success, false);
});

const SKILL_VERSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SKILL = "22222222-2222-4222-8222-222222222222";
const AGENT_VERSION = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";

const known = {
  skills: new Map([
    [SKILL_VERSION, { key: "review-style", name: "Review style" }],
    [OTHER_SKILL, { key: null, name: "House rules" }],
  ]),
  agents: new Map([
    [AGENT_VERSION, { key: "reviewer", name: "Reviewer" }],
    [OTHER_AGENT, { key: null, name: "Planner" }],
  ]),
};

const withReferences = () => ({
  agents: { "review.independent": AGENT_VERSION, "rpi.plan": OTHER_AGENT },
  steps: [
    {
      id: "a",
      uses: "review.independent",
      skills: [SKILL_VERSION, OTHER_SKILL],
      agentVersionId: AGENT_VERSION,
    },
    {
      id: "b",
      uses: "rpi.plan",
      skills: [OTHER_SKILL],
      agentVersionId: OTHER_AGENT,
    },
  ],
});

Deno.test("export keeps references to what the package carries and removes the rest, naming it", () => {
  const { definition, openBindings } = exportReferences(
    withReferences(),
    known,
  );
  const text = JSON.stringify(definition);
  for (const id of [SKILL_VERSION, OTHER_SKILL, AGENT_VERSION, OTHER_AGENT]) {
    assertEquals(text.includes(id), false, `${id} must not leave`);
  }
  assert(text.includes("package:skill/review-style"));
  assert(text.includes("package:agent/reviewer"));
  assertEquals(
    openBindings.map((b) => `${b.kind}:${b.name}`).sort(),
    [
      "agent:Planner",
      "agent:Planner",
      "skill:House rules",
      "skill:House rules",
    ],
  );
});

Deno.test("import swaps each package reference for the id it just made", () => {
  const { definition } = exportReferences(withReferences(), known);
  const back = importReferences(definition, {
    skill: new Map([["review-style", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]]),
    agent: new Map([["reviewer", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]]),
  });
  const text = JSON.stringify(back);
  assert(text.includes("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  assert(text.includes("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  assertEquals(text.includes("package:"), false);
});

Deno.test("a reference to something the package does not carry is a defect", async () => {
  const pkg = await buildPackage("Starter", [
    workflow({
      steps: [{ id: "a", uses: "x", skills: ["package:skill/missing"] }],
    }),
  ]);
  assert(
    (await packageDefects(pkg)).some((d) =>
      d.code === "unresolved_package_reference"
    ),
  );
});

Deno.test("a path that could leave its directory is refused, wherever a package carries one", async () => {
  for (
    const path of [
      "../../x",
      "a/../../x",
      "/etc/passwd",
      "a//b",
      "./a",
      "a/.",
      "a\\b",
      "C:/x",
      "a\u0000b",
      "",
      "a".repeat(501),
    ]
  ) assertEquals(unsafePackagePath(path), true, JSON.stringify(path));
  for (const path of ["SKILL.md", "references/sources.md", "a/b/c.txt"]) {
    assertEquals(unsafePackagePath(path), false, path);
  }

  const skill = (overrides: Record<string, unknown>) =>
    buildPackage("Starter", [{
      kind: "skill",
      key: "research",
      data: {
        slug: "research",
        name: "Research",
        entryPath: "SKILL.md",
        manifest: { schemaVersion: 1, license: "MIT" },
        files: [{
          path: "SKILL.md",
          mediaType: "text/markdown",
          isExecutable: false,
          contentBase64: "aGk=",
        }],
        ...overrides,
      },
    }]);
  const unsafe = async (overrides: Record<string, unknown>) =>
    (await packageDefects(await skill(overrides))).filter((d) =>
      d.code === "package_path_unsafe"
    ).map((d) => d.path.join("/"));
  assertEquals(await unsafe({}), []);
  assertEquals(await unsafe({ entryPath: "../../x" }), [
    "items/0/data/entryPath",
  ]);
  assertEquals(
    await unsafe({
      files: [{
        path: "../../x",
        mediaType: "text/plain",
        isExecutable: false,
        contentBase64: "aGk=",
      }],
    }),
    ["items/0/data/files/0/path"],
  );
  assertEquals(
    await unsafe({
      manifest: {
        schemaVersion: 1,
        license: "MIT",
        entryPath: "../up",
        files: [{ path: "/abs" }, { path: "ok.md" }],
      },
    }),
    ["items/0/data/manifest/files/0", "items/0/data/manifest/entryPath"],
  );
});

Deno.test("a skill or agent bound by a raw id, which another organization's id would be, is refused", async () => {
  const raw = {
    agents: { "agent.freeform": AGENT_VERSION },
    steps: [{
      id: "think",
      uses: "agent.freeform",
      agentVersionId: AGENT_VERSION,
      skills: [SKILL_VERSION, "package:skill/ok"],
    }],
  };
  assertEquals(
    rawBindingsIn(raw),
    [
      "/agents/agent.freeform",
      "/steps/0/skills/0",
      "/steps/0/agentVersionId",
    ].sort((a, b) =>
      rawBindingsIn(raw).indexOf(a) - rawBindingsIn(raw).indexOf(b)
    ),
  );
  const pkg = await buildPackage("Starter", [workflow(raw)]);
  assertEquals(
    (await packageDefects(pkg)).filter((d) => d.code === "package_raw_binding")
      .length,
    3,
  );
  // References, and no binding at all, are what an export writes.
  assertEquals(
    rawBindingsIn({
      steps: [{
        id: "think",
        uses: "agent.freeform",
        agentVersionId: "package:agent/reviewer",
        skills: ["package:skill/research"],
      }],
    }),
    [],
  );
  assertEquals(
    rawBindingsIn({ steps: [{ id: "go", uses: "workflow.noop" }] }),
    [],
  );
});
