import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  refreshV0References,
  selectV0Cases,
  serializeBaseline,
} from "../scripts/render-v0-references.mjs";

const REAL_BASELINE = new URL(
  "../../../docs/technical-design/ui-baselines/paper-baselines.json",
  import.meta.url,
);

/** A small manifest copy: two V-0 cases, one K-0 case and one code-reference case. */
const fixture = () => ({
  schemaVersion: 2,
  source: { revision: "old", digest: "old-digest", inputs: ["a"] },
  sourceProfiles: { "K-0": { source: { digest: "k0" } } },
  cases: [
    {
      id: "login.default.light.desktop",
      reference: "design",
      imageSha256: "x",
    },
    { id: "login.default.dark.phone", reference: "design", imageSha256: "y" },
    {
      id: "worker.default.light.desktop",
      reference: "design",
      sourceProfile: "K-0",
      imageSha256: "k0",
    },
    { id: "story.only", reference: "code", imageSha256: "z" },
  ],
  excluded: [],
});

test("selects design cases without a sourceProfile only", () => {
  assert.deepEqual(
    selectV0Cases(fixture()).map(({ id }) => id),
    ["login.default.light.desktop", "login.default.dark.phone"],
  );
});

test("re-renders only V-0 cases, restamps source, leaves K-0 and the rest alone", async () => {
  const baseline = fixture();
  const before = structuredClone(baseline);
  const rendered = [];
  const identityCalls = [];
  const result = await refreshV0References(baseline, "browser", {
    render: (browser, manifest, designCase) => {
      assert.equal(browser, "browser");
      assert.equal(manifest, baseline);
      rendered.push(designCase.id);
      designCase.imageSha256 = `new-${designCase.id}`;
    },
    identity: (_manifest, designCase) => {
      identityCalls.push(designCase);
      return Promise.resolve({ revision: "new-rev", digest: "new-digest" });
    },
  });
  assert.deepEqual(rendered, [
    "login.default.light.desktop",
    "login.default.dark.phone",
  ]);
  assert.equal(result.length, 2);
  // The identity is the unpinned V-0 selection: an empty case object.
  assert.deepEqual(identityCalls, [{}]);
  assert.deepEqual(baseline.source, {
    revision: "new-rev",
    digest: "new-digest",
    inputs: ["a"],
  });
  assert.equal(
    baseline.cases[0].imageSha256,
    "new-login.default.light.desktop",
  );
  assert.deepEqual(baseline.cases[2], before.cases[2]);
  assert.deepEqual(baseline.cases[3], before.cases[3]);
  assert.deepEqual(baseline.sourceProfiles, before.sourceProfiles);
  assert.deepEqual(baseline.excluded, before.excluded);
});

test("refuses a manifest that is not schemaVersion 2", async () => {
  await assert.rejects(
    refreshV0References({ ...fixture(), schemaVersion: 1 }, "browser", {
      render: () => {},
      identity: () => Promise.resolve({}),
    }),
    /schemaVersion 1/,
  );
});

test("saves a temp manifest copy with two-space JSON and one trailing newline, never the real one", async () => {
  const realBefore = await readFile(REAL_BASELINE, "utf8");
  const directory = await mkdtemp(join(tmpdir(), "render-v0-"));
  try {
    const path = join(directory, "paper-baselines.json");
    const baseline = fixture();
    await refreshV0References(baseline, "browser", {
      render: (_browser, _manifest, designCase) => {
        designCase.imageSha256 = "fresh";
      },
      identity: () => Promise.resolve({ revision: "r", digest: "d" }),
    });
    await writeFile(path, serializeBaseline(baseline));
    const saved = await readFile(path, "utf8");
    assert.equal(saved, JSON.stringify(JSON.parse(saved), null, 2) + "\n");
    assert.ok(saved.endsWith("}\n") && !saved.endsWith("\n\n"));
    assert.equal(JSON.parse(saved).cases[0].imageSha256, "fresh");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(await readFile(REAL_BASELINE, "utf8"), realBefore);
});
