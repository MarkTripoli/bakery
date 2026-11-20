import { assert, assertEquals, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertReportShape,
  BACKUP_STALE_AFTER_MS,
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
    { sequence: 1, status: "failed", failureCode: "runner_lost" },
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
