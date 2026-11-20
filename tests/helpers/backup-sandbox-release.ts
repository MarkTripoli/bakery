import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Release pieces for the backup and restore script sandboxes, built without a
 * symlink. `Deno.symlink` needs unrestricted write permission, and the
 * integration lane (which these tests belong to, because they spawn bash) only
 * allows writes inside the temporary directory.
 */

/**
 * `$root/background/scripts/deploy/backup-manifest.ts`, as a one-line module
 * that runs the repository's real command line: the module executes on import
 * and reads the same arguments, so the script under test sees a release
 * checkout without one being linked in.
 */
export async function installReleaseManifestShim(
  opt: string,
  repo: string,
): Promise<void> {
  const directory = join(opt, "background/scripts/deploy");
  await Deno.mkdir(directory, { recursive: true });
  const real =
    pathToFileURL(join(repo, "scripts/deploy/backup-manifest.ts")).href;
  await Deno.writeTextFile(
    join(directory, "backup-manifest.ts"),
    `import ${JSON.stringify(real)};\n`,
  );
}

/** A `deno` on the sandbox PATH that runs the real Deno binary. */
export async function installDenoWrapper(bin: string): Promise<void> {
  await Deno.writeTextFile(
    join(bin, "deno"),
    `#!/bin/sh\nexec ${JSON.stringify(Deno.execPath())} "$@"\n`,
    { mode: 0o755 },
  );
}
