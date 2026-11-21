import assert from "node:assert/strict";
import test from "node:test";
import {
  completionLines,
  failedStepLine,
  failureLines,
  statusLines,
  STEP_LABELS,
  stepLine,
  unsureLines,
} from "./release-messages.mjs";
import { recover, transition } from "./release.mjs";

const blue = "a".repeat(40), green = "b".repeat(40), hash = "c".repeat(64);
const migration = "apps/server/src/platform/migrations/001.sql";
const addition = "apps/server/src/platform/migrations/002.sql";
const wide = (lines) => lines.every((line) => line.length <= 80);

test("each refusal says what state Bakery is in, that nothing changed, the next step and ends with its code", () => {
  const cases = [
    [
      "ROLLBACK_SCHEMA_INCOMPATIBLE",
      /Going back is not possible/,
      /restore a backup/,
    ],
    [
      "NO_ROLLBACK_BASELINE",
      /There is no earlier version to go back to/,
      /After a restore/,
    ],
    [
      "MIGRATION_COMPATIBILITY_REVIEW_REQUIRED",
      /It was not installed/,
      /expand list/,
    ],
  ];
  for (const [code, first, next] of cases) {
    const lines = failureLines(new Error(code), {
      active: blue,
      previous: green,
    });
    assert.match(lines[0] + " " + lines[1], first, code);
    assert.match(lines.join(" "), next, code);
    assert.equal(lines.at(-1), `[${code}]`);
    assert.ok(
      wide(lines.slice(0, -1)),
      `${code} fits 80 columns: ${lines.join("|")}`,
    );
  }
  assert.match(
    failureLines(new Error("ROLLBACK_SCHEMA_INCOMPATIBLE"), {
      active: blue,
      previous: green,
    }).join(" "),
    new RegExp(`Bakery stays on ${blue.slice(0, 8)}. Nothing was changed`),
  );
});

test("a failure after the switch began says the update did not go through, not that anything was lost", () => {
  const undone = failureLines(new Error("SMOKE_RELEASE_NOT_READY"), {
    command: "deploy",
    active: blue,
    phase: "committed",
  });
  assert.match(
    undone[0],
    /The update did not go through\. Bakery is still running aaaaaaaa/,
  );
  assert.ok(!undone.join(" ").includes("lost"));
  assert.equal(undone.at(-1), "[SMOKE_RELEASE_NOT_READY]");

  const uncertain = failureLines(new Error("DEPLOY_PUBLIC_FAILED:1"), {
    command: "deploy",
    active: blue,
    phase: "switching",
  });
  assert.match(uncertain.join(" "), /cannot tell which version is active/);
  assert.match(uncertain.join(" "), /Run: bakery-release recover/);
});

test("an unmapped failure still prints its code", () => {
  assert.deepEqual(failureLines(new Error("SOMETHING_NEW"), {}), [
    "SOMETHING_NEW",
  ]);
});

test("failures before the first step do not print a failed step", () => {
  assert.equal(failedStepLine(1, 6, "NO_ROLLBACK_BASELINE"), null);
  assert.equal(
    failedStepLine(2, 6, "MIGRATION_COMPATIBILITY_REVIEW_REQUIRED"),
    "2/6 Checking database changes  failed",
  );
  assert.equal(
    failedStepLine(3, 6, "INSTALLATION_RESTORING"),
    "3/6 Pausing work               failed",
  );
  assert.equal(failedStepLine(7, 6, "X"), null);
});

test("the three ways a pause is refused each say what to do and that nothing changed", () => {
  const restoring = failureLines(new Error("INSTALLATION_RESTORING"), {
    active: blue,
  });
  assert.match(
    restoring.join(" "),
    /held after a restore, so it was not updated\. Finish the restore first: open Bakery, Installation, Restore/,
  );
  assert.equal(restoring.at(-1), "[INSTALLATION_RESTORING]");
  const backup = failureLines(new Error("MAINTENANCE_HELD"), { active: blue });
  assert.match(backup.join(" "), /A backup is running.*Nothing was changed/);
  const slow = failureLines(new Error("DRAIN_TIMEOUT"), { active: blue });
  assert.match(slow.join(" "), /did not finish in time.*taking work as before/);
  for (const lines of [restoring, backup, slow]) {
    assert.ok(wide(lines.slice(0, -1)), lines.join("|"));
  }
});

test("status prints the same labelled lines whether idle, waiting or interrupted", () => {
  const committed = {
    phase: "committed",
    active: { sha: blue, slot: "blue" },
    previous: { sha: green, slot: "green" },
  };
  const counts = {
    tasks: 3,
    approvals: 1,
    questions: 2,
    outsideActionsUnsure: 0,
  };
  assert.deepEqual(statusLines(committed, counts), [
    `Running          ${blue} (blue)`,
    `Can go back to   ${green}`,
    "Work             3 tasks, 1 approval, 2 open questions",
    "State            Ready.",
  ]);
  assert.match(
    statusLines({ ...committed, previous: null }, counts)[1],
    /No earlier version is kept\./,
  );
  assert.match(statusLines(committed, null)[2], /database did not answer/);
  assert.match(statusLines(null)[0], /nothing is installed yet/);
  const interrupted = statusLines({
    ...committed,
    phase: "switching",
    desired: { sha: green, slot: "green" },
  }, counts);
  assert.match(interrupted[0], /not certain/);
  assert.equal(interrupted.at(-1), "Run: bakery-release recover");
  assert.ok(wide(statusLines(committed, counts)));
  const unsure = statusLines(committed, { ...counts, outsideActionsUnsure: 2 });
  assert.match(unsure.join(" "), /2 outside actions are held/);
  assert.match(unsure.join(" "), /never sends them again/);
  assert.equal(unsure.at(-1), "See them: bakery-release status --unsure");
});

test("status --unsure lists the unknown outside actions by kind, with no targets", () => {
  assert.deepEqual(unsureLines([]), ["No outside action needs a look."]);
  const lines = unsureLines([
    {
      operation: "github.issue.create",
      count: 2,
      since: "2026-11-21T03:00:00Z",
    },
  ]);
  assert.match(
    lines.join("\n"),
    /2 actions of github\.issue\.create, since 2026-11-21T03:00:00Z/,
  );
  assert.match(unsureLines(null)[0], /database did not answer/);
});

test("completion lines name what was carried over, the kept version and the exact rollback command", () => {
  const state = { active: { sha: green }, previous: { sha: blue } };
  const counts = {
    tasks: 12,
    approvals: 0,
    questions: 1,
    outsideActionsUnsure: 0,
  };
  assert.deepEqual(
    completionLines("deploy", state, { active: { sha: blue } }, counts),
    [
      "Updated. Bakery is running bbbbbbbb.",
      "Carried over: 12 tasks, 0 approvals, 1 open question. Work has resumed.",
      "aaaaaaaa is kept so you can go back:",
      `  bakery-release rollback ${green}`,
    ],
  );
  assert.deepEqual(
    completionLines("deploy", state, { active: { sha: blue } }, null).slice(
      1,
      3,
    ),
    [
      "Work could not be resumed just now. It starts again by itself within",
      "35 minutes, or run: bakery-release recover",
    ],
  );
  assert.deepEqual(
    completionLines("deploy", state, { active: { sha: green } }),
    ["Bakery is already running bbbbbbbb. Nothing was changed."],
  );
  assert.deepEqual(
    completionLines("rollback", { active: { sha: blue } }, state),
    ["Went back. Bakery is running aaaaaaaa.", "The database was not changed."],
  );
});

function harness(initial, { fail, pause, resumeFails } = {}) {
  let state = structuredClone(initial);
  const calls = [];
  const store = {
    read: () => Promise.resolve(structuredClone(state)),
    write: (v) => {
      state = structuredClone(v);
      return Promise.resolve();
    },
  };
  const release = (sha, migrations, expand = []) => ({
    format: 1,
    sha,
    architecture: "arm64",
    release: `bakery@${sha}`,
    migrations,
    assets: { "assets/index.js": hash },
    expand,
  });
  const manifests = {
    [blue]: release(blue, { [migration]: hash }),
    [green]: release(green, { [migration]: hash, [addition]: hash }, [{
      path: addition,
      sha256: hash,
    }]),
  };
  const noop = () => Promise.resolve();
  const operations = {
    prepare: noop,
    backup: () => {
      calls.push("backup");
      return Promise.resolve();
    },
    migrate: noop,
    services: noop,
    nativeProbe: noop,
    startApi: noop,
    greenSmoke: noop,
    switchProxy: noop,
    background: noop,
    backgroundSmoke: noop,
    stopApi: noop,
    manifest: (sha) => Promise.resolve(manifests[sha]),
    publicSmoke: (active) =>
      fail && active.sha === green
        ? Promise.reject(new Error("SMOKE_RELEASE_NOT_READY"))
        : Promise.resolve(),
    ...(pause === undefined ? {} : {
      pause: (sha) => {
        calls.push(`pause ${sha === green ? "green" : "other"}`);
        return pause instanceof Error
          ? Promise.reject(pause)
          : Promise.resolve();
      },
      resume: (sha) => {
        calls.push(`resume ${sha === green ? "green" : "other"}`);
        if (resumeFails) return Promise.reject(new Error("DB_DOWN"));
        return Promise.resolve({
          released: true,
          carriedOver: {
            tasks: 4,
            approvals: 1,
            questions: 0,
            outsideActionsUnsure: 0,
          },
        });
      },
    }),
  };
  return { store, operations, state: () => state, calls };
}

const committed = {
  format: 1,
  phase: "committed",
  active: { sha: blue, slot: "blue" },
  previous: null,
  migrations: { [migration]: hash },
};

const run = (h, progress, sha = green, rollback = false, bootstrap = false) =>
  transition(h.store, h.operations, sha, hash, rollback, bootstrap, progress);

test("transition reports its six steps in order, pauses before the snapshot and resumes after the commit", async () => {
  const h = harness(committed, { pause: null });
  const lines = [];
  const events = [];
  await run(h, (event) => {
    if ("resumed" in event) events.push(event);
    else lines.push(stepLine(event));
  });
  assert.deepEqual(lines, [
    "1/6 Checking the release       ok",
    "2/6 Checking database changes  1 to apply",
    "3/6 Pausing work               quiet",
    "4/6 Saving a snapshot          ok",
    "5/6 Switching                  ok",
    "6/6 Checking health            ok",
  ]);
  assert.equal(STEP_LABELS.length, 6);
  assert.deepEqual(h.calls, ["pause green", "backup", "resume green"]);
  assert.deepEqual(events, [{
    resumed: { tasks: 4, approvals: 1, questions: 0, outsideActionsUnsure: 0 },
  }]);
});

test("a refused pause throws before anything is written, with nothing to undo", async () => {
  const h = harness(committed, { pause: new Error("INSTALLATION_RESTORING") });
  const lines = [];
  await assert.rejects(
    run(h, (event) => lines.push(stepLine(event))),
    /INSTALLATION_RESTORING/,
  );
  assert.equal(lines.length, 2, "only the two checks before the pause ran");
  assert.deepEqual(h.state(), committed, "the journal was never touched");
  assert.deepEqual(h.calls, ["pause green"], "no snapshot, no resume to undo");
});

test("a failed health check resumes work on the old version and leaves the earlier steps reported", async () => {
  const h = harness(committed, { fail: true, pause: null });
  const lines = [];
  await assert.rejects(
    run(h, (event) => lines.push(stepLine(event))),
    /SMOKE_RELEASE_NOT_READY/,
  );
  assert.equal(lines.length, 4, "failed while switching, before step 5");
  assert.equal(h.state().phase, "committed");
  assert.equal(h.state().active.sha, blue);
  assert.deepEqual(h.calls, ["pause green", "backup", "resume green"]);
});

test("a rollback and a first install never pause: they must work when Bakery is broken or empty", async () => {
  const back = harness({
    ...committed,
    active: { sha: green, slot: "green" },
    previous: { sha: blue, slot: "blue" },
    migrations: { [migration]: hash, [addition]: hash },
  }, { pause: null });
  const lines = [];
  await run(back, (event) => lines.push(stepLine(event)), blue, true);
  assert.equal(lines[2], "3/6 Pausing work               skipped");
  assert.ok(!back.calls.some((call) => call.startsWith("pause")));
  const first = harness({
    format: 1,
    phase: "committed",
    active: null,
    previous: null,
    migrations: {},
  }, { pause: null });
  await run(first, () => {}, blue, false, true);
  assert.ok(!first.calls.some((call) => call.startsWith("pause")));
});

test("a host with no pause still updates, reporting the step as skipped", async () => {
  const h = harness(committed);
  const lines = [];
  await run(h, (event) => lines.push(stepLine(event)));
  assert.equal(lines[2], "3/6 Pausing work               skipped");
});

test("recover resumes a pause a dead launcher left behind, and keeps the record until it really resumed", async () => {
  const stuck = { ...committed, paused: green };
  const failing = harness(stuck, { pause: null, resumeFails: true });
  assert.deepEqual(await recover(failing.store, failing.operations), stuck);
  assert.equal(
    failing.state().paused,
    green,
    "the record stays for the next try",
  );

  const h = harness(stuck, { pause: null });
  const after = await recover(h.store, h.operations);
  assert.deepEqual(h.calls, ["resume green"]);
  assert.equal("paused" in after, false);
  assert.equal("paused" in h.state(), false);
});

test("recover on an untouched journal never calls the database", async () => {
  const h = harness(committed, { pause: null });
  await recover(h.store, h.operations);
  assert.deepEqual(h.calls, []);
});
