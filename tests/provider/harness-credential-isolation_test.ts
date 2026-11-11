import { assert, assertEquals, assertFalse } from "@std/assert";
import { join, relative } from "node:path";
import {
  assertBoundedRedactedCapture,
  assertCompletedConformance,
  CONFORMANCE_ADAPTERS,
  CONFORMANCE_TEST_OPTIONS,
  type ConformanceAdapter,
  type ConformanceRun,
  FAKE_NATIVE_SESSION_ID,
  fakeAuthBytes,
  withConformanceRun,
} from "../helpers/harness-conformance.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";

/**
 * Credential isolation, generalized over Codex, Claude Code and Pi. Every case
 * runs the `isolation-probe` fake: it dumps its environment, records which
 * decoy auth files under HOME it can read, lists its adapter state dir, plants
 * its auth file where retention would copy it, and completes.
 */

const AUTH_NAMES = ["auth.json", ".credentials.json"];
const SHELL_NOISE = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
const PARENT_ENV = [
  "BAKERY_WORKER_ENROLLMENT_TOKEN",
  "BAKERY_SERVER_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
] as const;
const DIRECTORY_ENV = new Set([
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
]);

type ParentSecret = {
  readonly name: string;
  readonly value: string;
  readonly bytes: string;
};

/** Sets decoy control-plane and credential variables; restores them in `finally`. */
async function withParentSecrets(
  body: (secrets: readonly ParentSecret[]) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "bakery-isolation-parent-" });
  const previous = new Map<string, string | undefined>();
  const secrets: ParentSecret[] = [];
  try {
    for (const name of PARENT_ENV) {
      previous.set(name, Deno.env.get(name));
      const bytes = `PARENT_SENTINEL_${name}_${crypto.randomUUID()}`;
      let value = bytes;
      if (DIRECTORY_ENV.has(name)) {
        value = join(root, name);
        await Deno.mkdir(value, { recursive: true });
        await Deno.writeTextFile(join(value, "auth.json"), bytes);
        await Deno.writeTextFile(join(value, ".credentials.json"), bytes);
      }
      Deno.env.set(name, value);
      secrets.push({ name, value, bytes });
    }
    await body(secrets);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}

/** Every regular file under `root`, relative path to bytes. */
async function walkFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(directory)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile) {
        files.set(relative(root, path), await Deno.readTextFile(path));
      }
    }
  };
  await visit(root);
  return files;
}

function parseEnv(dump: string): Map<string, string> {
  const variables = new Map<string, string>();
  for (const line of dump.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) {
      variables.set(line.slice(0, equals), line.slice(equals + 1));
    }
  }
  return variables;
}

function otherAuthFile(adapter: ConformanceAdapter): string {
  return adapter.authFile === "auth.json" ? ".credentials.json" : "auth.json";
}

/** Checkpoint that makes Claude retain session state even for a fresh run. */
function retentionAssignment(
  assignment: JobAssignment,
  baseSha: string,
): JobAssignment {
  return {
    ...assignment,
    currentCheckpoints: [{
      agentSessionId: assignment.agentSessionId,
      nativeSessionId: FAKE_NATIVE_SESSION_ID,
      worktreeRevision: baseSha,
      checkpoint: "isolation-checkpoint-1",
    }],
  } as unknown as JobAssignment;
}

/** Decoy source files that must never be copied into the child's state dir. */
async function writeDecoys(
  adapter: ConformanceAdapter,
  markers: string,
): Promise<void> {
  const source = join(markers, "auth-source");
  await Deno.writeTextFile(join(source, "settings.json"), "DECOY_SETTINGS");
  await Deno.writeTextFile(join(source, "history.jsonl"), "DECOY_HISTORY\n");
  await Deno.writeTextFile(
    join(source, otherAuthFile(adapter)),
    "DECOY_OTHER_HARNESS_AUTH",
  );
}

const fresh = (secrets: readonly ParentSecret[]) =>
  secrets.flatMap((secret) => [secret.value, secret.bytes]);

function assertNoneOf(text: string, needles: readonly string[], where: string) {
  for (const needle of needles) {
    assertFalse(text.includes(needle), `${where} carries ${needle}`);
  }
}

for (const adapter of CONFORMANCE_ADAPTERS) {
  Deno.test({
    name:
      `[${adapter.name}] child env is the cleared allowlist, with no parent secret`,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      await withParentSecrets(async (secrets) => {
        await withConformanceRun(
          adapter,
          "isolation-probe",
          { prepare: ({ markers }) => writeDecoys(adapter, markers) },
          async (run) => {
            await assertCompletedConformance(run);
            const dump = await Deno.readTextFile(join(run.markers, "env"));
            const variables = parseEnv(dump);
            for (const name of SHELL_NOISE) variables.delete(name);
            // HOME is always the attempt's isolated home; TMPDIR passes
            // through only when the parent has it.
            const expected = new Set(["PATH", "DENO_DIR", "HOME"]);
            if (Deno.env.get("TMPDIR") !== undefined) expected.add("TMPDIR");
            expected.add(adapter.stateEnv);
            assertEquals([...variables.keys()].sort(), [...expected].sort());
            const home = variables.get("HOME")!;
            assert(
              home.startsWith(join(run.markers, "state") + "/"),
              `${home} is not under the worker state dir`,
            );
            assert(
              home !== Deno.env.get("HOME"),
              "child inherited parent HOME",
            );
            // The adapter's own state variable is rewritten, never inherited.
            const inherited = secrets.filter((secret) =>
              secret.name !== adapter.stateEnv
            );
            assertNoneOf(dump, fresh(inherited), "child env");
            for (const secret of secrets) {
              if (secret.name === adapter.stateEnv) {
                assert(variables.get(adapter.stateEnv!) !== secret.value);
              }
            }
          },
        );
      });
    },
  });

  Deno.test({
    name:
      `[${adapter.name}] adapter state dir is private, minimal and removed after the run`,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      await withConformanceRun(
        adapter,
        "isolation-probe",
        {
          prepare: ({ markers }) => writeDecoys(adapter, markers),
          assignmentFor: retentionAssignment,
        },
        async (run) => {
          await assertCompletedConformance(run);
          const stateRoot = join(run.markers, "state");
          const env = parseEnv(
            await Deno.readTextFile(join(run.markers, "env")),
          );
          const stateDir = env.get(adapter.stateEnv)!;
          const home = env.get("HOME")!;
          assert(
            stateDir.startsWith(stateRoot + "/"),
            `${stateDir} is not under the worker state dir`,
          );
          assertFalse(
            stateDir.startsWith(join(run.markers, "auth-source")),
            "the child must not run inside the credential source",
          );
          assertEquals(
            (await Deno.readTextFile(join(run.markers, "state-mode"))).trim(),
            "700",
          );
          // The child sees exactly the auth allowlist; decoys stay behind.
          const listing = (await Deno.readTextFile(
            join(run.markers, "state-listing"),
          )).split("\n").filter(Boolean);
          assertEquals(listing, [`./${adapter.authFile}`]);
          // The per-attempt directories are gone once the run returns.
          for (const path of [stateDir, home]) {
            await Deno.stat(path).then(
              () => assert(false, `${path} survived the run`),
              () => undefined,
            );
          }
        },
      );
    },
  });

  Deno.test({
    name:
      `[${adapter.name}] retained state holds no auth file and no secret bytes`,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      await withParentSecrets(async (secrets) => {
        await withConformanceRun(
          adapter,
          "isolation-probe",
          {
            prepare: ({ markers }) => writeDecoys(adapter, markers),
            assignmentFor: retentionAssignment,
          },
          async (run) => {
            await assertCompletedConformance(run);
            const retained = await walkFiles(join(run.markers, "state"));
            if (adapter.resumeFlag === undefined) {
              assertEquals(retained.size, 0, "codex retains no adapter state");
              return;
            }
            assert(retained.size > 0, "the adapter retained no session state");
            for (const [path, bytes] of retained) {
              const name = path.split("/").pop()!;
              assertFalse(
                AUTH_NAMES.includes(name),
                `auth file retained at ${path}`,
              );
              assertNoneOf(
                bytes,
                [
                  run.sentinel,
                  fakeAuthBytes(run.sentinel),
                  "DECOY_SETTINGS",
                  "DECOY_HISTORY",
                  "DECOY_OTHER_HARNESS_AUTH",
                  ...fresh(secrets),
                ],
                `retained file ${path}`,
              );
            }
          },
        );
      });
    },
  });

  Deno.test({
    name:
      `[${adapter.name}] capture and outcome carry no sentinel or credential`,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      await withParentSecrets(async (secrets) => {
        await withConformanceRun(
          adapter,
          "isolation-probe",
          { prepare: ({ markers }) => writeDecoys(adapter, markers) },
          async (run) => {
            await assertCompletedConformance(run);
            await assertBoundedRedactedCapture(run);
            const persisted = JSON.stringify(run.fixture.spool.records());
            const outcome = JSON.stringify(run.outcome);
            const needles = [
              run.sentinel,
              fakeAuthBytes(run.sentinel),
              "DECOY_OTHER_HARNESS_AUTH",
              ...fresh(secrets),
            ];
            assertNoneOf(persisted, needles, "native output");
            assertNoneOf(outcome, needles, "outcome");
          },
        );
      });
    },
  });
}

/**
 * The operator's real HOME holds auth files for every harness. A child gets an
 * isolated per-attempt HOME instead, so none of them is reachable through any
 * CLI lookup path (#418). Absolute-path reads by a same-uid process stay an OS
 * sandbox concern (docs/technical-design/05-runtime-and-protocols.md).
 */
const HOME_AUTH_FILES = [
  [".codex/auth.json", "codex"],
  [".claude/.credentials.json", "claude"],
  [".pi/agent/auth.json", "pi"],
] as const;

for (const adapter of CONFORMANCE_ADAPTERS) {
  Deno.test({
    name:
      `[${adapter.name}] HOME is the attempt's isolated home and exposes no operator credential`,
    ...CONFORMANCE_TEST_OPTIONS,
    fn: async () => {
      const home = await Deno.makeTempDir({ prefix: "bakery-isolation-home-" });
      const previous = Deno.env.get("HOME");
      const decoys: string[] = [];
      try {
        for (const [path, owner] of HOME_AUTH_FILES) {
          const bytes = `HOME_DECOY_${owner}_${crypto.randomUUID()}`;
          decoys.push(bytes);
          await Deno.mkdir(join(home, path, ".."), { recursive: true });
          await Deno.writeTextFile(join(home, path), bytes);
        }
        Deno.env.set("HOME", home);
        await withConformanceRun(
          adapter,
          "isolation-probe",
          {
            prepare: ({ markers }) => writeDecoys(adapter, markers),
            assignmentFor: retentionAssignment,
          },
          async (run: ConformanceRun) => {
            await assertCompletedConformance(run);
            const childHome = (await Deno.readTextFile(
              join(run.markers, "home"),
            )).trim().replace(/^home:/, "");
            assert(childHome !== home, "child HOME is the operator HOME");
            assert(childHome.startsWith(join(run.markers, "state") + "/"));
            // Nothing under the operator HOME is readable through the child's.
            const readable = await Deno.readTextFile(
              join(run.markers, "home-readable"),
            ).catch(() => "");
            assertEquals(readable.trim(), "", "an operator credential leaked");
            // The isolated home is gone once the run returns.
            await Deno.stat(childHome).then(
              () => assert(false, `${childHome} survived the run`),
              () => undefined,
            );
            // Bytes stay out of every durable surface.
            await assertBoundedRedactedCapture(run);
            const surfaces = [
              JSON.stringify(run.outcome),
              JSON.stringify(run.fixture.spool.records()),
              ...(await walkFiles(join(run.markers, "state"))).values(),
            ].join("\n");
            assertNoneOf(surfaces, decoys, "durable output");
          },
        );
      } finally {
        if (previous === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", previous);
        await Deno.remove(home, { recursive: true }).catch(() => undefined);
      }
    },
  });
}
