import { assert, assertEquals } from "@std/assert";
import { loadAdditionalPaperBaselines } from "../../scripts/ui-paper-manifests.ts";
import {
  type PaperBaselineManifest,
  type PaperManifest,
  type PaperSpecimensManifest,
  type RuntimeManifest,
  validateVisualClosure,
} from "../../scripts/verify-ui-stories.ts";

const root = new URL("../../", import.meta.url);
const read = async (path: string) =>
  JSON.parse(await Deno.readTextFile(new URL(path, root)));

async function fixture() {
  const catalog: Parameters<typeof validateVisualClosure>[0] = await read(
    "docs/technical-design/ui-baselines/components.json",
  );
  const runtime: RuntimeManifest = await read(
    "docs/technical-design/ui-baselines/runtime-cases.json",
  );
  const baselines: PaperBaselineManifest = await read(
    "docs/technical-design/ui-baselines/paper-baselines.json",
  );
  const manifest: PaperManifest = await read(
    "docs/technical-design/auth-mocks/paper-manifest.json",
  );
  const specimens: PaperSpecimensManifest = await read(
    "docs/technical-design/ui-baselines/paper-specimens.json",
  );
  const profiles: Record<string, PaperManifest> = {};
  for (const [id, profile] of Object.entries(baselines.sourceProfiles ?? {})) {
    profiles[id] = await read(profile.source.manifestPath);
  }
  const additional = await loadAdditionalPaperBaselines();
  const artifactManifest = additional.find((item) =>
    item.source?.fileId === "bakery-repo-e05"
  );
  assert(artifactManifest);
  const artifact = artifactManifest.cases.find((item) =>
    item.id === "task-run.default.light.desktop"
  );
  assert(artifact);
  const runtimeCase = runtime.cases.find((item) =>
    item.id === "ui.artifactPane.contract.desktop-light-fine"
  );
  assert(runtimeCase);
  artifact.catalogId = runtimeCase.catalogId;
  artifact.requiredStoryCase = runtimeCase.requiredCaseId;
  runtimeCase.paperBaselineId = artifact.id;
  return {
    baselines,
    additional,
    artifact,
    runtime,
    runtimeCase,
    validate: () =>
      validateVisualClosure(
        catalog,
        runtime,
        baselines,
        manifest,
        specimens,
        profiles,
        additional,
      ),
  };
}

Deno.test("Paper bindings accept artifacts alongside existing settings and enterprise bindings", async () => {
  const data = await fixture();

  const errors = data.validate();

  assertEquals(errors, []);
});

Deno.test("Paper bindings reject unknown IDs across configured manifests", async () => {
  const data = await fixture();
  data.runtimeCase.paperBaselineId = "unknown-artifact";

  const errors = data.validate();

  assertEquals(errors, [
    `${data.runtimeCase.id} references missing Paper baseline unknown-artifact`,
  ]);
});

for (const field of ["catalogId", "requiredStoryCase"] as const) {
  Deno.test(`Paper bindings reject artifacts with mismatched ${field}`, async () => {
    const data = await fixture();
    data.artifact[field] = "unrelated";

    const errors = data.validate();

    assertEquals(errors, [
      `${data.runtimeCase.id} does not match Paper baseline ${data.artifact.id}`,
    ]);
  });
}

Deno.test("Paper bindings reject duplicate IDs across manifests", async () => {
  const data = await fixture();
  const existing = data.baselines.cases[0];
  assert(existing);
  data.additional[0].cases.push(structuredClone(existing));

  const errors = data.validate();

  assertEquals(errors, [`Paper baseline ${existing.id} is duplicated`]);
});

Deno.test("Paper bindings reject artifact IDs bound more than once", async () => {
  const data = await fixture();
  data.runtime.cases.push({ ...data.runtimeCase, id: "duplicate-binding" });

  const errors = data.validate();

  assertEquals(errors, [
    `Paper baseline ${data.artifact.id} is bound more than once`,
  ]);
});

Deno.test("Paper bindings reject unsupported additional manifest versions", async () => {
  const data = await fixture();
  data.additional[0].schemaVersion = 99;

  const errors = data.validate();

  assertEquals(errors, ["Unsupported Paper baseline schema version"]);
});
