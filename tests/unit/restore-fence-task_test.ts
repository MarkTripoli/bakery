import { assertEquals, assertThrows } from "@std/assert";
import { parseRestoreFenceArgs } from "../../apps/server/src/platform/restore-fence-task.ts";

/**
 * #64 slice E1: the restore-fence task refuses a bad argument before it opens
 * the database, because it runs as the database owner with every service down.
 */

Deno.test("a backup name alone, or with a cutoff, is accepted", () => {
  assertEquals(
    parseRestoreFenceArgs(["--backup-name", "20261121T030000Z-0b6c"]),
    {
      backupName: "20261121T030000Z-0b6c",
      cutoffAt: null,
    },
  );
  assertEquals(
    parseRestoreFenceArgs([
      "--cutoff-at",
      "2026-11-21T03:00:05.123Z",
      "--backup-name",
      "set-1",
    ]),
    { backupName: "set-1", cutoffAt: "2026-11-21T03:00:05.123Z" },
  );
});

Deno.test("a missing, odd or path-like backup name is refused", () => {
  for (
    const args of [
      [],
      ["--backup-name"],
      ["--backup-name", ""],
      ["--backup-name", "../etc/passwd"],
      ["--backup-name", "a b"],
      ["--backup-name", "x".repeat(129)],
    ]
  ) {
    assertThrows(
      () => parseRestoreFenceArgs(args),
      Error,
      args.length === 0 || args[1] === undefined
        ? "RESTORE_FENCE_"
        : "RESTORE_FENCE_BACKUP_NAME_INVALID",
    );
  }
});

Deno.test("an unknown option or a cutoff that is not a UTC instant is refused", () => {
  assertThrows(
    () => parseRestoreFenceArgs(["--backup-name", "set-1", "--force"]),
    Error,
    "RESTORE_FENCE_ARGUMENT_INVALID",
  );
  for (
    const cutoff of [
      "yesterday",
      "2026-11-21 03:00:05",
      "2026-11-21T03:00:05+01:00",
    ]
  ) {
    assertThrows(
      () =>
        parseRestoreFenceArgs([
          "--backup-name",
          "set-1",
          "--cutoff-at",
          cutoff,
        ]),
      Error,
      "RESTORE_FENCE_CUTOFF_INVALID",
    );
  }
});
