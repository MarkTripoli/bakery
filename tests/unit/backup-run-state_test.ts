import { assert, assertEquals, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertReportShape,
  BACKUP_STALE_AFTER_MS,
  BackupFailureCode,
  BackupRunStatus,
  backupStateWord,
  decideReport,
  type ReportBody,
  reportDigest,
  type RunSnapshot,
} from "../../apps/server/src/modules/backups/state.ts";

/** #80 S1a: the rules a backup report is judged by, with no database. */

const now = new Date("2026-11-20T12:00:00Z");
const later = new Date(now.getTime() + 60_000);
const earlier = new Date(now.getTime() - 60_000);

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    status: BackupRunStatus.Running,
    reportSequence: 2,
    lastReportDigest: "stored",
    progressPercent: 40,
    leaseExpiresAt: later,
    ...overrides,
  };
}
const running = (sequence: number, progressPercent?: number): ReportBody => ({
  sequence,
  status: "running",
  progressPercent,
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof StandardError) {
      const reason = (error.params as { reason?: string } | undefined)?.reason;
      return reason ? `${error.code}:${reason}` : error.code;
    }
    throw error;
  }
  return undefined;
}

Deno.test("only the next sequence applies; gaps and regressions conflict", () => {
  assertEquals(decideReport(run(), running(3, 50), "d", now), {
    kind: "apply",
  });
  assertEquals(
    code(() => decideReport(run(), running(5, 50), "d", now)),
    "STATE_CONFLICT:sequence_gap",
  );
  assertEquals(
    code(() => decideReport(run(), running(1, 50), "d", now)),
    "STATE_CONFLICT:sequence_regression",
  );
});

Deno.test("the stored sequence replays when the body is identical and mismatches when it is not", () => {
  assertEquals(decideReport(run(), running(2, 40), "stored", now), {
    kind: "replay",
  });
  assertEquals(
    code(() => decideReport(run(), running(2, 41), "other", now)),
    "IDEMPOTENCY_PAYLOAD_MISMATCH",
  );
  // A finished run still answers its last report again.
  assertEquals(
    decideReport(
      run({ status: BackupRunStatus.Completed }),
      running(2, 40),
      "stored",
      now,
    ),
    { kind: "replay" },
  );
});

Deno.test("a finished run, an unclaimed run and a lapsed lease take no new report", () => {
  for (const status of [BackupRunStatus.Completed, BackupRunStatus.Failed]) {
    assertEquals(
      code(() => decideReport(run({ status }), running(3), "d", now)),
      "STATE_CONFLICT:run_finished",
    );
  }
  assertEquals(
    code(() =>
      decideReport(
        run({ status: BackupRunStatus.Requested }),
        running(3),
        "d",
        now,
      )
    ),
    "STATE_CONFLICT:run_not_claimed",
  );
  assertEquals(
    code(() =>
      decideReport(run({ leaseExpiresAt: earlier }), running(3), "d", now)
    ),
    "STATE_CONFLICT:lease_expired",
  );
  assertEquals(
    code(() =>
      decideReport(run({ leaseExpiresAt: null }), running(3), "d", now)
    ),
    "STATE_CONFLICT:lease_expired",
  );
});

Deno.test("progress never goes back", () => {
  assertEquals(
    code(() => decideReport(run(), running(3, 39), "d", now)),
    "UNPROCESSABLE",
  );
  assertEquals(decideReport(run(), running(3, 40), "d", now).kind, "apply");
  assertEquals(
    decideReport(run({ progressPercent: null }), running(3, 0), "d", now).kind,
    "apply",
  );
});

Deno.test("each status needs its own figures and refuses the others", () => {
  assertReportShape({ sequence: 1, status: "running", progressPercent: 5 });
  assertReportShape({
    sequence: 1,
    status: "completed",
    sizeBytes: "1024",
    locations: ["server-host", "off-site"],
  });
  assertReportShape({
    sequence: 1,
    status: "failed",
    failureCode: "disk_full",
    failureDetail: "no space left on device",
  });
  const bad: ReportBody[] = [
    { sequence: 1, status: "running", sizeBytes: "1" },
    { sequence: 1, status: "running", failureCode: "disk_full" },
    { sequence: 1, status: "completed", locations: ["server-host"] },
    { sequence: 1, status: "completed", sizeBytes: "1", locations: [] },
    { sequence: 1, status: "completed", sizeBytes: "1", locations: ["cloud"] },
    {
      sequence: 1,
      status: "completed",
      sizeBytes: "1",
      locations: ["off-site", "off-site"],
    },
    {
      sequence: 1,
      status: "completed",
      sizeBytes: "-1",
      locations: ["off-site"],
    },
    {
      sequence: 1,
      status: "completed",
      sizeBytes: "9223372036854775808",
      locations: ["off-site"],
    },
    {
      sequence: 1,
      status: "completed",
      sizeBytes: "1",
      locations: ["off-site"],
      failureCode: "disk_full",
    },
    { sequence: 1, status: "failed" },
    { sequence: 1, status: "failed", failureCode: "disk_full", sizeBytes: "1" },
    {
      sequence: 1,
      status: "failed",
      failureCode: "disk_full",
      progressPercent: 1,
    },
  ];
  for (const report of bad) {
    assertThrows(
      () => assertReportShape(report),
      StandardError,
      undefined,
      JSON.stringify(report),
    );
  }
});

Deno.test("the report digest is stable and changes with the body", async () => {
  const a = await reportDigest(running(3, 50));
  assertEquals(a, await reportDigest(running(3, 50)));
  assert(a !== await reportDigest(running(3, 51)));
  assert(a !== await reportDigest(running(4, 50)));
});

Deno.test("the state word follows the held run, the newest attempt, then age", () => {
  const held = (leaseExpiresAt: Date | null) => ({ leaseExpiresAt });
  const word = (
    overrides: Partial<Parameters<typeof backupStateWord>[0]> = {},
  ) =>
    backupStateWord({
      now,
      held: null,
      newestFinishedStatus: null,
      lastGoodAt: null,
      ...overrides,
    });
  assertEquals(word({ held: held(later) }), "running");
  assertEquals(word({ held: held(earlier) }), "failed");
  assertEquals(
    word({ newestFinishedStatus: BackupRunStatus.Failed }),
    "failed",
  );
  assertEquals(word(), "stale");
  assertEquals(
    word({
      newestFinishedStatus: BackupRunStatus.Completed,
      lastGoodAt: new Date(now.getTime() - 1000),
    }),
    "protected",
  );
  assertEquals(
    word({
      newestFinishedStatus: BackupRunStatus.Completed,
      lastGoodAt: new Date(now.getTime() - BACKUP_STALE_AFTER_MS - 1),
    }),
    "stale",
  );
});

Deno.test("the report schema is strict and has no field for bytes or keys", () => {
  const valid = {
    leaseToken: "a".repeat(43),
    sequence: 1,
    status: "completed",
    sizeBytes: "10",
    locations: ["server-host"],
  };
  assert(contractSchemas.BackupRunReport.safeParse(valid).success);
  for (
    const extra of [
      "ageIdentity",
      "privateKey",
      "bytes",
      "content",
      "dump",
      "archive",
      "secretAccessKey",
    ]
  ) {
    assertEquals(
      contractSchemas.BackupRunReport.safeParse({ ...valid, [extra]: "x" })
        .success,
      false,
      extra,
    );
  }
  // There is no server-set cause a runner could claim: the closed code list
  // holds only the causes a runner reports, so anything else is refused.
  assertEquals(
    contractSchemas.BackupRunReport.safeParse({
      leaseToken: valid.leaseToken,
      sequence: 1,
      status: "failed",
      failureCode: "runner_lost",
    }).success,
    false,
  );
  assertEquals(
    contractSchemas.BackupRunReport.safeParse({ ...valid, leaseToken: "short" })
      .success,
    false,
  );
  assertEquals(
    contractSchemas.BackupRunReport.safeParse({
      ...valid,
      failureDetail: "x".repeat(1001),
    }).success,
    false,
  );
  assertEquals(
    contractSchemas.BackupRunReport.safeParse({ ...valid, sequence: 0 })
      .success,
    false,
  );
});

/** The code and the first issue's code of a 422, e.g. `UNPROCESSABLE:needs_failure_code`. */
function issueCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof StandardError) {
      const issues =
        (error.params as { issues?: { code: string }[] } | undefined)
          ?.issues;
      return issues?.[0] ? `${error.code}:${issues[0].code}` : error.code;
    }
    throw error;
  }
  return undefined;
}

Deno.test("a completed report may say why the off-site copy failed, and only then", () => {
  const taken = {
    sequence: 1,
    status: "completed",
    sizeBytes: "1024",
    locations: ["server-host"],
  } as const;
  // Accepted: taken on the host, the off-site copy refused or unreachable, with
  // or without the destination's own words.
  for (
    const failureCode of ["destination_refused", "destination_unreachable"]
  ) {
    assertReportShape({ ...taken, failureCode });
    assertReportShape({
      ...taken,
      failureCode,
      failureDetail: "The destination answered 403. The backup was taken.",
    });
  }
  // A plain completed report (no off-site configured, or a good copy) still passes.
  assertReportShape(taken);
  assertReportShape({ ...taken, locations: ["server-host", "off-site"] });

  const rejected: [ReportBody, string][] = [
    // Copied off-site AND failed to copy: a contradiction.
    [
      {
        ...taken,
        locations: ["server-host", "off-site"],
        failureCode: "destination_refused",
      },
      "not_allowed_when_copied_off_site",
    ],
    // Only the off-site causes qualify; every other cause ends the run as failed.
    [{ ...taken, failureCode: "disk_full" }, "not_allowed_when_completed"],
    [{ ...taken, failureCode: "key_missing" }, "not_allowed_when_completed"],
    [{ ...taken, failureCode: "runner_error" }, "not_allowed_when_completed"],
    [{ ...taken, failureCode: "runner_lost" }, "not_allowed_when_completed"],
    // The backup must be on the host, and nowhere else is a failure to copy.
    [
      { ...taken, locations: ["off-site"], failureCode: "destination_refused" },
      "not_allowed_when_copied_off_site",
    ],
    // A detail needs a cause to explain.
    [{ ...taken, failureDetail: "just words" }, "needs_failure_code"],
  ];
  for (const [report, reason] of rejected) {
    assertEquals(
      issueCode(() => assertReportShape(report)),
      `UNPROCESSABLE:${reason}`,
      JSON.stringify(report),
    );
  }
  // `failed` keeps its rules: no size and no locations, even with an off-site cause.
  assertEquals(
    issueCode(() =>
      assertReportShape({
        sequence: 1,
        status: "failed",
        failureCode: "destination_refused",
        sizeBytes: "1",
      })
    ),
    "UNPROCESSABLE:not_allowed",
  );
  assertEquals(
    issueCode(() =>
      assertReportShape({
        sequence: 1,
        status: "failed",
        failureCode: "destination_refused",
        locations: ["server-host"],
      })
    ),
    "UNPROCESSABLE:not_allowed",
  );
  // A running report never carries a failure.
  assertEquals(
    issueCode(() =>
      assertReportShape({
        sequence: 1,
        status: "running",
        failureCode: "destination_refused",
      })
    ),
    "UNPROCESSABLE:not_allowed_while_running",
  );
});

Deno.test("a completed-with-failure report replays identically and a changed cause is a mismatch", async () => {
  const report: ReportBody = {
    sequence: 3,
    status: "completed",
    sizeBytes: "1024",
    locations: ["server-host"],
    failureCode: "destination_refused",
    failureDetail: "The destination answered 403.",
  };
  const digest = await reportDigest(report);
  const stored = run({
    status: BackupRunStatus.Completed,
    reportSequence: 3,
    lastReportDigest: digest,
    leaseExpiresAt: null,
  });
  assertEquals(decideReport(stored, report, digest, now), { kind: "replay" });
  const changed: ReportBody = {
    ...report,
    failureCode: "destination_unreachable",
  };
  assertEquals(
    code(() => decideReport(stored, changed, "other", now)),
    "IDEMPOTENCY_PAYLOAD_MISMATCH",
  );
  // The digest covers the cause, so a changed cause never replays.
  assert(digest !== await reportDigest(changed));
  assert(digest !== await reportDigest({ ...report, failureDetail: "other" }));
});

Deno.test("not_copied: the newest finished attempt decides, a later good backup supersedes it, a live run beats it", () => {
  const held = (leaseExpiresAt: Date | null) => ({ leaseExpiresAt });
  const recent = new Date(now.getTime() - 1000);
  const word = (
    overrides: Partial<Parameters<typeof backupStateWord>[0]> = {},
  ) =>
    backupStateWord({
      now,
      held: null,
      newestFinishedStatus: BackupRunStatus.Completed,
      newestFinishedNotCopied: true,
      lastGoodAt: recent,
      ...overrides,
    });
  // The newest finished attempt was taken but not copied off-site.
  assertEquals(word(), "not_copied");
  // A later good FULL backup is the newest finished attempt and supersedes it.
  assertEquals(word({ newestFinishedNotCopied: false }), "protected");
  assertEquals(word({ newestFinishedNotCopied: undefined }), "protected");
  // A live run is still running; a lapsed claim is still failed.
  assertEquals(word({ held: held(later) }), "running");
  assertEquals(word({ held: held(earlier) }), "failed");
  // A newer failure beats it, and a not-copied flag on a failed run means nothing.
  assertEquals(
    word({ newestFinishedStatus: BackupRunStatus.Failed }),
    "failed",
  );
  // The local backup counts as a good one for "when was the last backup".
  assertEquals(word({ lastGoodAt: recent }), "not_copied");
  // Nothing finished yet: unchanged.
  assertEquals(
    word({
      newestFinishedStatus: null,
      newestFinishedNotCopied: undefined,
      lastGoodAt: null,
    }),
    "stale",
  );
});

Deno.test("stale beats not_copied once the last good backup passes the threshold", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const word = (
    overrides: Partial<Parameters<typeof backupStateWord>[0]> = {},
  ) =>
    backupStateWord({
      now,
      held: null,
      newestFinishedStatus: BackupRunStatus.Completed,
      newestFinishedNotCopied: true,
      lastGoodAt: new Date(now.getTime() - 1000),
      ...overrides,
    });
  const ago = (ms: number) => new Date(now.getTime() - ms);
  // No schedule: the seven-day default. Exactly at it is still not_copied (the
  // same inclusive boundary as "protected"); one millisecond past is stale.
  assertEquals(word({ lastGoodAt: ago(7 * DAY) }), "not_copied");
  assertEquals(word({ lastGoodAt: ago(7 * DAY + 1) }), "stale");
  // With a schedule the threshold is the caller's (twice the interval).
  assertEquals(
    word({ lastGoodAt: ago(2 * DAY), staleAfterMs: 2 * DAY }),
    "not_copied",
  );
  assertEquals(
    word({ lastGoodAt: ago(2 * DAY + 1), staleAfterMs: 2 * DAY }),
    "stale",
  );
  // The same age without the not-copied flag is stale too: age is the one rule.
  assertEquals(
    word({
      newestFinishedNotCopied: false,
      lastGoodAt: ago(8 * DAY),
    }),
    "stale",
  );
  // Age never hides a failure or a live run.
  assertEquals(
    word({
      newestFinishedStatus: BackupRunStatus.Failed,
      lastGoodAt: ago(30 * DAY),
    }),
    "failed",
  );
  assertEquals(
    word({
      held: { leaseExpiresAt: later },
      lastGoodAt: ago(30 * DAY),
    }),
    "running",
  );
});

Deno.test("the status schema accepts the not_copied word and still refuses unknown ones", () => {
  const status = {
    state: "not_copied",
    lastGoodBackupAt: "2026-11-20T11:59:59.000Z",
    // The cutoff of the newest completed backup that recorded one (slice C).
    lastBackupCutoffAt: "2026-11-20T11:58:00.000Z",
    lastAttemptAt: "2026-11-20T11:59:59.000Z",
    runningRunId: null,
    runningProgressPercent: null,
    waitingRunId: null,
    runnerConfigured: true,
    runnerLastUsedAt: null,
    maintenanceState: "off",
    maintenanceSince: null,
  };
  assertEquals(contractSchemas.BackupStatus.parse(status).state, "not_copied");
  // The cutoff may be absent (no completed backup recorded one), never a non-time.
  assert(
    contractSchemas.BackupStatus.safeParse({
      ...status,
      lastBackupCutoffAt: null,
    })
      .success,
  );
  assert(
    !contractSchemas.BackupStatus.safeParse({
      ...status,
      lastBackupCutoffAt: "soon",
    }).success,
  );
  assert(
    !contractSchemas.BackupStatus.safeParse({ ...status, state: "amber" })
      .success,
  );
  // The maintenance fields (#64 slice B): the three words, a time only while
  // held, and nothing else.
  for (const maintenanceState of ["off", "draining", "quiesced"]) {
    assert(
      contractSchemas.BackupStatus.safeParse({ ...status, maintenanceState })
        .success,
      maintenanceState,
    );
  }
  assert(
    contractSchemas.BackupStatus.safeParse({
      ...status,
      maintenanceState: "draining",
      maintenanceSince: "2026-11-20T12:00:00.000Z",
    }).success,
  );
  assert(
    !contractSchemas.BackupStatus.safeParse({
      ...status,
      maintenanceState: "paused",
    }).success,
  );
});

Deno.test("drain_timeout is a failure cause: accepted on a failed report, refused on every other", () => {
  assertReportShape({
    sequence: 2,
    status: "failed",
    failureCode: "drain_timeout",
    failureDetail: "The installation did not go quiet within the window.",
  });
  // A drain timeout means no backup was taken: it never rides a completed
  // report (that is only for a backup taken but not copied off-site).
  assertThrows(() =>
    assertReportShape({
      sequence: 3,
      status: "completed",
      sizeBytes: "10",
      locations: ["server-host"],
      failureCode: "drain_timeout",
    })
  );
  assertThrows(() =>
    assertReportShape({
      sequence: 1,
      status: "running",
      progressPercent: 5,
      failureCode: "drain_timeout",
    })
  );
});

Deno.test("the maintenance request and answer have their own strict shapes", () => {
  const request = contractSchemas.BackupRunMaintenance;
  assert(request.safeParse({ leaseToken: "a".repeat(43) }).success);
  assert(!request.safeParse({}).success);
  assert(!request.safeParse({ leaseToken: "short" }).success);
  // No field for anything but the lease token: no bytes, no key material.
  assert(
    !request.safeParse({ leaseToken: "a".repeat(43), extra: "x" }).success,
  );
  const answer = {
    state: "draining",
    runId: "00000000-0000-4000-8000-000000000001",
    leaseExpiresAt: "2026-11-20T12:05:00.000Z",
    liveAttempts: 2,
    openTransactions: 0,
    retryAfterSeconds: 2,
  };
  assert(contractSchemas.BackupMaintenance.safeParse(answer).success);
  assert(
    !contractSchemas.BackupMaintenance.safeParse({ ...answer, state: "x" })
      .success,
  );
});

Deno.test("incomplete_set is a failure cause: accepted on a failed report, refused on a completed one", () => {
  // The set did not contain every declared store, so the run failed.
  assertReportShape({
    sequence: 2,
    status: "failed",
    failureCode: "incomplete_set",
    failureDetail: "The backup set is not complete: redis: store_not_captured",
  });
  // A completed report may carry only the two off-site causes, never this one.
  assertThrows(
    () =>
      assertReportShape({
        sequence: 2,
        status: "completed",
        sizeBytes: "10",
        locations: ["server-host"],
        failureCode: "incomplete_set",
      }),
    StandardError,
  );
  // The wire schema knows the word on a report and on a run.
  const report = contractSchemas.BackupRunReport.parse({
    leaseToken: "a".repeat(43),
    sequence: 2,
    status: "failed",
    failureCode: "incomplete_set",
  });
  assertEquals(report.failureCode, "incomplete_set");
  assertEquals(BackupFailureCode.IncompleteSet, "incomplete_set");
});
