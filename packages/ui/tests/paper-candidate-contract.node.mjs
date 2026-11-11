import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const { baselineMetadataIssues, storyCandidateIssues } = await import(
  new URL("../scripts/compare-paper.mjs", import.meta.url).href
);
const manifest = JSON.parse(
  await readFile(
    "docs/technical-design/ui-baselines/paper-baselines.json",
    "utf8",
  ),
);
const stories = manifest.cases.filter((entry) => entry.sourceProfile === "K-0");
const baseline = stories.find((entry) =>
  entry.id === "detail.default.light.phone"
);
const metadata = (entry) =>
  baselineMetadataIssues({ ...manifest, cases: [entry] });
const capture = () => ({
  kind: "story",
  id: baseline.requiredStoryCase,
  requiredCaseId: baseline.requiredStoryCase,
  catalogId: baseline.catalogId,
  paperBaselineId: baseline.id,
  storyId: baseline.candidate.storyId,
  storyURL:
    `http://localhost/iframe.html?id=${baseline.candidate.storyId}&viewMode=story&args=state:ready`,
});
test("all twelve declared K-0 fixtures bind to runtime/catalog without web routes", () => {
  assert.equal(stories.length, 12);
  for (const entry of stories) assert.deepEqual(metadata(entry), [], entry.id);
  assert.deepEqual(storyCandidateIssues(baseline, capture()), []);
});
test("K-0 rejects missing, blank, unknown stories, args, states and hybrid routes", () => {
  for (
    const candidate of [
      null,
      "story",
      [],
      {},
      { ...baseline.candidate, storyId: "" },
      { ...baseline.candidate, storyId: "unknown--story" },
      { storyId: baseline.candidate.storyId },
      ...[null, [], {}, { state: "" }, { state: 1 }, { state: "unknown" }, {
        state: "ready",
        extra: "unknown",
      }].map((args) => ({ ...baseline.candidate, args })),
      { ...baseline.candidate, route: "/" },
      { ...baseline.candidate, session: "authenticated" },
      { ...baseline.candidate, route: "", session: null },
    ]
  ) {
    assert.ok(
      metadata({ ...baseline, candidate }).length,
      JSON.stringify(candidate),
    );
  }
  for (
    const patch of [
      { requiredStoryCase: "unknown" },
      { catalogId: "unknown" },
      { frameId: "wrong" },
      { sourceProfile: "unknown" },
      { candidate: stories[0].candidate },
    ]
  ) assert.ok(metadata({ ...baseline, ...patch }).length);
});
test("captured story and actual URL args must exactly match declared binding", () => {
  for (
    const patch of [
      { kind: "route" },
      { storyId: "unknown" },
      { id: "wrong" },
      { requiredCaseId: "wrong" },
      { catalogId: "wrong" },
      { paperBaselineId: "wrong" },
      { args: { state: "loading" } },
      { route: "/" },
      { session: "anonymous" },
      { storyURL: undefined },
      ...[
        "state:loading",
        "",
        "state:ready;extra:x",
        "state:ready;state:ready",
        "state:ready:extra",
      ].map((args) => ({
        storyURL: capture().storyURL.replace("state:ready", args),
      })),
      {
        storyURL: capture().storyURL.replace(
          baseline.candidate.storyId,
          "unknown",
        ),
      },
      { storyURL: `${capture().storyURL}&args=state:ready` },
    ]
  ) {
    assert.ok(
      storyCandidateIssues(baseline, { ...capture(), ...patch }).length,
      JSON.stringify(patch),
    );
  }
});
test("V-0 still requires route/session even when a story field is present", () => {
  const web = manifest.cases.find((entry) =>
    entry.reference === "design" && !entry.sourceProfile
  );
  assert.ok(web);
  assert.deepEqual(metadata(web), []);
  for (const field of ["route", "session"]) {
    const candidate = { ...web.candidate, storyId: baseline.candidate.storyId };
    delete candidate[field];
    assert.ok(
      metadata({ ...web, candidate }).some((issue) =>
        issue.includes(`candidate.${field}`)
      ),
    );
  }
  assert.ok(
    metadata({ ...web, sourceProfile: "unknown" }).some((issue) =>
      issue.includes("unsupported sourceProfile")
    ),
  );
});
