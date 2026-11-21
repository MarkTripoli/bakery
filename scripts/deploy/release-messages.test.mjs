import assert from "node:assert/strict";
import test from "node:test";
import {
  completionLines,
  failedStepLine,
  failureLines,
  statusLines,
  STEP_LABELS,
  stepLine,
} from "./release-messages.mjs";
import { transition } from "./release.mjs";

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
  assert.equal(failedStepLine(1, 5, "NO_ROLLBACK_BASELINE"), null);
  assert.equal(
    failedStepLine(2, 5, "MIGRATION_COMPATIBILITY_REVIEW_REQUIRED"),
    "2/5 Checking database changes  failed",
  );
  assert.equal(failedStepLine(6, 5, "X"), null);
});

test("status prints the same labelled lines whether idle, waiting or interrupted", () => {
  const committed = {
    phase: "committed",
    active: { sha: blue, slot: "blue" },
    previous: { sha: green, slot: "green" },
  };
  assert.deepEqual(statusLines(committed), [
    `Running          ${blue} (blue)`,
    `Can go back to   ${green}`,
    "State            Ready.",
  ]);
  assert.match(
    statusLines({ ...committed, previous: null })[1],
    /No earlier version is kept\./,
  );
  assert.match(statusLines(null)[0], /nothing is installed yet/);
  const interrupted = statusLines({
    ...committed,
    phase: "switching",
    desired: { sha: green, slot: "green" },
  });
  assert.match(interrupted[0], /not certain/);
  assert.equal(interrupted.at(-1), "Run: bakery-release recover");
  assert.ok(wide(statusLines(committed)));
});

test("completion lines name the kept version and the exact rollback command", () => {
  const state = { active: { sha: green }, previous: { sha: blue } };
  assert.deepEqual(
    completionLines("deploy", state, { active: { sha: blue } }),
    [
      "Updated. Bakery is running bbbbbbbb.",
      "aaaaaaaa is kept so you can go back:",
      `  bakery-release rollback ${green}`,
    ],
  );
  assert.deepEqual(
    completionLines("deploy", state, { active: { sha: green } }),
    [
      "Bakery is already running bbbbbbbb. Nothing was changed.",
    ],
  );
  assert.deepEqual(
    completionLines("rollback", { active: { sha: blue } }, state),
    [
      "Went back. Bakery is running aaaaaaaa.",
      "The database was not changed.",
    ],
  );
});

function harness(initial, { fail } = {}) {
  let state = structuredClone(initial);
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
    backup: noop,
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
  };
  return { store, operations, state: () => state };
}

const committed = {
  format: 1,
  phase: "committed",
  active: { sha: blue, slot: "blue" },
  previous: null,
  migrations: { [migration]: hash },
};

test("transition reports its five steps in order, with the migration count", async () => {
  const { store, operations } = harness(committed);
  const lines = [];
  await transition(
    store,
    operations,
    green,
    hash,
    false,
    false,
    (s) => lines.push(stepLine(s)),
  );
  assert.deepEqual(lines, [
    "1/5 Checking the release       ok",
    "2/5 Checking database changes  1 to apply",
    "3/5 Saving a snapshot          ok",
    "4/5 Switching                  ok",
    "5/5 Checking health            ok",
  ]);
  assert.equal(STEP_LABELS.length, 5);
});

test("a failed health check leaves the earlier steps reported and the old version active", async () => {
  const { store, operations, state } = harness(committed, { fail: true });
  const lines = [];
  await assert.rejects(
    transition(
      store,
      operations,
      green,
      hash,
      false,
      false,
      (s) => lines.push(stepLine(s)),
    ),
    /SMOKE_RELEASE_NOT_READY/,
  );
  assert.equal(lines.length, 3);
  assert.equal(state().phase, "committed");
  assert.equal(state().active.sha, blue);
});
