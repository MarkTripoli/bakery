// A ruling identity declares a digest over the ruling citation, its text, the
// sanctioned app commit, every pinned input's bytes and every refreshed case.
// compare-paper.mjs recomputes that digest and rejects a mismatch, but only
// when it runs, and only for the snapshots it walks. A torn write - two
// reanchor runs racing on paper-baselines.json, one writing the digest while
// the other wrote the cases - leaves a file whose declared digest does not
// describe its own bytes. That is invisible until a verifier recomputes it by
// hand, which is exactly how 48241a0f-vs-b4b45db9 was found.
//
// This test recomputes the digest from the committed bytes and asserts it
// equals the declared value, so a torn file fails a gate instead of a review.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";

const { sourceKind } = await import(
  new URL("../scripts/compare-paper.mjs", import.meta.url).href
);
const { uxRulingIdentity } = await import(
  new URL("../scripts/reanchor-design-references.mjs", import.meta.url).href
);

const root = new URL("../../..", import.meta.url);
const baselinePath = "docs/technical-design/ui-baselines/paper-baselines.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readBaseline() {
  return JSON.parse(readFileSync(new URL(baselinePath, root), "utf8"));
}

// The identity is only defined for a ruling refresh; a Paper/V-0 baseline
// carries a different provenance scheme and is verified by its own gate.
test("the ruling digest describes the baseline's own bytes", () => {
  const manifest = readBaseline();
  if (sourceKind(manifest) !== "ux-ruling") return;

  const match = /^ux-ruling:([\w.-]+)#(\d+); app:([0-9a-f]{7,40})$/.exec(
    manifest.source.revision ?? "",
  );
  assert.ok(
    match,
    "the ruling identity must read ux-ruling:<issue>#<comment>; app:<sha>",
  );

  const cases = manifest.cases.filter((entry) =>
    entry.designRuling !== undefined
  );
  assert.ok(
    cases.length > 0,
    "no case cites the ruling that licensed this refresh",
  );

  const identity = uxRulingIdentity({
    ruling: `${match[1]}#${match[2]}`,
    app: match[3],
    cases,
    rulingBodySha256: manifest.source.rulingBodySha256,
    inputs: manifest.source.inputs,
  });

  assert.equal(
    identity.digest,
    manifest.source.digest,
    "the declared ruling digest does not match the licensed cases: " +
      "paper-baselines.json was written by more than one run, or an input " +
      "changed after the digest was computed. Re-run the reanchor once, alone.",
  );
});

// The vendored ruling body is what stops a citation from licensing a redesign
// the ruling never mentioned, so its bytes must match the pinned digest too.
test("the vendored ruling body matches its pinned digest", () => {
  const manifest = readBaseline();
  if (sourceKind(manifest) !== "ux-ruling") return;

  const bodyPath = manifest.source.rulingBodyPath;
  assert.equal(
    typeof bodyPath,
    "string",
    "the ruling identity does not pin a body path",
  );
  const body = readFileSync(new URL(bodyPath, root));
  assert.equal(
    sha256(body),
    manifest.source.rulingBodySha256,
    "the vendored ruling body does not match its pinned digest",
  );
});
