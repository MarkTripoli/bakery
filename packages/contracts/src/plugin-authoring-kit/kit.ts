/**
 * The pinned plugin authoring kit (#45, B14.04).
 *
 * What a generator is shown when it is asked to write a backend plugin, and the
 * two host-owned files every authored package runs with. The kit is data with a
 * digest: an authoring run records the digest it used, so a version can always
 * be traced to the exact instructions that produced it. Changing a byte here
 * changes the digest, and a unit test pins it, so a kit change is a deliberate,
 * reviewed edit rather than a drift.
 *
 * The files live in this module rather than as loose files on disk so the
 * server never needs a read grant to load them and the bytes the digest covers
 * are the bytes the generator sees.
 */
import { createHash } from "node:crypto";

/** The guide a generator reads first. */
const SKILL = `# Writing a Bakery backend plugin

A backend plugin is a small package of TypeScript that Bakery runs as a job in
a sealed runtime. It has no network, no files and no environment. The only way
it can affect anything is by asking the host to perform an operation, and the
host performs it only when the install holds the matching grant.

## Files you write

- manifest.json: the plugin manifest (see sdk-reference.md). Ask only for the
  capabilities the request needs; asking for more than the person authorized
  fails the authority check and nothing is published.
- plugin.json: {"sdkRange": "^1.0.0"}, the plugin SDK range you target.
- job.ts: the job. Its default export is the job, and an optional named export
  migrate moves saved state forward when a revision changes its shape.
- Any other .ts file job.ts imports, by a relative path ("./util.ts").

Do not write sdk.ts or runner.ts: the host supplies them.

## The job

    import type { PluginHost } from "./sdk.ts";

    export default async function run(host: PluginHost): Promise<unknown> {
      const read = await host.call("state.read", { namespace: "counter", key: "count" });
      // ...
      return { done: true };
    }

A revision that raises stateSchemaVersion must export migrate. The host runs
it once, right after the install moves to the new version and before the job,
with the schema the old version wrote; if it throws, the install goes back to
the old version with the state it had.

The value the job returns is its one result. Each host.call is one line on
stdout ({"call": {...}}) answered by one line on stdin; runner.ts does that for
you.

## Operations

- state.read {namespace, key}: answers {found, value, casVersion}. casVersion
  is 0 when the key has never been written.
- state.write {namespace, key, value, expectedCasVersion}: writes when the key
  is still at expectedCasVersion and answers {casVersion}. A stale
  expectedCasVersion is refused.

The namespace must be one the manifest declares in stateNamespaces. An
operation the install is not granted answers {ok: false, denial: "not_granted"}.

## Rules the checks enforce

1. Relative POSIX paths only, at most 64 files and 1 MiB in total.
2. manifest.json must parse and plugin.json's sdkRange must accept the host SDK.
3. requestedCapabilities must be within what the person authorized.
4. No Deno, fetch(, XMLHttpRequest, WebSocket, process., eval, new Function,
   globalThis, Reflect, constructor, require( or import(; imports only of
   files in this package, by a relative path that stays inside it. This scan
   is defense in depth: the sandbox the job runs in (no network, no files, no
   environment) is the boundary, whatever the source manages to spell.
5. The package must type-check with deno check, offline.
6. The job must run in a private preview and return a result.

## Limits

One CPU, 256 MiB of memory, 64 processes, 60 seconds, 1 MiB of output and
64 KiB per protocol line.
`;

/** The SDK surface: the manifest and the job contract, as the host reads them. */
const SDK_REFERENCE = `# Plugin SDK reference (SDK 1.0.0)

## manifest.json

Strict: an unknown key is refused.

- name: lowercase name, at most 64 characters.
- requestedCapabilities: list from state.read, state.write, ui.page, ui.panel,
  commands.run, tools.invoke, jobs.schedule.
- locales: optional list of locale namespaces; none may start with "bakery.".
- stateSchemaVersion: positive integer, default 1. The shape of the state this
  version writes.
- stateCompatibleFrom: optional, at most stateSchemaVersion. The oldest saved
  shape this version reads as it was saved. A revision that cannot read the old
  shape exports migrate.
- stateNamespaces: the namespaces the job reads and writes.
- pages: not used by backend plugins.

## plugin.json

- sdkRange: a range such as ^1.0.0. A bare version pins exactly.

## job.ts

    export default async function run(host: PluginHost): Promise<unknown>;
    export async function migrate(host: PluginHost, fromSchemaVersion: number): Promise<unknown>;

## Protocol (handled by runner.ts)

Job to host: {"call": {"requestId", "sequence", "operation", "args"}} or
{"result": value}. Host to job: {"requestId", "ok": true, "result"} or
{"requestId", "ok": false, "denial"}.
`;

/** Host-owned types the job imports. */
export const PLUGIN_SDK_SOURCE =
  `/** Types the host supplies to a backend plugin job (SDK 1.0.0). */
export type PluginCallResult =
  | { ok: true; result: unknown }
  | { ok: false; denial: string };

export interface PluginHost {
  call(
    operation: "state.read" | "state.write",
    args: Record<string, unknown>,
  ): Promise<PluginCallResult>;
}

export type PluginJob = (host: PluginHost) => Promise<unknown>;

export type PluginMigrate = (
  host: PluginHost,
  fromSchemaVersion: number,
) => Promise<unknown>;
`;

/**
 * Host-owned entry point: speaks the line protocol and calls the job. It is the
 * only file that touches Deno, which is why a generated package may not.
 */
export const PLUGIN_RUNNER_SOURCE = `import * as plugin from "./job.ts";
import type { PluginHost, PluginJob, PluginMigrate } from "./sdk.ts";

const encoder = new TextEncoder();
const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream())
  .getReader();
let buffered = "";

async function readLine(): Promise<string> {
  while (!buffered.includes("\\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("host closed the channel");
    buffered += chunk.value;
  }
  const at = buffered.indexOf("\\n");
  const line = buffered.slice(0, at);
  buffered = buffered.slice(at + 1);
  return line;
}

async function send(message: unknown): Promise<void> {
  await Deno.stdout.write(encoder.encode(JSON.stringify(message) + "\\n"));
}

let sequence = 0;
const host: PluginHost = {
  async call(operation, args) {
    sequence += 1;
    const requestId = "r" + sequence;
    await send({ call: { requestId, sequence, operation, args } });
    const reply = JSON.parse(await readLine());
    return reply.ok === true
      ? { ok: true, result: reply.result }
      : { ok: false, denial: String(reply.denial) };
  },
};

const run: PluginJob = plugin.default;
const mode = Deno.args[0] ?? "run";
let value: unknown;
if (mode.startsWith("migrate:")) {
  const migrate = (plugin as Record<string, unknown>).migrate as
    | PluginMigrate
    | undefined;
  if (typeof migrate !== "function") throw new Error("job exports no migrate");
  value = await migrate(host, Number(mode.slice("migrate:".length)));
} else {
  value = await run(host);
}
await send({ result: value ?? null });
`;

const EXAMPLE_MANIFEST = `{
  "name": "counter",
  "requestedCapabilities": ["state.read", "state.write"],
  "stateSchemaVersion": 1,
  "stateNamespaces": ["counter"]
}
`;

const EXAMPLE_PLUGIN = `{ "sdkRange": "^1.0.0" }
`;

const EXAMPLE_JOB = `import type { PluginHost } from "./sdk.ts";

export default async function run(host: PluginHost): Promise<unknown> {
  const read = await host.call("state.read", {
    namespace: "counter",
    key: "count",
  });
  if (!read.ok) return { error: read.denial };
  const found = read.result as { value: unknown; casVersion: number };
  const count = typeof found.value === "number" ? found.value + 1 : 1;
  const written = await host.call("state.write", {
    namespace: "counter",
    key: "count",
    value: count,
    expectedCasVersion: found.casVersion,
  });
  return written.ok ? { count } : { error: written.denial };
}
`;

/** The file a generated package may not write: the host supplies each. */
export const HOST_OWNED_FILES: Readonly<Record<string, string>> = Object.freeze(
  {
    "sdk.ts": PLUGIN_SDK_SOURCE,
    "runner.ts": PLUGIN_RUNNER_SOURCE,
  },
);

/** Every file the kit carries, by path; what the generator is shown. */
export const PLUGIN_AUTHORING_KIT_FILES: Readonly<Record<string, string>> =
  Object.freeze({
    "SKILL.md": SKILL,
    "sdk-reference.md": SDK_REFERENCE,
    "sdk.ts": PLUGIN_SDK_SOURCE,
    "runner.ts": PLUGIN_RUNNER_SOURCE,
    "example/manifest.json": EXAMPLE_MANIFEST,
    "example/plugin.json": EXAMPLE_PLUGIN,
    "example/job.ts": EXAMPLE_JOB,
  });

/**
 * SHA-256 of the kit: each path and its bytes, in path order, length-prefixed so
 * moving bytes from one file to the next cannot keep the same digest.
 */
export function digestKit(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    hash.update(`${path.length}:${path}${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

/** Computed once when the module loads, from the bytes above. */
export const PLUGIN_AUTHORING_KIT_DIGEST: string = digestKit(
  PLUGIN_AUTHORING_KIT_FILES,
);
