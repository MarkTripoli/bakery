// A host copy of infra/draft-worker/launch.sh for tests: the same script with
// its pinned locations pointed at this checkout, the host Deno cache and,
// optionally, a fixture worker or a recording stand-in for Deno.
const source = new URL("../../infra/draft-worker/launch.sh", import.meta.url);

export type LauncherOptions = {
  /** The worker module the copy starts (default: the real worker). */
  workerPath?: string;
  /** Replaces `/usr/bin/deno` (default: this Deno). */
  denoPath?: string;
  /** A shell line run first, before any validation (for recording). */
  prelude?: string;
};

export async function launcherCopy(
  options: LauncherOptions = {},
): Promise<{ path: string; directory: string; cleanup(): Promise<void> }> {
  const home = Deno.env.get("HOME") ?? "/tmp";
  const denoDir = Deno.env.get("DENO_DIR") ?? `${home}/.cache/deno`;
  const worker = options.workerPath ??
    new URL(
      "../../apps/server/src/modules/knowledge/draft-import-worker.ts",
      import.meta.url,
    ).pathname;
  let text = await Deno.readTextFile(source);
  const replace = (from: RegExp, to: string) => {
    if (!from.test(text)) throw new Error(`LAUNCHER_COPY_PATTERN ${from}`);
    text = text.replace(from, to);
  };
  replace(/^WORKER_MODULE=.*$/m, `WORKER_MODULE='${worker}'`);
  replace(/^WORKER_DENO_DIR=.*$/m, `WORKER_DENO_DIR='${denoDir}'`);
  replace(/^WORKER_HOME=.*$/m, `WORKER_HOME='${home}'`);
  replace(
    /^ {2}\/usr\/bin\/deno run \\$/m,
    `  '${options.denoPath ?? Deno.execPath()}' run \\`,
  );
  if (options.prelude) {
    replace(/^#!\/bin\/sh\n/, `#!/bin/sh\n${options.prelude}\n`);
  }
  const directory = await Deno.makeTempDir({ prefix: "bakery-draft-launch-" });
  const path = `${directory}/launch.sh`;
  await Deno.writeTextFile(path, text);
  await Deno.chmod(path, 0o700);
  return {
    path,
    directory,
    cleanup: () => Deno.remove(directory, { recursive: true }),
  };
}
