import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approveGate, gateReview } from "./release.mjs";
import {
  addApproval,
  APPROVAL_LIMIT,
  approves,
  gateChanges,
  gateDigests,
  gateFingerprint,
  readApprovals,
  TRUSTED_GATE_PATHS,
} from "./trusted-gate.mjs";

const active = "a".repeat(40), next = "b".repeat(40), other = "c".repeat(40);

async function release(root, sha, files) {
  const directory = join(root, "releases", sha);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), text);
  }
  await mkdir(directory, { recursive: true });
  return directory;
}

const launcher = "scripts/deploy/release.mjs";
const rules = "apps/server/src/modules/repository-rules/effective.ts";
const elsewhere = "apps/web/src/main.tsx";

test("the trusted gate covers the launcher, the production policy and the merge checks", () => {
  assert.deepEqual([...TRUSTED_GATE_PATHS], [
    "scripts/deploy",
    "infra/production",
    "apps/server/src/modules/repository-rules",
  ]);
});

test("digests cover only the trusted paths, nested files included, and links are never followed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gate-"));
  const directory = await release(root, active, {
    [launcher]: "launcher",
    "scripts/deploy/nested/run.sh": "run",
    [rules]: "rules",
    "infra/production/migration-policy.json": "{}",
    [elsewhere]: "not trusted",
  });
  await symlink("/etc/passwd", join(directory, "scripts/deploy/escape"));
  // A link to a directory with files in it: the files are outside the release.
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "not part of the release");
  await symlink(outside, join(directory, "scripts/deploy/linked"));
  const digests = await gateDigests(directory);
  assert.deepEqual(Object.keys(digests).sort(), [
    "apps/server/src/modules/repository-rules/effective.ts",
    "infra/production/migration-policy.json",
    "scripts/deploy/escape",
    "scripts/deploy/linked",
    "scripts/deploy/nested/run.sh",
    "scripts/deploy/release.mjs",
  ]);
  // A link is digested by where it points, never by what it points at.
  const linkDigest = (target) =>
    createHash("sha256").update(`link:${target}`).digest("hex");
  assert.equal(digests["scripts/deploy/escape"], linkDigest("/etc/passwd"));
  assert.equal(digests["scripts/deploy/linked"], linkDigest(outside));
  assert.ok(
    !Object.keys(digests).some((path) => path.includes("secret.txt")),
    "a linked directory is not walked",
  );
  // Reading it again gives the same digests.
  assert.deepEqual(await gateDigests(directory), digests);
  // Pointing the link somewhere else is a change to the gate.
  await rm(join(directory, "scripts/deploy/escape"));
  await symlink("/etc/shadow", join(directory, "scripts/deploy/escape"));
  assert.deepEqual(gateChanges(digests, await gateDigests(directory)), [
    { path: "scripts/deploy/escape", kind: "changed" },
  ]);
  assert.ok(!(elsewhere in digests), "nothing outside the trusted paths");
  assert.deepEqual(
    await gateDigests(join(root, "nowhere")),
    {},
    "a missing release has no files",
  );
});

test("changes name every added, removed and changed file, in order, and nothing when the gate is the same", () => {
  const before = { "a/x": "1", "a/y": "2", "a/z": "3" };
  assert.deepEqual(gateChanges(before, { ...before }), []);
  assert.deepEqual(
    gateChanges(before, { "a/x": "1", "a/y": "9", "a/new": "4" }),
    [
      { path: "a/new", kind: "added" },
      { path: "a/y", kind: "changed" },
      { path: "a/z", kind: "removed" },
    ],
  );
  assert.notEqual(
    gateFingerprint({ "a/x": "1" }),
    gateFingerprint({ "a/x": "2" }),
  );
  assert.equal(
    gateFingerprint({ "a/x": "1", "a/y": "2" }),
    gateFingerprint({ "a/y": "2", "a/x": "1" }),
    "the order the files were read in does not matter",
  );
});

test("an approval covers exactly this candidate, this running release and this gate", () => {
  const entry = { sha: next, active, fingerprint: "f1", by: "mark", at: "x" };
  const move = { sha: next, active, fingerprint: "f1" };
  assert.equal(approves([entry], move), true);
  assert.equal(approves([entry], { ...move, sha: other }), false);
  assert.equal(approves([entry], { ...move, active: other }), false);
  assert.equal(approves([entry], { ...move, fingerprint: "f2" }), false);
  assert.equal(approves([], move), false);
});

test("approvals are kept to the latest few, and a missing or damaged file means none", async () => {
  const root = await mkdtemp(join(tmpdir(), "gate-approvals-"));
  const path = join(root, "gate-approvals.json");
  assert.deepEqual(await readApprovals(path), []);
  await writeFile(path, "not json");
  assert.deepEqual(await readApprovals(path), [], "fails closed");
  await writeFile(path, JSON.stringify({ not: "a list" }));
  assert.deepEqual(await readApprovals(path), []);
  let text = "";
  const write = (_path, value) => {
    text = value;
    return writeFile(path, value);
  };
  await writeFile(path, "[]");
  for (let n = 0; n < APPROVAL_LIMIT + 5; n++) {
    await addApproval(path, { n }, write);
  }
  const kept = JSON.parse(text);
  assert.equal(kept.length, APPROVAL_LIMIT);
  assert.equal(kept.at(-1).n, APPROVAL_LIMIT + 4);
});

async function twoReleases(changed) {
  const root = await mkdtemp(join(tmpdir(), "gate-review-"));
  await release(root, active, { [launcher]: "old", [rules]: "rules" });
  await release(root, next, {
    [launcher]: changed ? "new" : "old",
    [rules]: "rules",
  });
  return { root, approvalsPath: join(root, "approvals.json") };
}

test("a review of an unchanged gate is approved, a changed one is not until approved", async () => {
  const same = await twoReleases(false);
  const review = await gateReview(active, next, same);
  assert.deepEqual(review.changes, []);
  assert.equal(review.approved, true);

  const changed = await twoReleases(true);
  const held = await gateReview(active, next, changed);
  assert.deepEqual(held.changes, [{ path: launcher, kind: "changed" }]);
  assert.equal(held.approved, false);
  await writeFile(
    changed.approvalsPath,
    JSON.stringify([{ sha: next, active, fingerprint: held.fingerprint }]),
  );
  assert.equal((await gateReview(active, next, changed)).approved, true);
  // The candidate changes its gate again after the approval: not approved.
  await writeFile(join(changed.root, "releases", next, launcher), "newer");
  assert.equal((await gateReview(active, next, changed)).approved, false);
  await assert.rejects(
    gateReview(active, other, changed),
    { code: "ENOENT" },
    "a release that is not on disk is not an empty gate",
  );
});

function approver(root, answer) {
  const printed = [];
  const asked = [];
  return {
    printed,
    asked,
    deps: {
      confirm: (question) => {
        asked.push(question);
        return Promise.resolve(answer);
      },
      review: (a, s) =>
        gateReview(a, s, { root, approvalsPath: join(root, "approvals.json") }),
      who: () => "mark",
      write: (path, text) => writeFile(path, text),
      approvalsPath: join(root, "approvals.json"),
      print: (line) => printed.push(line),
      now: () => new Date("2026-11-22T09:30:00.000Z"),
    },
  };
}

const running = { active: { sha: active, slot: "blue" } };

test("approve-gate shows what changes, asks, and records who approved exactly that move", async () => {
  const { root } = await twoReleases(true);
  const a = approver(root, true);
  const approval = await approveGate(running, next, a.deps);
  assert.equal(approval.by, "mark");
  assert.equal(approval.sha, next);
  assert.equal(approval.active, active);
  assert.equal(approval.at, "2026-11-22T09:30:00.000Z");
  assert.deepEqual(a.asked, ["Approve this change?"]);
  assert.match(
    a.printed.join("\n"),
    /changes 1 file of the checks or the launcher/,
  );
  assert.match(a.printed.join("\n"), /changed\s+scripts\/deploy\/release\.mjs/);
  assert.match(
    a.printed.at(-1),
    /Approved by mark at 09:30 UTC\. Run the update again\./,
  );
  const review = await gateReview(active, next, {
    root,
    approvalsPath: join(root, "approvals.json"),
  });
  assert.equal(review.approved, true);
  assert.equal(
    (await gateReview(active, other === next ? active : next, {
      root,
      approvalsPath: join(root, "approvals.json"),
    })).approved,
    true,
  );
});

test("no yes means no approval: Enter, no terminal, or anything else records nothing", async () => {
  const { root } = await twoReleases(true);
  for (const answer of [false, null]) {
    const a = approver(root, answer);
    await assert.rejects(
      approveGate(running, next, a.deps),
      /GATE_NOT_APPROVED/,
    );
    assert.deepEqual(await readApprovals(a.deps.approvalsPath), []);
  }
});

test("approve-gate refuses with nothing running, an unprepared release, and says when there is nothing to approve", async () => {
  const { root } = await twoReleases(false);
  const a = approver(root, true);
  await assert.rejects(approveGate(null, next, a.deps), /GATE_NOTHING_RUNNING/);
  await assert.rejects(
    approveGate(running, other, a.deps),
    /GATE_RELEASE_NOT_PREPARED/,
  );
  await assert.rejects(
    approveGate(running, "not-a-sha", a.deps),
    /RELEASE_SHA_INVALID/,
  );
  assert.equal(await approveGate(running, next, a.deps), null);
  assert.match(a.printed.join(" "), /nothing to approve/);
  assert.deepEqual(a.asked, [], "no question when nothing changes");
});
