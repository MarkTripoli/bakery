import { assert, assertEquals } from "@std/assert";
import {
  BakeryPackageSchema,
  buildPackage,
  packageDefects,
  type PackageItemDraft,
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
