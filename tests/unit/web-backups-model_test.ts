import { assertEquals } from "@std/assert";
import type {
  BackupDrill,
  BackupRun,
  BackupStatus,
} from "../../apps/web/src/api/client.ts";
import {
  backupNotice,
  isBackingUp,
  isQuiet,
  keptInKey,
  nextBackup,
  restoreCheckFact,
  runResult,
  scheduleWords,
  sizeOf,
  spanOfSeconds,
  spanSince,
  startedByKey,
  takenAt,
} from "../../apps/web/src/screens/backups/backups-model.ts";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");

function status(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    state: "protected",
    lastGoodBackupAt: "2026-11-23T09:00:00.000Z",
    lastBackupCutoffAt: null,
    lastAttemptAt: "2026-11-23T09:00:00.000Z",
    runningRunId: null,
    runningProgressPercent: null,
    waitingRunId: null,
    runnerConfigured: true,
    runnerLastUsedAt: "2026-11-23T11:59:00.000Z",
    maintenanceState: "off",
    maintenanceSince: null,
    ...overrides,
  } as BackupStatus;
}

function run(overrides: Partial<BackupRun> = {}): BackupRun {
  return {
    id: "run-1",
    triggerKind: "manual",
    status: "completed",
    requestedAt: "2026-11-23T08:59:00.000Z",
    requestedByPrincipalId: null,
    claimedAt: null,
    startedAt: "2026-11-23T09:00:00.000Z",
    finishedAt: "2026-11-23T09:05:00.000Z",
    leaseExpiresAt: null,
    progressPercent: null,
    sizeBytes: "1500000",
    locations: ["server-host", "off-site"],
    failureCode: null,
    failureDetail: null,
    ...overrides,
  } as BackupRun;
}

function notice(
  overrides: Partial<BackupStatus> = {},
  latest: BackupRun | null = null,
  offsiteConfigured: boolean | null = true,
) {
  return backupNotice({
    status: status(overrides),
    latest,
    offsiteConfigured,
    nowMs: NOW,
  });
}

Deno.test("spans use the largest whole unit and never go negative", () => {
  assertEquals(spanSince("2026-11-23T11:59:30.000Z", NOW), {
    unit: "second",
    value: 30,
  });
  assertEquals(spanSince("2026-11-23T09:00:00.000Z", NOW), {
    unit: "hour",
    value: 3,
  });
  assertEquals(spanSince("2026-11-20T12:00:00.000Z", NOW), {
    unit: "day",
    value: 3,
  });
  assertEquals(spanSince("2026-11-23T12:05:00.000Z", NOW), {
    unit: "second",
    value: 0,
  });
  assertEquals(spanOfSeconds(125), { unit: "minute", value: 2 });
});

Deno.test("a protected installation says protected, with or without an off-site copy", () => {
  const withCopy = notice();
  assertEquals(withCopy.id, "protected");
  assertEquals(withCopy.tone, "success");
  assertEquals(
    withCopy.lines[0]?.key,
    "installation.backups.notice.protected.offsite",
  );
  assertEquals(withCopy.lines[0]?.values.ago, { unit: "hour", value: 3 });
  assertEquals(
    notice({}, null, false).lines[0]?.key,
    "installation.backups.notice.protected.hostOnly",
  );
});

Deno.test("nothing ever finished is an error that asks for a first backup", () => {
  const result = notice({ state: "failed", lastGoodBackupAt: null });
  assertEquals(result.id, "never");
  assertEquals(result.tone, "error");
  assertEquals(result.lines.length, 1);
});

Deno.test("a failed backup names the cause, the fix and the service's own answer", () => {
  const result = notice(
    {
      state: "failed",
      lastAttemptAt: "2026-11-23T03:00:00.000Z",
    },
    run({
      status: "failed",
      failureCode: "disk_full",
      failureDetail: "no space left on device",
    }),
  );
  assertEquals(result.id, "failed");
  assertEquals(result.tone, "error");
  assertEquals(result.title.values.time, "2026-11-23T03:00:00.000Z");
  assertEquals(result.lines[0], {
    key: "installation.backups.notice.failed.cause",
    values: {
      cause: "installation.backups.cause.disk_full",
      fix: "installation.backups.fix.disk_full",
    },
  });
  assertEquals(result.lines[1]?.values.time, "2026-11-23T09:00:00.000Z");
  assertEquals(result.detail, "no space left on device");
});

Deno.test("a cause with no fix uses the sentence that ends at the cause", () => {
  const result = notice(
    { state: "failed" },
    run({ status: "failed", failureCode: "runner_error" }),
  );
  assertEquals(
    result.lines[0]?.key,
    "installation.backups.notice.failed.causeOnly",
  );
});

Deno.test("a failure without a cause says it did not finish", () => {
  assertEquals(
    notice({ state: "failed" }, null).lines[0]?.key,
    "installation.backups.notice.failed.unknown",
  );
});

Deno.test("a stale backup reports its age and the cause only when the latest run failed", () => {
  const quiet = notice({
    state: "stale",
    lastGoodBackupAt: "2026-11-20T12:00:00.000Z",
  });
  assertEquals(quiet.tone, "warning");
  assertEquals(quiet.title.values.age, { unit: "day", value: 3 });
  assertEquals(quiet.lines.length, 1);
  const withCause = notice(
    { state: "stale", lastGoodBackupAt: "2026-11-20T12:00:00.000Z" },
    run({ status: "failed", failureCode: "key_missing" }),
  );
  assertEquals(withCause.lines.length, 2);
});

Deno.test("a backup kept on this server only is a warning with the host copy called good", () => {
  const result = notice(
    { state: "not_copied" },
    run({ failureCode: "destination_refused" }),
  );
  assertEquals(result.tone, "warning");
  assertEquals(result.id, "not_copied");
  assertEquals(
    result.lines[0]?.key,
    "installation.backups.notice.notCopied.cause",
  );
  assertEquals(
    result.lines[1]?.key,
    "installation.backups.notice.notCopied.hostGood",
  );
});

Deno.test("a running backup shows its percent, or says it waits for the service", () => {
  const running = notice({
    state: "running",
    runningRunId: "r",
    runningProgressPercent: 42,
  });
  assertEquals(running.tone, "information");
  assertEquals(running.lines[0], {
    key: "installation.backups.notice.running.percent",
    values: { percent: 42 },
  });
  const started = notice({ state: "running", runningRunId: "r" });
  assertEquals(
    started.lines[0]?.key,
    "installation.backups.notice.running.started",
  );
  const waiting = notice({ state: "protected", waitingRunId: "w" });
  assertEquals(waiting.id, "waiting");
  assertEquals(
    waiting.lines[0]?.key,
    "installation.backups.notice.running.waiting",
  );
  assertEquals(isBackingUp(status({ waitingRunId: "w" })), true);
  assertEquals(isBackingUp(status()), false);
});

Deno.test("held work adds the caption under the notice", () => {
  assertEquals(notice({ maintenanceState: "draining" }).holdingWork, true);
  assertEquals(notice({ maintenanceState: "quiesced" }).holdingWork, true);
  assertEquals(notice().holdingWork, false);
});

Deno.test("the next backup is worked out from the schedule in UTC", () => {
  assertEquals(
    nextBackup(
      { enabled: false, interval: "daily", timeOfDayUtc: "03:00" },
      NOW,
    ),
    { kind: "off" },
  );
  assertEquals(
    nextBackup(
      { enabled: true, interval: "daily", timeOfDayUtc: "15:30" },
      NOW,
    ),
    { kind: "at", iso: "2026-11-23T15:30:00.000Z" },
  );
  assertEquals(
    nextBackup(
      { enabled: true, interval: "daily", timeOfDayUtc: "03:00" },
      NOW,
    ),
    { kind: "at", iso: "2026-11-24T03:00:00.000Z" },
  );
  assertEquals(
    nextBackup(
      { enabled: true, interval: "hourly", timeOfDayUtc: "00:15" },
      NOW,
    ),
    { kind: "at", iso: "2026-11-23T12:15:00.000Z" },
  );
  assertEquals(
    nextBackup(
      { enabled: true, interval: "hourly", timeOfDayUtc: "00:00" },
      NOW,
    ),
    { kind: "at", iso: "2026-11-23T13:00:00.000Z" },
  );
  assertEquals(
    nextBackup(
      { enabled: true, interval: "weekly", timeOfDayUtc: "03:00" },
      NOW,
    ),
    { kind: "at", iso: "2026-11-30T03:00:00.000Z" },
  );
  assertEquals(
    nextBackup(
      { enabled: true, interval: "weekly", timeOfDayUtc: "18:00" },
      NOW,
    ),
    { kind: "at", iso: "2026-11-23T18:00:00.000Z" },
  );
});

Deno.test("the last restore check is never, passed or failed with its time", () => {
  assertEquals(restoreCheckFact(null), { kind: "never" });
  const drill = {
    outcome: "failed",
    recordedAt: "2026-11-22T10:00:00.000Z",
    rtoSeconds: 240,
  } as BackupDrill;
  assertEquals(restoreCheckFact(drill), {
    kind: "recorded",
    passed: false,
    recordedAt: "2026-11-22T10:00:00.000Z",
    restoredIn: { unit: "minute", value: 4 },
  });
});

Deno.test("rows say who started them, where they are kept and how they ended", () => {
  assertEquals(
    startedByKey(run({ triggerKind: "scheduled" })),
    "installation.backups.startedBy.scheduled",
  );
  assertEquals(
    startedByKey(run({ triggerKind: "manual" })),
    "installation.backups.startedBy.person",
  );
  assertEquals(
    keptInKey(["server-host"]),
    "installation.backups.keptIn.host",
  );
  assertEquals(
    keptInKey(["server-host", "off-site"]),
    "installation.backups.keptIn.hostAndOffsite",
  );
  assertEquals(keptInKey([]), null);
  assertEquals(runResult(run()).tone, "success");
  assertEquals(
    runResult(run({ failureCode: "destination_unreachable" })).key,
    "installation.backups.result.notCopied",
  );
  assertEquals(
    runResult(run({ status: "failed", failureCode: "disk_full" })).tone,
    "danger",
  );
  assertEquals(runResult(run({ status: "requested" })).tone, "neutral");
  assertEquals(runResult(run({ status: "running" })).tone, "information");
});

Deno.test("a row is taken when it finished, else when it started or was asked for", () => {
  assertEquals(takenAt(run()), "2026-11-23T09:05:00.000Z");
  assertEquals(
    takenAt(run({ finishedAt: null })),
    "2026-11-23T09:00:00.000Z",
  );
  assertEquals(
    takenAt(run({ finishedAt: null, startedAt: null })),
    "2026-11-23T08:59:00.000Z",
  );
});

Deno.test("sizes step up by thousands and an unreadable size is none", () => {
  assertEquals(sizeOf(null), null);
  assertEquals(sizeOf("abc"), null);
  assertEquals(sizeOf("512"), { unit: "byte", value: 512 });
  assertEquals(sizeOf("1500000"), { unit: "megabyte", value: 1.5 });
});

Deno.test("the service is quiet after more than an hour", () => {
  assertEquals(isQuiet(null, NOW), false);
  assertEquals(isQuiet("2026-11-23T11:00:00.000Z", NOW), false);
  assertEquals(isQuiet("2026-11-23T10:59:00.000Z", NOW), true);
});

Deno.test("the schedule is told in a few words", () => {
  assertEquals(
    scheduleWords({ enabled: false, interval: "daily", timeOfDayUtc: "03:00" }),
    { key: "installation.backups.settings.schedule.off", values: {} },
  );
  assertEquals(
    scheduleWords({ enabled: true, interval: "weekly", timeOfDayUtc: "03:00" }),
    {
      key: "installation.backups.settings.schedule.on",
      values: {
        interval: "installation.backups.interval.weekly",
        time: "03:00",
      },
    },
  );
});
