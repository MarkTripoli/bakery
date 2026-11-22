import { runRunner } from "../../scripts/deploy/backup-runner.ts";

/**
 * The real runner entry with a real WAL pass, for
 * tests/integration/backup-runner-wal-process_test.ts; only the backup step is
 * a stand-in (no backup is claimed in those tests).
 */
Deno.exit(
  await runRunner({
    env: Deno.env.toObject(),
    backupsRoot: Deno.env.get("STUB_BACKUPS_ROOT") ?? "",
    walSpool: Deno.env.get("STUB_WAL_SPOOL") ?? undefined,
    backupEnv: Deno.env.get("STUB_BACKUP_ENV") ?? undefined,
    backup: () =>
      Promise.reject(new Error("no backup is claimed in this test")),
  }),
);
