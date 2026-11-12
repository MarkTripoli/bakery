import { removeTreeSync } from "../../scripts/ci/temp-tree.ts";
import { createSpawnFailureReporter } from "./spawn-capability-report.ts";

/**
 * Preloaded into every test process by `scripts/run-tests.ts` (`--preload`).
 *
 * Tests make temp dirs and files with `Deno.makeTempDir` and friends and, when
 * they fail, time out or simply forget, leave them behind. On the rig host /tmp
 * is RAM-backed, so 43,000 leaked `bakery-*` entries were a memory problem and
 * ended in an ENOSPC for the rig daemon (#242). This wraps the four Deno calls,
 * remembers what they made, and removes it when the process unloads, pass or
 * fail, including a directory a test locked on purpose. It changes nothing a
 * test can observe while it runs: paths, options and results are the originals.
 *
 * It also reports, on stderr, a spawn that the lane's --allow-run refuses (#229).
 *
 * It cannot help a process that is killed outright; the lane runner sweeps the
 * run's own temp root for that, and for anything made another way (Node's
 * `mkdtemp`).
 */
const INSTALLED = Symbol.for("bakery.testTempCleanup");
const holder = globalThis as unknown as Record<symbol, unknown>;

if (holder[INSTALLED] === undefined) {
  holder[INSTALLED] = true;
  const made = new Set<string>();
  const remember = <T extends string>(path: T): T => {
    made.add(path);
    return path;
  };
  const deno = Deno as unknown as Record<string, unknown>;
  const wrap = (name: string, sync: boolean) => {
    const original = (deno[name] as (...args: unknown[]) => unknown).bind(Deno);
    deno[name] = sync
      ? (...args: unknown[]) => remember(original(...args) as string)
      : async (...args: unknown[]) =>
        remember((await original(...args)) as string);
  };
  wrap("makeTempDir", false);
  wrap("makeTempFile", false);
  wrap("makeTempDirSync", true);
  wrap("makeTempFileSync", true);

  // #229: a spawn the lane's --allow-run refuses prints what the process saw
  // (spawn-capability-report.ts), then throws the same error it was going to.
  // Only the failure path changes: results, options and errors are the originals.
  // On the pinned Deno all three methods throw a run refusal synchronously, never
  // as a rejected promise (tests/rails/refused-spawn-report_test.ts covers each).
  const reportRefusedSpawn = createSpawnFailureReporter((text) =>
    console.error(text)
  );
  const command = Deno.Command.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const name of ["output", "outputSync", "spawn"]) {
    const original = command[name];
    if (typeof original !== "function") continue;
    // Written as a method so that, like the native one, it is named `name` and
    // has no `prototype` property.
    command[name] = {
      [name](this: unknown, ...args: unknown[]): unknown {
        try {
          return original.apply(this, args);
        } catch (error) {
          reportRefusedSpawn(error);
          throw error;
        }
      },
    }[name];
  }

  globalThis.addEventListener("unload", () => {
    for (const path of made) {
      try {
        removeTreeSync(path);
      } catch {
        // Not ours to fail the run over; the runner's sweep reports what stays.
      }
    }
  });
}
