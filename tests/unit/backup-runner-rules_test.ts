import { assertEquals, assertNotEquals } from "@std/assert";
import {
  backupTimestamp,
  isBackupName,
  selectExpired,
} from "../../scripts/deploy/backup-runner/retention.ts";
import { classifyBackupFailure } from "../../scripts/deploy/backup-runner/backup-step.ts";
import {
  addSecret,
  createSecrets,
  redact,
} from "../../scripts/deploy/backup-runner/redact.ts";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const set = (iso: string, n = 1) =>
  `${iso.replaceAll("-", "").replaceAll(":", "")}-${uuid(n)}`;
const NOW = new Date("2026-11-20T12:00:00Z");
const noProtect = new Set<string>();

Deno.test("a backup set name parses to its UTC time and nothing else does", () => {
  assertEquals(
    backupTimestamp(set("2026-11-20T03:00:00Z"))?.toISOString(),
    "2026-11-20T03:00:00.000Z",
  );
  for (
    const bad of [
      "",
      "latest",
      ".pending-AbCd1234",
      "20261120T030000Z",
      "20261120T030000Z-notauuid",
      `20261320T030000Z-${uuid(1)}`, // month 13
      `20260231T030000Z-${uuid(1)}`, // 31 February
      `20261120T250000Z-${uuid(1)}`, // hour 25
      `20261120T030000Z-${uuid(1)}/`,
      `x20261120T030000Z-${uuid(1)}`,
      `20261120T030000Z-${uuid(1).replace("4000", "4AAA")}`, // uppercase hex
    ]
  ) assertEquals(isBackupName(bad), false, bad);
});

Deno.test("only sets strictly older than daysToKeep expire, and never the newest or the protected one", () => {
  // 7 days before NOW is 2026-11-13T12:00:00Z.
  const exactlyAtCutoff = set("2026-11-13T12:00:00Z", 1);
  const justOlder = set("2026-11-13T11:59:59Z", 2);
  const old = set("2026-10-01T03:00:00Z", 3);
  const recent = set("2026-11-19T03:00:00Z", 4);
  const newest = set("2026-11-20T03:00:00Z", 5);
  const names = [exactlyAtCutoff, justOlder, old, recent, newest];
  assertEquals(
    selectExpired({ names, now: NOW, daysToKeep: 7, protect: noProtect }),
    [old, justOlder].sort(),
  );
  // The set at exactly the cutoff is kept: the rule is strictly older.
  assertEquals(
    selectExpired({ names, now: NOW, daysToKeep: 7, protect: noProtect })
      .includes(exactlyAtCutoff),
    false,
  );
  // A protected set survives even when it is old.
  assertEquals(
    selectExpired({
      names,
      now: NOW,
      daysToKeep: 7,
      protect: new Set([old]),
    }),
    [justOlder],
  );
});

Deno.test("the newest set is kept however old it is", () => {
  const a = set("2025-01-01T00:00:00Z", 1);
  const b = set("2025-02-01T00:00:00Z", 2);
  assertEquals(
    selectExpired({
      names: [a, b],
      now: NOW,
      daysToKeep: 1,
      protect: noProtect,
    }),
    [a],
  );
  assertEquals(
    selectExpired({ names: [a], now: NOW, daysToKeep: 1, protect: noProtect }),
    [],
  );
});

Deno.test("names that are not backup sets are never selected", () => {
  const old = set("2020-01-01T00:00:00Z", 1);
  const newest = set("2026-11-20T03:00:00Z", 2);
  const junk = [
    "latest",
    ".pending-abc12345",
    "notes.txt",
    `${old}.tmp`,
    "../x",
  ];
  assertEquals(
    selectExpired({
      names: [...junk, old, newest],
      now: NOW,
      daysToKeep: 30,
      protect: noProtect,
    }),
    [old],
  );
  assertEquals(
    selectExpired({
      names: junk,
      now: NOW,
      daysToKeep: 30,
      protect: noProtect,
    }),
    [],
  );
});

Deno.test("a bad daysToKeep keeps everything", () => {
  const old = set("2020-01-01T00:00:00Z", 1);
  const newest = set("2026-11-20T03:00:00Z", 2);
  for (const days of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertEquals(
      selectExpired({
        names: [old, newest],
        now: NOW,
        daysToKeep: days,
        protect: noProtect,
      }),
      [],
      String(days),
    );
  }
});

Deno.test("a future-dated set (a clock that ran ahead) is never expired", () => {
  const future = set("2027-06-01T00:00:00Z", 1);
  const old = set("2026-01-01T00:00:00Z", 2);
  assertEquals(
    selectExpired({
      names: [future, old],
      now: NOW,
      daysToKeep: 7,
      protect: noProtect,
    }),
    [old],
  );
});

Deno.test("backup.sh output maps to the failure codes the server knows", () => {
  const cases: [string, string][] = [
    ["tar: write error: No space left on device", "disk_full"],
    ["pg_dump: error: could not write: ENOSPC", "disk_full"],
    [
      "/etc/bakery/backup.env: line 1: BAKERY_BACKUP_RECIPIENT: required",
      "key_missing",
    ],
    ["backup.sh: line 14: age: command not found", "key_missing"],
    ["age: error: failed to parse recipient", "key_missing"],
    ["age: error: no identity matched", "key_missing"],
    ["pg_dump: error: connection refused", "runner_error"],
    ["", "runner_error"],
  ];
  for (const [stderr, code] of cases) {
    assertEquals(classifyBackupFailure({ exitCode: 1, stderr }), code, stderr);
  }
  // Disk exhaustion wins when both appear.
  assertEquals(
    classifyBackupFailure({
      exitCode: 1,
      stderr: "age: command not found\nNo space left on device",
    }),
    "disk_full",
  );
});

Deno.test("redaction removes every known secret, bearer tokens and control characters, and bounds the length", () => {
  const secrets = createSecrets(["runner-token-0123456789abcdef"]);
  addSecret(secrets, "AKIAEXAMPLEKEY12");
  addSecret(secrets, "short"); // too short to scrub: ignored
  const text =
    "send failed for AKIAEXAMPLEKEY12 with Bearer abcdefghijklmnop and runner-token-0123456789abcdef\u0007";
  const out = redact(text, secrets);
  assertEquals(out.includes("AKIAEXAMPLEKEY12"), false);
  assertEquals(out.includes("runner-token-0123456789abcdef"), false);
  assertEquals(out.includes("abcdefghijklmnop"), false);
  assertEquals(out.includes("\u0007"), false);
  assertEquals(out.includes("[redacted]"), true);
  assertEquals(redact("short stays", secrets), "short stays");
  assertEquals(redact("x".repeat(5000), secrets).length, 1000);
  assertEquals(redact("x".repeat(5000), secrets, 50).length, 50);
  assertNotEquals(redact(text, secrets), text);
});

Deno.test("a secret that contains another is removed whole", () => {
  const secrets = createSecrets(["abcdefgh", "abcdefghIJKLMNOP"]);
  assertEquals(
    redact("key=abcdefghIJKLMNOP end", secrets),
    "key=[redacted] end",
  );
});

Deno.test("an incomplete set is never the newest: it shields no complete set and is pruned by age", () => {
  const completeOld = set("2026-10-01T03:00:00Z", 1);
  const completeNewest = set("2026-11-01T03:00:00Z", 2);
  const incompleteRecent = set("2026-11-19T03:00:00Z", 3);
  const incompleteOld = set("2026-10-15T03:00:00Z", 4);
  const names = [completeOld, completeNewest, incompleteRecent, incompleteOld];
  const incomplete = new Set([incompleteRecent, incompleteOld]);
  // The newest COMPLETE set is the one that is never pruned, however old; the
  // newest directory (incomplete) does not take that protection away from it.
  assertEquals(
    selectExpired({
      names,
      now: NOW,
      daysToKeep: 7,
      protect: noProtect,
      incomplete,
    }),
    [completeOld, incompleteOld].sort(),
  );
  // Without the marker knowledge, the newest directory would have been
  // "the newest" and the newest complete set would have been pruned.
  assertEquals(
    selectExpired({ names, now: NOW, daysToKeep: 7, protect: noProtect }),
    [completeOld, completeNewest, incompleteOld].sort(),
  );
  // An incomplete set is prunable by age whatever its position, and a recent
  // one is kept until it is old enough.
  assertEquals(
    selectExpired({
      names: [incompleteRecent, incompleteOld],
      now: NOW,
      daysToKeep: 7,
      protect: noProtect,
      incomplete,
    }),
    [incompleteOld],
  );
  // The set just taken stays protected, and a complete set is never protected
  // by an incomplete one that is newer.
  assertEquals(
    selectExpired({
      names,
      now: NOW,
      daysToKeep: 7,
      protect: new Set([completeOld]),
      incomplete,
    }),
    [incompleteOld],
  );
});
