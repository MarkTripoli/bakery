import {
  describeProblems,
  IncompleteBackup,
  type KeyIdentity,
  verifyBackupDirectory,
  writeBackupManifest,
} from "./backup-runner/manifest.ts";

/**
 * Command line for the backup manifest (issue #64, slice A), called by
 * backup.sh and restore-check.sh.
 *
 *   backup-manifest.ts build <directory> --started <ISO time>
 *       (--key-id <id> | --no-key | --key-failed <reason>)
 *       --skill-files <n> --blobs <n> [--failed <store>=<reason>]...
 *   backup-manifest.ts verify <directory> [--allow-legacy]
 *
 * Exit 0: done (build wrote the manifest; verify found a complete set, or a
 * legacy set with --allow-legacy). Exit 70: the set is incomplete, with
 * `BACKUP_INCOMPLETE <problems>` on stderr. Exit 64: bad arguments.
 */

function fail(message: string, code = 64): never {
  console.error(message);
  Deno.exit(code);
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
    });
    if (result.complete) {
      console.log("BACKUP_COMPLETE");
      return;
    }
    if (result.legacy && rest.includes("--allow-legacy")) {
      console.error(
        "BACKUP_LEGACY_SET this set has no manifest; accepted because --allow-legacy was given",
      );
      return;
    }
    console.error(`BACKUP_INCOMPLETE ${describeProblems(result.problems)}`);
    Deno.exit(70);
  }
  if (command === "build") {
    const started = new Date(flag(rest, "--started") ?? "");
    if (Number.isNaN(started.getTime())) {
      fail("BACKUP_MANIFEST_USAGE --started must be an ISO time");
    }
    let key: KeyIdentity;
    const keyId = flag(rest, "--key-id");
    const keyFailed = flag(rest, "--key-failed");
    if (keyId !== undefined) key = { state: "configured", id: keyId };
    else if (keyFailed !== undefined) {
      key = { state: "failed", reason: keyFailed };
    } else if (rest.includes("--no-key")) key = { state: "unconfigured" };
    else fail("BACKUP_MANIFEST_USAGE one of --key-id, --no-key, --key-failed");
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
      });
    } catch (error) {
      if (error instanceof IncompleteBackup) {
        console.error(error.message);
        Deno.exit(70);
      }
      throw error;
    }
    return;
  }
  fail("BACKUP_MANIFEST_USAGE the command is build or verify");
}

await main(Deno.args);
