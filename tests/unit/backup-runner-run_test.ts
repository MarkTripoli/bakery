import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ApiFatal,
  ApiUnavailable,
  LeaseLost,
  type Maintenance,
  type ReportBody,
  ReportUndelivered,
  type RunnerApi,
  type RunnerSettings,
} from "../../scripts/deploy/backup-runner/api.ts";
import {
  type Artifact,
  StepError,
} from "../../scripts/deploy/backup-runner/backup-step.ts";
import {
  cutoffFromView,
  type CutoffView,
} from "../../scripts/deploy/backup-runner/cutoff.ts";
import type { Cutoff } from "../../apps/server/src/modules/backups/cutoff-rules.ts";
import {
  type Offsite,
  OffsiteError,
} from "../../scripts/deploy/backup-runner/offsite.ts";
import { createSecrets } from "../../scripts/deploy/backup-runner/redact.ts";
import { assertReportShape } from "../../apps/server/src/modules/backups/state.ts";
import { EXIT, exitCodeOf } from "../../scripts/deploy/backup-runner.ts";
import {
  HEARTBEAT_MS,
  type RunnerDeps,
  runOnce,
} from "../../scripts/deploy/backup-runner/run.ts";

const RUN = "11111111-1111-4111-8111-111111111111";
const LEASE = "lease-token-0123456789abcdef0123456789abcd";
const KEY_ID = "AKIAEXAMPLEKEY123456";
const KEY_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const artifact: Artifact = {
  name: "20261120T030000Z-00000000-0000-4000-8000-000000000001",
  directory: "/var/lib/bakery/backups/x",
  files: [
    { name: "bakery.dump.age", path: "/x/bakery.dump.age", size: 1000 },
    { name: "SHA256SUMS", path: "/x/SHA256SUMS", size: 234 },
  ],
  totalBytes: 1234,
};

const plain: RunnerSettings = {
  scheduleEnabled: false,
  daysToKeep: 30,
  offsiteConfigured: false,
  offsiteEndpoint: null,
  offsiteRegion: null,
  offsiteBucket: null,
  offsitePrefix: null,
  offsiteAccessKeyId: null,
  offsiteSecretAccessKey: null,
  offsiteRefusal: null,
};
const withOffsite: RunnerSettings = {
  ...plain,
  offsiteConfigured: true,
  offsiteEndpoint: "https://s3.example.com",
  offsiteRegion: "eu-1",
  offsiteBucket: "bakery-backups",
  offsitePrefix: "prod/",
  offsiteAccessKeyId: KEY_ID,
  offsiteSecretAccessKey: KEY_SECRET,
};
const fakeOffsite = { destination: {}, credentials: {} } as unknown as Offsite;

async function until(condition: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

/** What the server answers to the cutoff request: one unsettled effect of each kind. */
const cutoffView: CutoffView = {
  runId: RUN,
  cutoffAt: "2026-11-20T12:00:03.250Z",
  effectsTotal: 3,
  effectsPrepared: 1,
  effectsSubmitted: 1,
  effectsUncertain: 1,
  effectsByOperation: [
    { operation: "github.pull_request.merge", count: 2 },
    { operation: "slack.message.post", count: 1 },
  ],
  effectsDigest: "a".repeat(64),
};

type Options = {
  /** What the cutoff request answers; an Error is thrown instead. */
  cutoff?: CutoffView | Error;
  claimed?: boolean;
  settings?: RunnerSettings;
  settingsError?: Error;
  /** Called for every report; may throw to simulate the server. */
  onReport?: (sequence: number, body: ReportBody) => void | Promise<void>;
  backup?: (signal: AbortSignal, cutoff: Cutoff) => Promise<Artifact>;
  offsite?: (settings: RunnerSettings) => Offsite | null;
  upload?: RunnerDeps["upload"];
  prune?: RunnerDeps["prune"];
  /** Answers each drain check in turn; the last answer repeats. Default: quiet at once. */
  maintain?: readonly Maintenance[] | (() => Promise<Maintenance>);
  drainTimeoutMs?: number;
};

const quiet: Maintenance = {
  state: "quiesced",
  runId: "00000000-0000-4000-8000-000000000001",
  leaseExpiresAt: "2026-11-20T12:05:00.000Z",
  liveAttempts: 0,
  openTransactions: 0,
  retryAfterSeconds: 0,
};
const draining = (over: Partial<Maintenance> = {}): Maintenance => ({
  ...quiet,
  state: "draining",
  liveAttempts: 2,
  retryAfterSeconds: 2,
  ...over,
});

function harness(options: Options = {}) {
  const events: string[] = [];
  const reports: { sequence: number; body: ReportBody }[] = [];
  const logs: string[] = [];
  const sleepers: { ms: number; wake: () => void }[] = [];
  const pruned: (Offsite | null)[] = [];
  const cutoffs: Cutoff[] = [];
  let cutoffAsks = 0;
  let maintainCalls = 0;
  let clock = 0;
  const api: RunnerApi = {
    claim: () => {
      events.push("claim");
      return Promise.resolve(
        options.claimed === false ? { claimed: false } : {
          claimed: true,
          runId: RUN,
          leaseToken: LEASE,
          leaseExpiresAt: "2026-11-20T12:05:00.000Z",
        },
      );
    },
    maintain: (runId, leaseToken) => {
      assertEquals(runId, RUN);
      assertEquals(leaseToken, LEASE);
      events.push("maintain");
      maintainCalls += 1;
      const script = options.maintain;
      if (typeof script === "function") return script();
      const answers = script ?? [quiet];
      return Promise.resolve(
        answers[Math.min(maintainCalls - 1, answers.length - 1)],
      );
    },
    cutoff: (runId, leaseToken) => {
      assertEquals(runId, RUN);
      assertEquals(leaseToken, LEASE);
      events.push("cutoff");
      cutoffAsks += 1;
      return options.cutoff instanceof Error
        ? Promise.reject(options.cutoff)
        : Promise.resolve(options.cutoff ?? cutoffView);
    },
    settings: () => {
      events.push("settings");
      return options.settingsError
        ? Promise.reject(options.settingsError)
        : Promise.resolve(options.settings ?? plain);
    },
    report: async (runId, leaseToken, sequence, body) => {
      assertEquals(runId, RUN);
      assertEquals(leaseToken, LEASE);
      events.push(`report:${body.status}`);
      // The server's own shape rules judge every report the runner sends.
      assertReportShape({ sequence, ...body });
      reports.push({ sequence, body });
      await options.onReport?.(sequence, body);
    },
  };
  const deps: RunnerDeps = {
    api,
    secrets: createSecrets([LEASE]),
    backup: (signal, cutoff) => {
      events.push("backup");
      cutoffs.push(cutoff);
      return options.backup
        ? options.backup(signal, cutoff)
        : Promise.resolve(artifact);
    },
    offsite: (settings) => {
      events.push("offsite");
      return options.offsite
        ? options.offsite(settings)
        : settings.offsiteConfigured
        ? fakeOffsite
        : null;
    },
    upload: (offsite, art, signal, onFile) => {
      events.push("upload");
      return options.upload
        ? options.upload(offsite, art, signal, onFile)
        : Promise.resolve();
    },
    prune: (settings, offsite, art) => {
      events.push("prune");
      pruned.push(offsite);
      return options.prune
        ? options.prune(settings, offsite, art)
        : Promise.resolve();
    },
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        sleepers.push({ ms, wake: resolve });
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    log: (line) => logs.push(line),
    now: () => clock,
    ...(options.drainTimeoutMs === undefined
      ? {}
      : { drainTimeoutMs: options.drainTimeoutMs }),
  };
  return {
    deps,
    events,
    reports,
    logs,
    sleepers,
    pruned,
    /** Moves the test clock forward, as the injected sleep would. */
    advance: (ms: number) => {
      clock += ms;
    },
    maintainCalls: () => maintainCalls,
    /** The cutoffs the backup step was given, in order. */
    cutoffs,
    cutoffAsks: () => cutoffAsks,
  };
}

Deno.test("nothing claimed: no settings read, no report, no work", async () => {
  const h = harness({ claimed: false });
  assertEquals(await runOnce(h.deps), { kind: "idle" });
  assertEquals(h.events, ["claim"]);
  assertEquals(h.reports, []);
});

Deno.test("claim comes first and settings are read only after it, the backup before the destination is judged", async () => {
  const h = harness();
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, {
    kind: "completed",
    runId: RUN,
    locations: ["server-host"],
  });
  assertEquals(h.events, [
    "claim",
    "report:running", // 0%: marks the run started
    "maintain", // the installation is held, and already quiet
    "settings",
    "report:running", // 5%
    "cutoff", // after the quiet moment, before the dumps
    "backup",
    "offsite",
    "report:running", // 90%: no off-site copy to make
    "report:completed",
    "prune",
  ]);
  assertEquals(h.reports.map((r) => r.sequence), [1, 2, 3, 4]);
  assertEquals(h.reports.at(-1)!.body, {
    status: "completed",
    sizeBytes: "1234",
    locations: ["server-host"],
  });
});

Deno.test("an off-site copy uploads, reports rising progress and completes with both locations", async () => {
  const h = harness({
    settings: withOffsite,
    upload: (_o, _a, _s, onFile) => {
      onFile(1, 2);
      onFile(2, 2);
      return Promise.resolve();
    },
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, {
    kind: "completed",
    runId: RUN,
    locations: ["server-host", "off-site"],
  });
  const progress = h.reports.flatMap((r) =>
    r.body.progressPercent === undefined ? [] : [r.body.progressPercent]
  );
  assertEquals(progress, [...progress].sort((a, b) => a - b)); // never down
  assertEquals(progress.at(-1), 95);
  assertEquals(h.reports.at(-1)!.body, {
    status: "completed",
    sizeBytes: "1234",
    locations: ["server-host", "off-site"],
  });
  // Sequence numbers rise by exactly one, from 1.
  h.reports.forEach((r, i) => assertEquals(r.sequence, i + 1));
});

Deno.test("while a long step runs a heartbeat report goes out every 120 seconds, in sequence", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = harness({ backup: async () => (await gate, artifact) });
  const pending = runOnce(h.deps);
  await until(() => h.sleepers.length === 1);
  assertEquals(h.sleepers[0].ms, HEARTBEAT_MS);
  assertEquals(HEARTBEAT_MS, 120_000);
  const before = h.reports.length;
  h.sleepers[0].wake();
  await until(() => h.reports.length === before + 1);
  assertEquals(h.reports.at(-1)!.body.status, "running");
  await until(() => h.sleepers.length === 2);
  assertEquals(h.sleepers[1].ms, HEARTBEAT_MS);
  h.sleepers[1].wake();
  await until(() => h.reports.length === before + 2);
  release();
  const outcome = await pending;
  assertEquals(outcome.kind, "completed");
  h.reports.forEach((r, i) => assertEquals(r.sequence, i + 1));
  // The heartbeat repeats the current progress; it never lowers it.
  const progress = h.reports.flatMap((r) =>
    r.body.progressPercent === undefined ? [] : [r.body.progressPercent]
  );
  assertEquals(progress, [...progress].sort((a, b) => a - b));
});

Deno.test("a failed backup step reports its failure code with a redacted detail and uploads nothing", async () => {
  const h = harness({
    settings: withOffsite,
    backup: () =>
      Promise.reject(
        new StepError("disk_full", `No space left on device ${LEASE}`),
      ),
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, { kind: "failed", runId: RUN, code: "disk_full" });
  assert(!h.events.includes("upload"));
  assert(!h.events.includes("prune"));
  const last = h.reports.at(-1)!.body;
  assertEquals(last.status, "failed");
  assertEquals(last.failureCode, "disk_full");
  assert(!JSON.stringify(last).includes(LEASE));
  assertStringIncludes(last.failureDetail!, "No space left on device");
});

Deno.test("an incomplete backup set fails the run as incomplete_set, uploads nothing and is never completed", async () => {
  const h = harness({
    settings: withOffsite,
    backup: () =>
      Promise.reject(
        new StepError(
          "incomplete_set",
          `The backup set is not complete: redis: store_not_captured (the capture failed) ${LEASE}`,
        ),
      ),
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, {
    kind: "failed",
    runId: RUN,
    code: "incomplete_set",
  });
  // A set missing a declared store is not copied off-site or kept as a backup.
  assert(!h.events.includes("upload"));
  assert(!h.events.includes("prune"));
  assert(!h.reports.some((r) => r.body.status === "completed"));
  const last = h.reports.at(-1)!.body;
  assertEquals(last.status, "failed");
  assertEquals(last.failureCode, "incomplete_set");
  // The detail names the missing store and carries no secret.
  assertStringIncludes(last.failureDetail!, "redis");
  assert(!JSON.stringify(last).includes(LEASE));
});

Deno.test("an incomplete set kept for a missing manifest builder is reported failed with that cause and is not uploaded", async () => {
  const h = harness({
    settings: withOffsite,
    backup: () =>
      Promise.reject(
        new StepError(
          "incomplete_set",
          "BACKUP_INCOMPLETE manifest_builder_missing: deno is not installed (set kept; it is not the latest backup)",
        ),
      ),
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, {
    kind: "failed",
    runId: RUN,
    code: "incomplete_set",
  });
  // The incomplete set is not copied off-site and nothing reports completed.
  assert(!h.events.includes("upload"));
  assert(!h.reports.some((r) => r.body.status === "completed"));
  const last = h.reports.at(-1)!.body;
  assertEquals(last.failureCode, "incomplete_set");
  assertStringIncludes(last.failureDetail!, "manifest_builder_missing");
});

Deno.test("a refused destination completes the run on the host as 'not copied off-site', after the backup was taken", async () => {
  const h = harness({
    settings: withOffsite,
    offsite: () => {
      throw new OffsiteError(
        "destination_refused",
        "destination_private_address",
      );
    },
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, {
    kind: "not-copied",
    runId: RUN,
    code: "destination_refused",
  });
  assertEquals(
    h.events.indexOf("backup") < h.events.indexOf("offsite"),
    true,
  );
  assert(!h.events.includes("upload"));
  // Completed, not failed: the backup is on the host, with the cause attached.
  assertEquals(h.reports.some((r) => r.body.status === "failed"), false);
  assertEquals(h.reports.at(-1)!.body, {
    status: "completed",
    sizeBytes: "1234",
    locations: ["server-host"],
    failureCode: "destination_refused",
    failureDetail: "destination_private_address",
  });
  // The pass says so plainly and exits 1.
  assertEquals(h.logs.some((l) => l.includes("NOT copied off-site")), true);
  assertEquals(exitCodeOf(outcome), 1);
  assertEquals(exitCodeOf(outcome), EXIT.failed);
  // Retention still runs, for the local sets only.
  assertEquals(h.pruned, [null]);
});

Deno.test("an upload failure is 'not copied': refusals stay refusals, everything else is unreachable with the real cause, and no key leaks", async () => {
  // A generic error mentioning the key pair: unreachable, redacted.
  const h = harness({
    settings: withOffsite,
    upload: () =>
      Promise.reject(
        new Error(`boom for ${KEY_ID} using ${KEY_SECRET} and ${LEASE}`),
      ),
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, {
    kind: "not-copied",
    runId: RUN,
    code: "destination_unreachable",
  });
  const last = h.reports.at(-1)!.body;
  assertEquals(last.status, "completed");
  assertEquals(last.locations, ["server-host"]);
  assertEquals(last.failureCode, "destination_unreachable");
  assertStringIncludes(last.failureDetail!, "boom");
  for (const secret of [KEY_ID, KEY_SECRET, LEASE]) {
    assert(!JSON.stringify(last).includes(secret));
  }
  assertEquals(h.pruned, [null]);

  // Codes the server accepts keep their meaning.
  for (
    const [error, expected] of [
      [
        new OffsiteError("destination_unreachable", "connect refused"),
        "destination_unreachable",
      ],
      [
        new OffsiteError("destination_refused", "403 Access Denied"),
        "destination_refused",
      ],
      // A size that did not verify, or any other runner-side cause, is mapped
      // conservatively to unreachable with the real cause in the detail.
      [
        new OffsiteError(
          "runner_error",
          "The destination holds 4 bytes of a.age, expected 5.",
        ),
        "destination_unreachable",
      ],
    ] as const
  ) {
    const g = harness({
      settings: withOffsite,
      upload: () => Promise.reject(error),
    });
    assertEquals((await runOnce(g.deps)).kind, "not-copied");
    const report = g.reports.at(-1)!.body;
    assertEquals(report.status, "completed");
    assertEquals(report.failureCode, expected);
    assertStringIncludes(report.failureDetail!, error.detail);
    assertEquals(g.reports.some((r) => r.body.status === "failed"), false);
  }
});

Deno.test("a server-withheld destination (offsiteRefusal) is 'not copied' with the matching code", async () => {
  for (
    const [code, detail, expected] of [
      [
        "destination_refused",
        "destination_private_address",
        "destination_refused",
      ],
      ["destination_refused", "destination_invalid", "destination_refused"],
      [
        "destination_unreachable",
        "destination_unresolvable",
        "destination_unreachable",
      ],
      [
        "runner_error",
        "The off-site destination is configured but the server released no credentials.",
        "destination_unreachable",
      ],
    ] as const
  ) {
    const h = harness({
      settings: withOffsite,
      offsite: () => {
        throw new OffsiteError(code, detail);
      },
    });
    const outcome = await runOnce(h.deps);
    assertEquals(outcome.kind, "not-copied", detail);
    const report = h.reports.at(-1)!.body;
    assertEquals(report.status, "completed", detail);
    assertEquals(report.failureCode, expected, detail);
    assertEquals(report.failureDetail, detail);
  }
});

Deno.test("a failure before or during the local backup is still 'failed' and never 'not copied'", async () => {
  const before = harness({
    settings: withOffsite,
    backup: () => Promise.reject(new StepError("disk_full", "No space left")),
  });
  assertEquals(await runOnce(before.deps), {
    kind: "failed",
    runId: RUN,
    code: "disk_full",
  });
  assertEquals(before.reports.at(-1)!.body.status, "failed");
  assertEquals(
    before.reports.some((r) => r.body.status === "completed"),
    false,
  );
  assertEquals(
    exitCodeOf({ kind: "failed", runId: RUN, code: "disk_full" }),
    1,
  );

  // Settings unreadable: nothing was backed up, so it fails.
  const noSettings = harness({ settingsError: new ApiFatal(500, "INTERNAL") });
  assertEquals((await runOnce(noSettings.deps)).kind, "failed");
});

Deno.test("a fully copied backup stays a plain completed report, and prunes both sides", async () => {
  const h = harness({ settings: withOffsite });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome.kind, "completed");
  assertEquals(h.reports.at(-1)!.body, {
    status: "completed",
    sizeBytes: "1234",
    locations: ["server-host", "off-site"],
  });
  assertEquals(h.pruned, [fakeOffsite]);
  assertEquals(exitCodeOf(outcome), 0);
});

Deno.test("when settings cannot be read the run fails with runner_error", async () => {
  const h = harness({ settingsError: new ApiFatal(500, "INTERNAL") });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, { kind: "failed", runId: RUN, code: "runner_error" });
  assert(!h.events.includes("backup"));
});

Deno.test("a lost lease during a long step cancels the work and sends no terminal report", async () => {
  let aborted = false;
  const h = harness({
    // The first heartbeat (the 3rd report) is refused: the lease is gone.
    onReport: (sequence) => {
      if (sequence === 3) throw new LeaseLost("lease_expired");
    },
    backup: (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        })
      ),
  });
  const pending = runOnce(h.deps);
  await until(() => h.sleepers.length === 1);
  h.sleepers[0].wake();
  const outcome = await pending;
  assertEquals(outcome, {
    kind: "lease-lost",
    runId: RUN,
    reason: "lease_expired",
  });
  assertEquals(aborted, true);
  assert(!h.events.includes("upload"));
  assertEquals(
    h.reports.some((r) => r.body.status !== "running"),
    false,
  );
});

Deno.test("a report that cannot be delivered ends the pass without further work", async () => {
  const h = harness({
    onReport: (sequence) => {
      if (sequence === 2) throw new ReportUndelivered();
    },
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, { kind: "undelivered", runId: RUN });
  assert(!h.events.includes("backup"));
});

Deno.test("a lost lease on the terminal report is a lost lease, not a failure", async () => {
  const h = harness({
    onReport: (_s, body) => {
      if (body.status === "completed") throw new LeaseLost("run_finished");
    },
  });
  assertEquals(
    await runOnce(h.deps),
    { kind: "lease-lost", runId: RUN, reason: "run_finished" },
  );
  assert(!h.events.includes("prune")); // nothing was completed
});

Deno.test("a retention failure is logged and never fails or changes the completed backup", async () => {
  const h = harness({
    prune: () => Promise.reject(new Error(`cannot list ${LEASE}`)),
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome.kind, "completed");
  assertEquals(h.reports.at(-1)!.body.status, "completed");
  assertEquals(h.logs.some((l) => l.includes("retention failed")), true);
  assert(!h.logs.join("\n").includes(LEASE));
});

Deno.test("an unexpected bug is reported as runner_error instead of leaving the run to lapse", async () => {
  const h = harness({
    backup: () => Promise.reject(new TypeError("undefined is not a function")),
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, { kind: "failed", runId: RUN, code: "runner_error" });
});

/** The drain waits only: the heartbeat's own sleep is not one of them. */
const drainWaits = (h: { sleepers: { ms: number; wake: () => void }[] }) =>
  h.sleepers.filter((sleeper) => sleeper.ms !== 120_000);

Deno.test("the installation is held and quiet before settings are read or anything is backed up", async () => {
  const h = harness({
    maintain: [draining(), draining({ liveAttempts: 1 }), quiet],
  });
  const pending = runOnce(h.deps);
  // Each drain check that is not quiet makes the runner wait, then ask again.
  await until(() => drainWaits(h).length === 1);
  assertEquals(h.events.filter((e) => e === "maintain").length, 1);
  assertEquals(h.events.includes("settings"), false);
  assertEquals(h.events.includes("backup"), false);
  drainWaits(h)[0].wake();
  await until(() => drainWaits(h).length === 2);
  drainWaits(h)[1].wake();
  const outcome = await pending;
  assertEquals(outcome.kind, "completed");
  assertEquals(h.maintainCalls(), 3);
  // Nothing after the drain started until the third answer said quiesced.
  const maintainAt = h.events.lastIndexOf("maintain");
  assert(h.events.indexOf("settings") > maintainAt);
  assert(h.events.indexOf("backup") > maintainAt);
  // The waits follow the server's own hint, within bounds.
  assertEquals(drainWaits(h)[0].ms, 2000);
});

Deno.test("a drain that never finishes fails the run with drain_timeout and takes no backup", async () => {
  const h = harness({
    maintain: [draining({ liveAttempts: 3, openTransactions: 1 })],
    drainTimeoutMs: 60_000,
  });
  const pending = runOnce(h.deps);
  await until(() => drainWaits(h).length === 1);
  // The clock passes the window while the runner sleeps between two checks.
  h.advance(61_000);
  drainWaits(h)[0].wake();
  const outcome = await pending;
  assertEquals(outcome, {
    kind: "failed",
    runId: RUN,
    code: "drain_timeout",
  });
  const last = h.reports.at(-1)!;
  assertEquals(last.body.status, "failed");
  assertEquals(last.body.failureCode, "drain_timeout");
  // The cause names what was still in flight, so the operator knows what to look at.
  assertStringIncludes(last.body.failureDetail ?? "", "3 worker attempts");
  assertStringIncludes(last.body.failureDetail ?? "", "1 open transactions");
  assertStringIncludes(last.body.failureDetail ?? "", "No backup was taken");
  // No settings were read (no credentials released), nothing was backed up
  // or uploaded; the failed report is what lets the installation go.
  for (const never of ["settings", "backup", "upload", "prune"]) {
    assertEquals(h.events.includes(never), false, never);
  }
});

Deno.test("a server that cannot be reached for a moment is asked again inside the window", async () => {
  let calls = 0;
  const h = harness({
    maintain: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new ApiUnavailable("status 503"))
        : Promise.resolve(quiet);
    },
  });
  const pending = runOnce(h.deps);
  await until(() => drainWaits(h).length === 1);
  assertEquals(drainWaits(h)[0].ms, 5000);
  drainWaits(h)[0].wake();
  const outcome = await pending;
  assertEquals(outcome.kind, "completed");
  assertEquals(calls, 2);
});

Deno.test("a server that stays unreachable past the window ends the run as runner_error", async () => {
  const h = harness({
    maintain: () => Promise.reject(new ApiUnavailable("status 503")),
    drainTimeoutMs: 30_000,
  });
  const pending = runOnce(h.deps);
  await until(() => drainWaits(h).length === 1);
  h.advance(31_000);
  drainWaits(h)[0].wake();
  const outcome = await pending;
  assertEquals(outcome.kind, "failed");
  assertEquals(h.reports.at(-1)!.body.failureCode, "runner_error");
  assertEquals(h.events.includes("backup"), false);
});

Deno.test("a refusal to hold the installation (another run holds it) ends the run as runner_error", async () => {
  const h = harness({
    maintain: () => Promise.reject(new ApiFatal(409, "maintenance_held")),
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome, { kind: "failed", runId: RUN, code: "runner_error" });
  assertStringIncludes(
    h.reports.at(-1)!.body.failureDetail ?? "",
    "could not hold the installation",
  );
  assertEquals(h.events.includes("backup"), false);
});

Deno.test("a lost claim while holding stops the run without a terminal report", async () => {
  const h = harness({
    maintain: () => Promise.reject(new LeaseLost("lease_expired")),
  });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome.kind, "lease-lost");
  // The claim is gone, so no report can be taken; the hold lapses with it.
  assertEquals(h.reports.map((r) => r.body.status), ["running"]);
  assertEquals(h.events.includes("backup"), false);
});

Deno.test("the cutoff is asked for once, after the installation is quiet and just before the backup, and the backup receives it", async () => {
  const h = harness({ maintain: [draining(), quiet] });
  const pending = runOnce(h.deps);
  await until(() => drainWaits(h).length === 1);
  // Not while the installation is still draining.
  assertEquals(h.events.includes("cutoff"), false);
  drainWaits(h)[0].wake();
  const outcome = await pending;
  assertEquals(outcome.kind, "completed");
  assertEquals(h.cutoffAsks(), 1);
  const at = (name: string) => h.events.indexOf(name);
  assert(
    at("maintain") < at("cutoff"),
    "the cutoff came before the quiet check",
  );
  assert(at("cutoff") < at("backup"), "the cutoff came after the backup began");
  assertEquals(h.events.filter((e) => e === "cutoff").length, 1);
  // The backup step is given the database cutoff, with its census.
  assertEquals(h.cutoffs, [cutoffFromView(cutoffView)]);
  assertEquals(h.cutoffs[0].source, "database");
  assertEquals(h.cutoffs[0].effects?.total, 3);
});

Deno.test("an idle poll and a run that never goes quiet ask for no cutoff", async () => {
  const idle = harness({ claimed: false });
  await runOnce(idle.deps);
  assertEquals(idle.cutoffAsks(), 0);
  const stuck = harness({
    maintain: [draining({ liveAttempts: 3 })],
    drainTimeoutMs: 60_000,
  });
  const pending = runOnce(stuck.deps);
  await until(() => drainWaits(stuck).length === 1);
  stuck.advance(61_000);
  drainWaits(stuck)[0].wake();
  assertEquals((await pending).kind, "failed");
  assertEquals(stuck.cutoffAsks(), 0);
  assertEquals(stuck.events.includes("backup"), false);
});

Deno.test("a cutoff the server refuses or cannot give fails the run as runner_error and takes no backup", async () => {
  for (
    const error of [
      new ApiFatal(409, "not_quiesced"),
      new ApiUnavailable("status 503"),
    ]
  ) {
    const h = harness({ cutoff: error });
    const outcome = await runOnce(h.deps);
    assertEquals(outcome, { kind: "failed", runId: RUN, code: "runner_error" });
    assertEquals(h.events.includes("backup"), false, error.message);
    const last = h.reports.at(-1)!;
    assertEquals(last.body.status, "failed");
    assertStringIncludes(String(last.body.failureDetail), "cutoff");
  }
});

Deno.test("a lost lease on the cutoff request stops the run before any backup", async () => {
  const h = harness({ cutoff: new LeaseLost("lease_expired") });
  const outcome = await runOnce(h.deps);
  assertEquals(outcome.kind, "lease-lost");
  assertEquals(h.events.includes("backup"), false);
});
