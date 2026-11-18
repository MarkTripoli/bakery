import { removeTreeSync } from "../../scripts/ci/temp-tree.ts";
import { mutationSite, recordPathMutation } from "./path-mutation-log.ts";
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
 * It also reports, on stderr, a spawn that the lane's --allow-run refuses (#229)
 * and records every in-process change to PATH, so that report can name what
 * moved the PATH the grant was resolved against.
 *
 * It cannot help a process that is killed outright; the lane runner sweeps the
 * run's own temp root for that, and for anything made another way (Node's
 * `mkdtemp`, or a temp dir made inside a Worker: a Worker has its own global, a
 * preload cannot reach it, so the sweep is what catches those, and says so).
 *
 * What a test can still observe (#253): the wrappers keep each call's `name` and
 * `length`, but are arrow functions, so they have no `prototype` property. The
 * cleanup runs after every unload handler a test registers with
 * `addEventListener("unload")`, because the wrapped `addEventListener` moves it
 * to the end each time one is added; a handler set through `onunload` is not
 * ordered by this.
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
  /** Gives a wrapper the name and length of the function it replaces. */
  const keepShape = (
    wrapper: object,
    source: { name: string; length: number },
  ) => {
    Object.defineProperty(wrapper, "name", {
      value: source.name,
      configurable: true,
    });
    Object.defineProperty(wrapper, "length", {
      value: source.length,
      configurable: true,
    });
  };
  const wrap = (name: string, sync: boolean) => {
    const source = deno[name] as (...args: unknown[]) => unknown;
    const original = source.bind(Deno);
    const wrapper = sync
      ? (...args: unknown[]) => remember(original(...args) as string)
      : async (...args: unknown[]) =>
        remember((await original(...args)) as string);
    keepShape(wrapper, source);
    deno[name] = wrapper;
  };
  wrap("makeTempDir", false);
  wrap("makeTempFile", false);
  wrap("makeTempDirSync", true);
  wrap("makeTempFileSync", true);

  // #229: the lane's grant is resolved against the startup PATH; a spawn
  // resolves against PATH now. Nothing in the tree changes PATH today, so the
  // incident of 2026-11-12 cannot be reproduced — but the next one names its
  // cause instead of costing another hunt. Observation only: the value written,
  // the error thrown and the timing are the caller's.
  const env = Deno.env as unknown as Record<string, unknown>;
  for (const name of ["set", "delete"] as const) {
    const original = (env[name] as (...args: unknown[]) => unknown).bind(
      Deno.env,
    );
    env[name] = {
      [name](...args: unknown[]): unknown {
        if (args[0] === "PATH") {
          try {
            recordPathMutation({
              at: new Date().toISOString(),
              action: name,
              previous: Deno.env.get("PATH"),
              next: name === "set" ? String(args[1]) : undefined,
              site: mutationSite(new Error().stack),
            });
          } catch {
            // A diagnostic never replaces the change it describes.
          }
        }
        return original(...args);
      },
    }[name];
  }

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

  const cleanup = () => {
    for (const path of made) {
      try {
        removeTreeSync(path);
      } catch {
        // Not ours to fail the run over; the runner's sweep reports what stays.
      }
    }
  };
  globalThis.addEventListener("unload", cleanup);
  // Listeners run in the order they were added, and this one is added before
  // any test runs, so it would remove a directory before the test's own unload
  // handler (one that removes it without a try/catch would then throw). Every
  // time another unload listener is added, this one is moved behind it.
  const addEventListener = globalThis.addEventListener.bind(globalThis) as (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  const ordered = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void => {
    addEventListener(type, listener, options);
    if (type === "unload" && listener !== cleanup) {
      globalThis.removeEventListener("unload", cleanup);
      addEventListener("unload", cleanup);
    }
  };
  keepShape(ordered, globalThis.addEventListener);
  globalThis.addEventListener = ordered as typeof globalThis.addEventListener;
}
