import process from "node:process";
import {
  type Cutoff,
  parseCutoff,
} from "../../apps/server/src/modules/backups/cutoff-rules.ts";
import {
  describeProblems,
  IncompleteBackup,
  type KeyIdentity,
  readKeyFingerprint,
  verifyBackupDirectory,
  writeBackupManifest,
} from "./backup-runner/manifest.ts";

/**
 * Command line for the backup manifest (issue #64, slice A), called by
 * backup.sh and restore-check.sh.
 *
 *   backup-manifest.ts build <directory> --started <ISO time>
 *       (--key-id <id> --key-file <path> | --no-key | --key-failed <reason>)
 *       --skill-files <n> --blobs <n> [--failed <store>=<reason>]...
 *       [--cutoff-json <json>]
 *   backup-manifest.ts verify <directory> [--allow-legacy] [--key-file <path>]
 *       [--require-database-cutoff] [--show-cutoff]
 *
 * --cutoff-json is the database cutoff the runner took while the installation
 * was quiet (see cutoff-rules.ts). Without it the cutoff is the host clock at
 * --started, marked as weaker. A cutoff that does not parse, or that is not a
 * database cutoff, fails the build with exit 70 and nothing is written.
 *
 * The key file is read once, only to compute its fingerprint (see
 * keyFingerprint in manifest.ts); its bytes are never copied, printed or kept.
 *
 * Exit 0: done (build wrote the manifest; verify found a complete set, or a
 * legacy set with --allow-legacy). Exit 70: the set is incomplete, with
 * `BACKUP_INCOMPLETE <problems>` on stderr. Exit 64: bad arguments.
 */

function fail(message: string, code = 64): never {
  console.error(message);
  process.exit(code);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`BACKUP_MANIFEST_USAGE ${name} needs a value`);
  }
  return value;
}

function count(value: string | undefined, name: string): number {
  if (value === undefined || !/^[0-9]{1,12}$/.test(value)) {
    fail(`BACKUP_MANIFEST_USAGE ${name} must be a whole number`);
  }
  return Number(value);
}

async function main(args: string[]): Promise<void> {
  const [command, directory, ...rest] = args;
  if (!directory) fail("BACKUP_MANIFEST_USAGE a backup directory is required");
  if (command === "verify") {
    const result = await verifyBackupDirectory(directory, {
      allowLegacy: rest.includes("--allow-legacy"),
      keyFile: flag(rest, "--key-file"),
      requireDatabaseCutoff: rest.includes("--require-database-cutoff"),
    });
    if (result.complete) {
      console.log("BACKUP_COMPLETE");
      if (rest.includes("--show-cutoff")) {
        console.log(
          result.cutoff
            ? `BACKUP_CUTOFF ${result.cutoff.source} ${result.cutoff.at}`
            : "BACKUP_CUTOFF none",
        );
      }
      return;
    }
    if (result.legacy && rest.includes("--allow-legacy")) {
      console.error(
        "BACKUP_LEGACY_SET this set has no manifest; accepted because --allow-legacy was given",
      );
      return;
    }
    console.error(`BACKUP_INCOMPLETE ${describeProblems(result.problems)}`);
    process.exit(70);
  }
  if (command === "build") {
    const started = new Date(flag(rest, "--started") ?? "");
    if (Number.isNaN(started.getTime())) {
      fail("BACKUP_MANIFEST_USAGE --started must be an ISO time");
    }
    let key: KeyIdentity;
    const keyId = flag(rest, "--key-id");
    const keyFailed = flag(rest, "--key-failed");
    if (keyId !== undefined) {
      const keyFile = flag(rest, "--key-file");
      if (keyFile === undefined) {
        fail("BACKUP_MANIFEST_USAGE --key-id needs --key-file");
      }
      try {
        key = {
          state: "configured",
          id: keyId,
          fingerprint: await readKeyFingerprint(keyFile),
        };
      } catch {
        // Say nothing about the file beyond that it could not be read.
        key = {
          state: "failed",
          reason: "the secrets key file cannot be read",
        };
      }
    } else if (keyFailed !== undefined) {
      key = { state: "failed", reason: keyFailed };
    } else if (rest.includes("--no-key")) key = { state: "unconfigured" };
    else fail("BACKUP_MANIFEST_USAGE one of --key-id, --no-key, --key-failed");
    let cutoff: Cutoff | undefined;
    const cutoffJson = flag(rest, "--cutoff-json");
    if (cutoffJson !== undefined) {
      let value: unknown;
      try {
        value = JSON.parse(cutoffJson);
      } catch {
        console.error("BACKUP_INCOMPLETE the cutoff is not valid JSON");
        process.exit(70);
      }
      const parsed = parseCutoff(value);
      if (typeof parsed === "string" || parsed.source !== "database") {
        console.error(
          `BACKUP_INCOMPLETE the cutoff is invalid: ${
            typeof parsed === "string"
              ? parsed
              : "only a database cutoff may be supplied"
          }`,
        );
        process.exit(70);
      }
      cutoff = parsed;
    }
    const failed: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] !== "--failed") continue;
      const pair = rest[i + 1] ?? "";
      const at = pair.indexOf("=");
      if (at < 1) fail("BACKUP_MANIFEST_USAGE --failed needs <store>=<reason>");
      failed[pair.slice(0, at)] = pair.slice(at + 1);
    }
    try {
      await writeBackupManifest({
        directory,
        startedAt: started,
        finishedAt: new Date(),
        key,
        references: {
          skillFiles: count(flag(rest, "--skill-files"), "--skill-files"),
          blobs: count(flag(rest, "--blobs"), "--blobs"),
        },
        failed,
        cutoff,
      });
    } catch (error) {
      if (error instanceof IncompleteBackup) {
        console.error(error.message);
        process.exit(70);
      }
      throw error;
    }
    return;
  }
  fail("BACKUP_MANIFEST_USAGE the command is build or verify");
}

await main(process.argv.slice(2));
