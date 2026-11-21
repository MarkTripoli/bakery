import { assertEquals } from "@std/assert";
import { PLUGIN_AUTHORING_KIT_FILES } from "@bakery/contracts/plugin-authoring-kit";
import {
  type ContainmentRuntime,
  memoryResultSink,
  type PluginJobLimits,
  runPluginJob,
} from "../../apps/worker/src/plugin-job-runtime.ts";
import type {
  PluginGenerator,
  PluginGeneratorInput,
  PreviewRunner,
} from "../../apps/server/src/modules/workflows/plugin-authoring/runner.ts";
import {
  call,
  type Fixture,
  memoryStore,
  removeColleagues,
} from "./plugin-pages-fixture.ts";
import { withWorkerFixture } from "./worker-execution/scenarios.ts";

/**
 * Fixtures for prompt-to-private-plugin authoring (#45): a scripted generator
 * that never calls a model, packages built from the kit's example, a preview
 * runner that drives the worker's real job protocol, and the run routes.
 */

export type Files = Record<string, string>;

export const PREVIEW_LIMITS: PluginJobLimits = {
  cpus: 1,
  memoryBytes: 256 * 1024 * 1024,
  pids: 64,
  timeoutMs: 30_000,
  outputBytes: 1024 * 1024,
  lineBytes: 64 * 1024,
};

/** The kit's counter example, with any file replaced or removed. */
export function counterPackage(
  overrides: Record<string, string | undefined> = {},
): Files {
  const files: Files = {
    "manifest.json": PLUGIN_AUTHORING_KIT_FILES["example/manifest.json"],
    "plugin.json": PLUGIN_AUTHORING_KIT_FILES["example/plugin.json"],
    "job.ts": PLUGIN_AUTHORING_KIT_FILES["example/job.ts"],
  };
  for (const [path, content] of Object.entries(overrides)) {
    if (content === undefined) delete files[path];
    else files[path] = content;
  }
  return files;
}

export function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "counter",
    requestedCapabilities: ["state.read", "state.write"],
    stateSchemaVersion: 1,
    stateNamespaces: ["counter"],
    ...overrides,
  });
}

/** A job that does not type-check: a string slot given a number. */
export const TYPE_ERROR_JOB = PLUGIN_AUTHORING_KIT_FILES["example/job.ts"]
  .replace("const count = ", "const label: string = 1;\n  const count = ");

/**
 * Revision 2: stores {n} instead of a bare number (schema 2, reads 1 as saved
 * via its migrate) and counts on from what version 1 left.
 */
export const COUNTER_V2_JOB = `import type { PluginHost } from "./sdk.ts";

async function read(host: PluginHost) {
  const answer = await host.call("state.read", { namespace: "counter", key: "count" });
  if (!answer.ok) throw new Error(answer.denial);
  return answer.result as { value: unknown; casVersion: number };
}

export default async function run(host: PluginHost): Promise<unknown> {
  const found = await read(host);
  const n = typeof found.value === "object" && found.value !== null
    ? Number((found.value as { n: number }).n) + 1
    : 1;
  const written = await host.call("state.write", {
    namespace: "counter",
    key: "count",
    value: { n },
    expectedCasVersion: found.casVersion,
  });
  return written.ok ? { count: n, version: 2 } : { error: written.denial };
}

export async function migrate(
  host: PluginHost,
  fromSchemaVersion: number,
): Promise<unknown> {
  const found = await read(host);
  if (fromSchemaVersion !== 1 || typeof found.value !== "number") {
    return { migrated: false };
  }
  const written = await host.call("state.write", {
    namespace: "counter",
    key: "count",
    value: { n: found.value },
    expectedCasVersion: found.casVersion,
  });
  if (!written.ok) throw new Error(written.denial);
  return { migrated: true };
}
`;

export const COUNTER_V2_MANIFEST = manifest({
  stateSchemaVersion: 2,
  stateCompatibleFrom: 1,
});

/** A revision whose migrate throws after writing: the state must come back. */
export const BROKEN_MIGRATE_JOB = COUNTER_V2_JOB.replace(
  "if (!written.ok) throw new Error(written.denial);\n  return { migrated: true };",
  'throw new Error("migration bug after a write");',
);

/** A revision whose job ends without a result. */
export const CRASHING_JOB = `import type { PluginHost } from "./sdk.ts";

export default async function run(host: PluginHost): Promise<unknown> {
  await host.call("state.write", {
    namespace: "counter",
    key: "count",
    value: 999,
    expectedCasVersion: 1,
  });
  throw new Error("version 3 is broken");
}
`;

export type ScriptedGenerator = PluginGenerator & {
  inputs: PluginGeneratorInput[];
};

/** Hands out the scripted packages in order, repeating the last; never a model. */
export function scriptedGenerator(
  packages: readonly Files[],
  costUsd = 0.01,
): ScriptedGenerator {
  const inputs: PluginGeneratorInput[] = [];
  return {
    modelId: "scripted-test-generator",
    inputs,
    generate(input) {
      inputs.push(input);
      const files = packages[Math.min(inputs.length - 1, packages.length - 1)];
      return Promise.resolve({ files: { ...files }, usage: { costUsd } });
    },
  };
}

/**
 * A runtime for tests on a host without Docker: the job runs as a plain Deno
 * process with no permissions, an empty environment and no network imports.
 * The Docker runtime is the production boundary; this one drives the same
 * protocol code so the host side is exercised exactly.
 */
export function localDenoRuntime(): ContainmentRuntime {
  return {
    name: "local-deno",
    probe: () => Promise.resolve({ supported: true, runtime: "local-deno" }),
    start(spec) {
      const [, ...args] = spec.command;
      const child = new Deno.Command(Deno.execPath(), {
        args,
        cwd: spec.codeDir,
        clearEnv: true,
        env: {
          NO_COLOR: "1",
          HOME: spec.codeDir,
          DENO_DIR: `${spec.codeDir}/.deno`,
          DENO_NO_UPDATE_CHECK: "1",
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const writer = child.stdin.getWriter();
      const encoder = new TextEncoder();
      async function* lines() {
        let buffered = "";
        for await (
          const chunk of child.stdout.pipeThrough(new TextDecoderStream())
        ) {
          buffered += chunk;
          let at;
          while ((at = buffered.indexOf("\n")) >= 0) {
            yield buffered.slice(0, at);
            buffered = buffered.slice(at + 1);
          }
        }
        if (buffered.length > 0) yield buffered;
      }
      let killed = false;
      return Promise.resolve({
        write: (line: string) => writer.write(encoder.encode(line + "\n")),
        lines: lines(),
        exited: child.status.then((status) => ({ code: status.code })),
        async kill() {
          if (killed) return;
          killed = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          await writer.close().catch(() => undefined);
        },
      });
    },
  };
}

/** Deno flags a preview runs with: nothing granted, nothing fetched. */
export const PREVIEW_DENO_FLAGS = [
  "run",
  "--no-remote",
  "--no-npm",
  "--no-config",
  "--no-lock",
  "--no-prompt",
];

/** A preview runner over a containment runtime, using the worker's protocol code. */
export function previewRunner(
  runtime: ContainmentRuntime,
  command: (mode: string) => string[] = (mode) => [
    "deno",
    ...PREVIEW_DENO_FLAGS,
    "runner.ts",
    mode,
  ],
): PreviewRunner & { results: unknown[] } {
  const results: unknown[] = [];
  return {
    results,
    async run(input) {
      const dir = await Deno.makeTempDir({ prefix: "bakery-plugin-preview-" });
      try {
        for (const [path, content] of Object.entries(input.files)) {
          const target = `${dir}/${path}`;
          await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
            recursive: true,
          });
          await Deno.writeTextFile(target, content);
          await Deno.chmod(target, 0o644);
        }
        await Deno.chmod(dir, 0o755);
        const mode = input.mode === "run"
          ? "run"
          : `migrate:${input.mode.migrateFrom}`;
        const end = await runPluginJob({
          runtime,
          spec: {
            name: `bakery-plugin-preview-${crypto.randomUUID()}`,
            codeDir: dir,
            command: command(mode),
            limits: PREVIEW_LIMITS,
          },
          relay: (relayed) =>
            input.relay({
              operation: relayed.operation,
              args: relayed.args,
            }),
          identity: `${input.installId}:preview:${crypto.randomUUID()}`,
          sink: memoryResultSink(),
        });
        if (end.kind === "result") {
          results.push(end.value);
          return { ok: true, result: end.value };
        }
        return { ok: false, reason: `preview_${end.kind}` };
      } finally {
        await Deno.remove(dir, { recursive: true }).catch(() => undefined);
      }
    },
  };
}

export type AuthoringWorld = {
  fixture: Fixture;
  store: ReturnType<typeof memoryStore>;
};

/** A fixture whose app authors with this generator and preview runner. */
export function withAuthoringFixture(
  dependencies: { generator?: PluginGenerator; preview?: PreviewRunner },
  run: (world: AuthoringWorld) => Promise<void>,
): Promise<void> {
  const store = memoryStore();
  return withWorkerFixture(
    async (fixture) => {
      try {
        await run({ fixture, store });
      } finally {
        await removeColleagues(fixture.pgDatabase);
      }
    },
    { skillFileStore: store, pluginAuthoring: dependencies },
  );
}

export function startRun(
  fixture: Fixture,
  body: Record<string, unknown>,
): Promise<Response> {
  return call(fixture, "/v1/plugin-authoring-runs", {
    method: "POST",
    body: {
      request: "Count how many times the job ran, in the counter namespace.",
      authorizedCapabilities: ["state.read", "state.write"],
      budgetUsd: "1.00",
      maxAttempts: 3,
      ...body,
    },
  });
}

/** A run that must be answered 201 (or 200), returned as JSON. */
export async function authored(
  fixture: Fixture,
  body: Record<string, unknown> = {},
) {
  const response = await startRun(fixture, body);
  const text = await response.text();
  assertEquals(response.status < 300, true, text);
  return JSON.parse(text);
}

export async function count(
  fixture: Fixture,
  table: string,
): Promise<number> {
  const result = await fixture.pgDatabase.query<{ n: number }>(
    `select count(*)::int as n from bakery.${table} where organization_id = $1`,
    [fixture.organizationId],
  );
  return result.rows[0].n;
}

/** The install's state rows, exactly, ordered so two reads compare equal. */
export async function stateOf(fixture: Fixture, installId: string) {
  const result = await fixture.pgDatabase.query(
    `select owner_principal_id, namespace, key, schema_version, cas_version,
            value, version
       from bakery.plugin_state
      where organization_id = $1 and plugin_install_id = $2
      order by namespace, key`,
    [fixture.organizationId, installId],
  );
  return result.rows;
}
