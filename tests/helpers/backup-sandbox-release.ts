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

/**
 * A directory of wrappers for every system tool except `deno`, so a test that
 * needs "Deno is not installed" does not depend on whether the host has
 * /usr/bin/deno (a dev or CI host may). Scripts, not links, for the reason
 * above.
 */
export async function toolsWithoutDeno(dir: string): Promise<string> {
  const tools = join(dir, "tools-without-deno");
  await Deno.mkdir(tools);
  const seen = new Set<string>(["deno"]);
  for (const source of ["/usr/bin", "/bin"]) {
    for await (const entry of Deno.readDir(source)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      await Deno.writeTextFile(
        join(tools, entry.name),
        `#!/bin/sh\nexec ${JSON.stringify(join(source, entry.name))} "$@"\n`,
        { mode: 0o755 },
      );
    }
  }
  return tools;
}
