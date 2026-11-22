import assert from "node:assert/strict";
import test from "node:test";
import {
  askLines,
  completionLines,
  decisionLines,
  failedStepLine,
  failureLines,
  gateChangeLines,
  gateReviewLines,
  isRefusal,
  policyWords,
  statusLines,
  STEP_LABELS,
  stepLine,
  unsureLines,
} from "./release-messages.mjs";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askAtTerminal,
  forgetEvent,
  interruptedMove,
  keepEvent,
  MAX_KEPT_EVENTS,
  recover,
  resendEvents,
  transition,
} from "./release.mjs";

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
  assert.deepEqual(
    statusLines(committed, counts, { onFailure: "ask" }),
    [
      `Running          ${blue} (blue)`,
      `Can go back to   ${green}`,
      "Work             3 tasks, 1 approval, 2 open questions",
      "Update policy    ask before going back",
      "State            Ready.",
    ],
  );
  assert.equal(
    statusLines(committed, counts, { onFailure: "go_back" })[3],
    "Update policy    go back by itself",
  );
  assert.equal(
    statusLines(committed, counts, null)[3],
    "Update policy    not available just now",
  );
  assert.match(
    statusLines({ ...committed, previous: null }, counts)[1],
    /No earlier version is kept\./,
  );
  assert.match(statusLines(committed, null)[2], /database did not answer/);
  assert.equal(policyWords(undefined), "nothing is installed yet");
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

function harness(
  initial,
  {
    fail,
    failGreen,
    pause,
    resumeFails,
    policy,
    answer,
    recordResult,
    events,
    marker,
    failBackground,
    gate,
  } = {},
) {
  let state = structuredClone(initial);
  // `true` fails every resume; a number fails that many resumes, then works.
  let resumesToFail = resumeFails === true ? Infinity : resumeFails ?? 0;
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
    greenSmoke: () =>
      failGreen
        ? Promise.reject(new Error("SMOKE_RELEASE_NOT_READY"))
        : Promise.resolve(),
    switchProxy: noop,
    background: noop,
    backgroundSmoke: (active) =>
      failBackground && active?.sha === green
        ? Promise.reject(new Error("BACKGROUND_NOT_HEALTHY"))
        : Promise.resolve(),
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
        if (resumesToFail-- > 0) return Promise.reject(new Error("DB_DOWN"));
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
  if (policy !== undefined) {
    operations.policy = (sha) => {
      calls.push(`policy ${sha === green ? "green" : "other"}`);
      return policy instanceof Error
        ? Promise.reject(policy)
        : Promise.resolve({ onFailure: policy });
    };
    operations.ask = (context) => {
      calls.push(
        `ask ${context.from === green ? "green" : "?"}->${
          context.to === blue ? "blue" : "?"
        }`,
      );
      return Promise.resolve(answer ?? null);
    };
  }
  if (policy !== undefined || events) {
    operations.who = () => "mark";
    operations.record = (event) => {
      calls.push(`record ${event.kind}`);
      return recordResult instanceof Error
        ? Promise.reject(recordResult)
        : Promise.resolve(recordResult ?? { kept: true, inBakery: true });
    };
  }
  if (gate) {
    operations.gate = (activeSha, sha) => {
      calls.push(
        `gate ${activeSha === blue ? "blue" : "?"}->${
          sha === green ? "green" : "?"
        }`,
      );
      return Promise.resolve(gate);
    };
  }
  if (marker) {
    operations.marker = (on) => {
      calls.push(on ? "marker on" : "marker off");
      return Promise.resolve();
    };
  }
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

test("a resume that fails right after the commit keeps the record, and recover resumes it", async () => {
  const h = harness(committed, { pause: null, resumeFails: 1 });
  const events = [];
  const result = await run(h, (event) => events.push(event));
  assert.equal(result.phase, "committed");
  assert.equal(
    h.state().paused,
    green,
    "the commit keeps the marker, or recover has nothing to act on",
  );
  assert.deepEqual(events.filter((event) => "resumed" in event), [{
    resumed: null,
  }]);

  const after = await recover(h.store, h.operations);
  assert.deepEqual(h.calls, [
    "pause green",
    "backup",
    "resume green",
    "resume green",
  ]);
  assert.equal("paused" in after, false);
  assert.equal(
    "paused" in h.state(),
    false,
    "cleared once work really resumed",
  );
});

test("a rollback whose resume fails keeps the record, and recover resumes it", async () => {
  const h = harness(committed, { fail: true, pause: null, resumeFails: 1 });
  await assert.rejects(run(h, () => {}), /SMOKE_RELEASE_NOT_READY/);
  assert.equal(h.state().phase, "committed");
  assert.equal(h.state().active.sha, blue);
  assert.equal(h.state().paused, green);

  await recover(h.store, h.operations);
  assert.deepEqual(h.calls, [
    "pause green",
    "backup",
    "resume green",
    "resume green",
  ]);
  assert.equal("paused" in h.state(), false);
});

test("recover on an untouched journal never calls the database", async () => {
  const h = harness(committed, { pause: null });
  await recover(h.store, h.operations);
  assert.deepEqual(h.calls, []);
});

const ask = { policy: "ask", pause: null };

test("policy go_back undoes an unhealthy update by itself and never asks", async () => {
  const h = harness(committed, { fail: true, policy: "go_back", pause: null });
  await assert.rejects(run(h, () => {}), /SMOKE_RELEASE_NOT_READY/);
  assert.equal(h.state().phase, "committed");
  assert.equal(h.state().active.sha, blue);
  assert.ok(!h.calls.some((c) => c.startsWith("ask")));
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith("record")),
    ["record went_back"],
    "Bakery went back by itself: one event, no decision",
  );
});

test("policy ask: a yes goes back, resumes work and records who answered", async () => {
  const h = harness(committed, { ...ask, fail: true, answer: "go_back" });
  const events = [];
  await assert.rejects(
    run(h, (e) => events.push(e)),
    /SMOKE_RELEASE_NOT_READY/,
  );
  assert.equal(h.state().phase, "committed");
  assert.equal(h.state().active.sha, blue);
  assert.deepEqual(h.calls, [
    "pause green",
    "backup",
    "policy green",
    "ask green->blue",
    "resume green",
    "record decided_go_back",
  ]);
  const { recorded } = events.find((e) => "recorded" in e);
  assert.equal(recorded.kind, "decided_go_back");
  assert.equal(recorded.by, "mark");
  assert.equal(recorded.fromRelease, green);
  assert.equal(recorded.toRelease, blue);
  assert.equal(recorded.inBakery, true);
});

test("policy ask: a no leaves the release in place, work paused, and records the answer", async () => {
  const h = harness(committed, { ...ask, fail: true, answer: "stay" });
  const events = [];
  await assert.rejects(run(h, (e) => events.push(e)), /UPDATE_LEFT_UNHEALTHY/);
  assert.notEqual(h.state().phase, "committed", "recover can still go back");
  assert.ok(!h.calls.includes("resume green"), "work is not resumed on it");
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith("record")),
    ["record updated", "record decided_stay"],
    "the move is recorded first, so the history knows what was replaced",
  );
  const [moved, decided] = events.filter((e) => "recorded" in e).map((e) =>
    e.recorded
  );
  assert.equal(moved.kind, "updated");
  assert.equal(moved.fromRelease, blue);
  assert.equal(moved.toRelease, green);
  assert.equal(decided.kind, "decided_stay");
  assert.equal(decided.by, "mark");
});

test("policy ask with nobody to ask leaves it running, records the move and a stay with no one named", async () => {
  const h = harness(committed, { ...ask, fail: true, answer: null });
  const events = [];
  await assert.rejects(
    run(h, (e) => events.push(e)),
    /UPDATE_LEFT_UNHEALTHY/,
  );
  assert.notEqual(h.state().phase, "committed");
  assert.ok(!h.calls.includes("resume green"));
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith("record")),
    ["record updated", "record decided_stay"],
  );
  const recorded = events.filter((e) => "recorded" in e).map((e) => e.recorded);
  assert.equal(recorded[0].by, "mark", "the move is the operator's update");
  assert.equal(recorded[1].by, null, "no one answered");
  assert.deepEqual(
    decisionLines(recorded[1]),
    [],
    "there is no answer to report at the terminal",
  );
});

test("an unreadable policy goes back, because the database may be what is down", async () => {
  const h = harness(committed, {
    fail: true,
    policy: new Error("DEPLOY_UPDATE_FAILED:1"),
    answer: "stay",
    pause: null,
  });
  await assert.rejects(run(h, () => {}), /SMOKE_RELEASE_NOT_READY/);
  assert.equal(h.state().phase, "committed");
  assert.ok(!h.calls.some((c) => c.startsWith("ask")));
});

test("policy ask does not ask when the failure came before the switch", async () => {
  const h = harness(committed, { ...ask, failGreen: true, answer: "stay" });
  await assert.rejects(run(h, () => {}), /SMOKE_RELEASE_NOT_READY/);
  assert.equal(h.state().phase, "committed");
  assert.ok(!h.calls.some((c) => c.startsWith("ask")));
});

test("a rollback is never asked about, even under policy ask", async () => {
  const h = harness({
    ...committed,
    active: { sha: green, slot: "green" },
    previous: { sha: blue, slot: "blue" },
    migrations: { [migration]: hash, [addition]: hash },
  }, { ...ask, answer: "stay" });
  await run(h, () => {}, blue, true);
  assert.ok(!h.calls.some((c) => c.startsWith("ask")));
});

test("an answer that could be recorded nowhere is reported as such, and going back still happened", async () => {
  const h = harness(committed, {
    ...ask,
    fail: true,
    answer: "go_back",
    recordResult: new Error("DISK_FULL"),
  });
  const events = [];
  await assert.rejects(
    run(h, (e) => events.push(e)),
    /SMOKE_RELEASE_NOT_READY/,
  );
  assert.equal(h.state().active.sha, blue);
  const { recorded } = events.find((e) => "recorded" in e);
  assert.equal(recorded.kept, false);
  assert.match(decisionLines(recorded).join(" "), /could not be recorded/);
});

test("the question and the recorded answer are plain words, within 80 columns", () => {
  const asked = askLines({ from: green, to: blue });
  assert.match(asked[0], /^Bakery is not healthy on bbbbbbbb\.$/);
  assert.ok(asked.some((l) => l.startsWith("Update policy    ask before")));
  const goBack = {
    kind: "decided_go_back",
    by: "mark",
    at: "2026-11-21T14:11:09.000Z",
    fromRelease: green,
    toRelease: blue,
    kept: true,
    inBakery: true,
  };
  assert.deepEqual(decisionLines(goBack), [
    "Decision recorded: gone back by mark at 14:11 UTC, from the server.",
  ]);
  const stay = decisionLines({
    ...goBack,
    kind: "decided_stay",
    inBakery: false,
  });
  assert.match(stay[0], /kept bbbbbbbb by mark at 14:11 UTC, from the server/);
  assert.equal(stay[1], "To go back: bakery-release recover");
  assert.match(stay.join(" "), /Bakery's history does not have it yet/);
  assert.deepEqual(decisionLines(undefined), []);
  assert.ok(wide(asked) && wide(stay));
  const kept = failureLines(new Error("UPDATE_LEFT_UNHEALTHY"), {
    requested: green,
    active: blue,
    phase: "switching",
  });
  assert.match(kept[0], /not healthy on bbbbbbbb and was left as it is/);
  assert.equal(kept.at(-1), "[UPDATE_LEFT_UNHEALTHY]");
  assert.ok(wide(kept));
});

function terminal(answer, isTTY = true) {
  const input = new PassThrough();
  input.isTTY = isTTY;
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => text += chunk);
  if (answer !== undefined) setTimeout(() => input.write(`${answer}\n`), 5);
  return { input, output, text: () => text };
}

test("the prompt goes back only on an explicit yes; Enter and anything else keep it", async () => {
  const context = { from: green, to: blue };
  for (
    const [typed, expected] of [
      ["y", "go_back"],
      ["YES", "go_back"],
      ["", "stay"],
      ["n", "stay"],
      ["maybe", "stay"],
    ]
  ) {
    const t = terminal(typed);
    assert.equal(await askAtTerminal(context, t), expected, typed);
    assert.match(t.text(), /Bakery is not healthy on bbbbbbbb\./);
    assert.match(
      t.text(),
      /Go back to aaaaaaaa now\? Work resumes afterwards\. \[y\/N\]/,
    );
  }
});

test("with no terminal nobody is asked, and only --yes answers for a script", async () => {
  const context = { from: green, to: blue };
  assert.equal(await askAtTerminal(context, terminal(undefined, false)), null);
  assert.equal(
    await askAtTerminal(context, { ...terminal(undefined, false), yes: true }),
    "go_back",
  );
});

test("every kept event is sent, the ones Bakery took are dropped, and the rest stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-"));
  const path = join(dir, "history.jsonl");
  const rows = Array.from({ length: 30 }, (_, n) => ({ id: `id-${n + 1}` }));
  await writeFile(
    path,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n",
  );
  const seen = [];
  const result = await resendEvents((row) => {
    seen.push(row.id);
    if (row.id === "id-3" || row.id === "id-28") throw new Error("DB_DOWN");
    return Promise.resolve(true);
  }, path);
  assert.equal(seen.length, 30, "more than a window's worth are all tried");
  assert.deepEqual(result, { sent: 28, unsent: 2 });
  assert.deepEqual(
    await keptIds(path),
    ["id-3", "id-28"],
    "unparseable lines are dropped",
  );
  // The next run sends only what is left, and an empty file is fine.
  assert.deepEqual(await resendEvents(() => Promise.resolve(true), path), {
    sent: 2,
    unsent: 0,
  });
  assert.deepEqual(await keptIds(path), []);
  assert.deepEqual(
    await resendEvents(() => Promise.resolve(true), join(dir, "none")),
    { sent: 0, unsent: 0 },
  );
});

async function keptIds(path) {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) =>
    JSON.parse(l).id
  );
}

test("the host file keeps only events Bakery has not taken, and never grows past its cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-kept-"));
  const path = join(dir, "history.jsonl");
  await keepEvent({ id: "a" }, path);
  await keepEvent({ id: "b" }, path);
  assert.deepEqual(await keptIds(path), ["a", "b"]);
  await forgetEvent("a", path);
  assert.deepEqual(await keptIds(path), ["b"]);
  await forgetEvent("missing", path);
  assert.deepEqual(await keptIds(path), ["b"]);
  for (let n = 0; n < MAX_KEPT_EVENTS + 5; n++) {
    await keepEvent({ id: `e${n}` }, path);
  }
  const ids = await keptIds(path);
  assert.equal(ids.length, MAX_KEPT_EVENTS);
  assert.equal(ids.at(-1), `e${MAX_KEPT_EVENTS + 4}`, "the newest are kept");
});

test("an update marks itself for the proxy, records what happened and clears the mark", async () => {
  const h = harness(committed, { pause: null, events: true, marker: true });
  const events = [];
  await run(h, (e) => events.push(e));
  assert.deepEqual(h.calls, [
    "pause green",
    "marker on",
    "backup",
    "resume green",
    "record updated",
    "marker off",
  ]);
  const { recorded } = events.find((e) => "recorded" in e);
  assert.equal(recorded.kind, "updated");
  assert.equal(recorded.fromRelease, blue);
  assert.equal(recorded.toRelease, green);
  assert.equal(recorded.by, "mark");
  assert.match(recorded.id, /^[0-9a-f-]{36}$/);
});

test("the mark is cleared when the update fails too, and Bakery's own going back names no one", async () => {
  const h = harness(committed, {
    fail: true,
    pause: null,
    events: true,
    marker: true,
  });
  const events = [];
  await assert.rejects(
    run(h, (e) => events.push(e)),
    /SMOKE_RELEASE_NOT_READY/,
  );
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith("marker") || c.startsWith("record")),
    ["marker on", "record went_back", "marker off"],
  );
  const { recorded } = events.find((e) => "recorded" in e);
  assert.equal(recorded.by, null);
  assert.equal(
    recorded.fromRelease,
    green,
    "the update that did not become ready",
  );
  assert.equal(recorded.toRelease, blue, "the version Bakery returned to");
});

test("a refused pause leaves no mark and no event: nothing started", async () => {
  const h = harness(committed, {
    pause: new Error("INSTALLATION_RESTORING"),
    events: true,
    marker: true,
  });
  await assert.rejects(run(h, () => {}), /INSTALLATION_RESTORING/);
  assert.ok(
    !h.calls.some((c) => c.startsWith("marker") || c.startsWith("record")),
  );
});

test("a first install and a rollback are recorded, and neither marks the proxy", async () => {
  const first = harness({
    format: 1,
    phase: "committed",
    active: null,
    previous: null,
    migrations: {},
  }, { pause: null, events: true, marker: true });
  await run(first, () => {}, blue, false, true);
  assert.deepEqual(
    first.calls.filter((c) => c.startsWith("marker") || c.startsWith("record")),
    ["record installed"],
  );
  const back = harness({
    ...committed,
    active: { sha: green, slot: "green" },
    previous: { sha: blue, slot: "blue" },
    migrations: { [migration]: hash, [addition]: hash },
  }, { pause: null, events: true, marker: true });
  await run(back, () => {}, blue, true);
  assert.deepEqual(
    back.calls.filter((c) => c.startsWith("marker") || c.startsWith("record")),
    ["record rolled_back"],
  );
});

test("a marker or a history that cannot be written never stops an update", async () => {
  const h = harness(committed, { pause: null, events: true, marker: true });
  h.operations.marker = () => Promise.reject(new Error("READ_ONLY"));
  h.operations.record = () => Promise.reject(new Error("DISK_FULL"));
  const state = await run(h, () => {});
  assert.equal(state.active.sha, green);
});

test("only a refused update is a refusal: a wrong user or command is not an update", () => {
  assert.equal(isRefusal("MIGRATION_COMPATIBILITY_REVIEW_REQUIRED"), true);
  assert.equal(isRefusal("INSTALLATION_RESTORING"), true);
  assert.equal(isRefusal("ROOT_REQUIRED"), false);
  assert.equal(isRefusal("EXPECTED_DEPLOY_ROLLBACK_RECOVER_RENDER"), false);
  assert.equal(isRefusal("SMOKE_RELEASE_NOT_READY"), false);
});

test("an unhealthy release found after the switch, inside finish, is asked about once and recorded once", async () => {
  for (
    const [answer, kind] of [["go_back", "decided_go_back"], [
      "stay",
      "decided_stay",
    ]]
  ) {
    const h = harness(committed, { ...ask, failBackground: true, answer });
    const events = [];
    await assert.rejects(
      run(h, (e) => events.push(e)),
      answer === "go_back" ? /BACKGROUND_NOT_HEALTHY/ : /UPDATE_LEFT_UNHEALTHY/,
    );
    assert.equal(
      h.calls.filter((c) => c.startsWith("ask")).length,
      1,
      `${answer}: the person is asked once`,
    );
    assert.deepEqual(
      h.calls.filter((c) => c.startsWith("record")),
      answer === "go_back"
        ? [`record ${kind}`]
        : ["record updated", `record ${kind}`],
      `${answer}: one decision is recorded, and a kept release is a move`,
    );
    assert.equal(
      events.filter((e) => "recorded" in e).length,
      answer === "go_back" ? 1 : 2,
    );
  }
});

test("a release that fails its background check under policy go_back goes back once and is recorded once", async () => {
  const h = harness(committed, {
    failBackground: true,
    policy: "go_back",
    pause: null,
  });
  await assert.rejects(run(h, () => {}), /BACKGROUND_NOT_HEALTHY/);
  assert.equal(h.state().phase, "committed");
  assert.equal(h.state().active.sha, blue);
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith("record")),
    ["record went_back"],
  );
  assert.equal(h.calls.filter((c) => c === "resume green").length, 1);
});

test("recover after a stay records one interrupted switch, and running recover again records nothing", async () => {
  for (const answer of ["stay", null]) {
    const h = harness(committed, { ...ask, fail: true, answer });
    await assert.rejects(run(h, () => {}), /UPDATE_LEFT_UNHEALTHY/);
    const before = h.state();
    assert.notEqual(before.phase, "committed");
    await recover(h.store, h.operations);
    const first = interruptedMove(before, h.state());
    assert.deepEqual(first, {
      kind: "interrupted",
      from: green,
      to: blue,
      via: blue,
    }, String(answer));
    // The host is back on the old release: a second recover has nothing to say.
    const again = h.state();
    assert.equal(again.phase, "committed");
    await recover(h.store, h.operations);
    assert.equal(interruptedMove(again, h.state()), null);
  }
  assert.equal(interruptedMove(null, null), null);
  assert.equal(
    interruptedMove({ phase: "enrollment", desired: { sha: green } }, {
      active: { sha: blue },
    }),
    null,
  );
});

const held = {
  changes: [{ path: "scripts/deploy/release.mjs", kind: "changed" }],
  fingerprint: "f",
  approved: false,
};

test("an update that changes the trusted gate is refused before anything starts, until it is approved", async () => {
  const h = harness(committed, { pause: null, gate: held });
  const lines = [];
  await assert.rejects(
    run(h, (e) => lines.push(e)),
    (error) =>
      error.message === "TRUSTED_GATE_CHANGE" &&
      error.gate.changes.length === 1,
  );
  assert.deepEqual(
    h.calls,
    ["gate blue->green"],
    "no pause, no snapshot, nothing",
  );
  assert.deepEqual(lines, [], "not even the first step is reported as done");
  assert.deepEqual(h.state(), committed, "the journal was never touched");
});

test("an approved change, or no change, goes ahead", async () => {
  for (
    const gate of [{ ...held, approved: true }, { changes: [], approved: true }]
  ) {
    const h = harness(committed, { pause: null, gate });
    const state = await run(h, () => {});
    assert.equal(state.active.sha, green);
    assert.ok(h.calls.includes("backup"));
  }
});

test("bootstrap onto a running host is refused before the gate is asked, so it cannot be a way around it", async () => {
  const h = harness(committed, { pause: null, gate: held });
  await assert.rejects(
    run(h, () => {}, green, false, true),
    /BOOTSTRAP_ALREADY_INITIALIZED/,
  );
  assert.deepEqual(h.calls, [], "nothing was asked or started");
  assert.deepEqual(h.state(), committed, "the journal was never touched");
});

test("a rollback and a first install are never held by the gate", async () => {
  const back = harness({
    ...committed,
    active: { sha: green, slot: "green" },
    previous: { sha: blue, slot: "blue" },
    migrations: { [migration]: hash, [addition]: hash },
  }, { pause: null, gate: held });
  await run(back, () => {}, blue, true);
  assert.ok(!back.calls.some((c) => c.startsWith("gate")));
  const first = harness({
    format: 1,
    phase: "committed",
    active: null,
    previous: null,
    migrations: {},
  }, { pause: null, gate: held });
  await run(first, () => {}, blue, false, true);
  assert.ok(!first.calls.some((c) => c.startsWith("gate")));
});

test("the refusal names the files, the command that approves it, and ends with its code", () => {
  const lines = failureLines(
    Object.assign(new Error("TRUSTED_GATE_CHANGE"), { gate: held }),
    { requested: green, active: blue, phase: "committed", gate: held },
  );
  assert.match(lines[0], /changes the checks that decide what may be merged/);
  assert.match(lines.join("\n"), /changed\s+scripts\/deploy\/release\.mjs/);
  assert.match(
    lines.join("\n"),
    new RegExp(`sudo bakery-release approve-gate ${green}`),
  );
  assert.equal(lines.at(-1), "[TRUSTED_GATE_CHANGE]");
  assert.ok(wide(lines.filter((l) => !l.includes(green))));
  assert.equal(
    isRefusal("TRUSTED_GATE_CHANGE"),
    true,
    "recorded as a refusal in the history",
  );
});

test("long lists of changed files are cut to a few and a count", () => {
  const many = Array.from(
    { length: 9 },
    (_, n) => ({ path: `scripts/deploy/f${n}`, kind: "added" }),
  );
  const lines = gateChangeLines(many);
  assert.equal(lines.length, 7);
  assert.equal(lines.at(-1), "  and 3 more");
  assert.match(
    gateReviewLines({ active: blue, sha: green, changes: many }).join("\n"),
    /changes 9 files/,
  );
  assert.match(
    gateReviewLines({ active: blue, sha: green, changes: many.slice(0, 1) })[0],
    /changes 1 file of/,
  );
});
