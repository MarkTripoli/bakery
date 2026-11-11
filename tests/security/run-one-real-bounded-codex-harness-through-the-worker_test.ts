import { assert, assertEquals } from "@std/assert";
import { createCodexHarnessExecutor } from "../../apps/worker/src/codex-harness.ts";
import { codexHarnessAvailable } from "../helpers/codex-harness.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import {
  CapturingOutputSink,
  codexExecutablePath,
  codexProcessesAlive,
  gitText,
  operatorCodexAuthSource,
  prepareScratchRepository,
} from "../helpers/codex-harness.ts";
import { syntheticAuthSource } from "../helpers/harness-auth.ts";
import { nativeCaptureFixture } from "../helpers/harness-conformance.ts";

const RUN_PERMISSIONS = {
  sanitizeResources: false,
  sanitizeOps: false,
} as const;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A contract-valid v1 repository profile pinned to the scratch worktree. */
async function repositoryProfile() {
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  return {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    revision: 1,
    digest: await sha256Hex(new TextEncoder().encode(canonicalJson(config))),
    config,
    observationId: null,
    observationDigest: null,
    baseSha: null,
  };
}

async function completedAssignment(
  overrides: Record<string, unknown> = {},
): Promise<JobAssignment> {
  const assignment = localAssignment();
  const baseInput = (assignment.input ?? {}) as Record<string, unknown>;
  return {
    ...assignment,
    input: {
      ...baseInput,
      planArtifact: crypto.randomUUID(),
      repositoryProfile: await repositoryProfile(),
      ...overrides,
    },
  } as JobAssignment;
}

function executorFor(
  dir: string,
  timeLimitMs: number,
) {
  return createCodexHarnessExecutor({
    // Artifact publication is exercised end to end by the integration and
    // e2e lanes; this lane only needs a digest-faithful byte boundary.
    publishFor: () => async (request, _signal) => ({
      artifactId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      sha256: await sha256Hex(request.bytes),
    }),
    repositoryFor: () => dir,
    timeLimitMs,
    codexExecutable: codexExecutablePath(),
    authSourceDir: operatorCodexAuthSource(),
  });
}

async function waitUntilCodexStarts(
  markerPath: string,
): Promise<void> {
  const { promise: started, resolve } = Promise.withResolvers<void>();
  const poll = setInterval(async () => {
    try {
      await Deno.stat(markerPath);
      clearInterval(poll);
      clearTimeout(failSafe);
      resolve();
    } catch {
      // Not started yet.
    }
  }, 500);
  const failSafe = setTimeout(() => {
    clearInterval(poll);
    resolve();
  }, 120_000);
  await started;
  await assertCodexStarted(markerPath);
}

async function assertCodexStarted(markerPath: string): Promise<void> {
  try {
    await Deno.stat(markerPath);
  } catch {
    throw new Error("CODEX_HARNESS_START_MARKER_TIMEOUT");
  }
}

async function waitUntilNoCodexProcesses(): Promise<void> {
  const { promise: gone, resolve } = Promise.withResolvers<void>();
  const poll = setInterval(async () => {
    if ((await codexProcessesAlive()).length === 0) {
      clearInterval(poll);
      clearTimeout(failSafe);
      resolve();
    }
  }, 250);
  const failSafe = setTimeout(() => {
    clearInterval(poll);
    resolve();
  }, 10_000);
  await gone;
}

/**
 * AC2: an interrupt stops the process safely, leaves no partial
 * commit or journal corruption, and never invents billing evidence.
 */
const codexAvailability = await codexHarnessAvailable();

Deno.test({
  ignore: codexAvailability !== true,
  name:
    "an interrupt SIGKILLs the codex process group and leaves the repository uncommitted",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-issue58-kill-");
    // The task first creates the marker (proving the run started), then idles
    // so the test can interrupt a live harness process.
    const assignment = await completedAssignment({
      instructions:
        "Create a file named started.marker in the working directory containing the word started. Then run the shell command `sleep 300` and do nothing else. Do not commit.",
    });
    const controller = new AbortController();
    const outcome = executorFor(scratch.dir, 300_000).execute(
      assignment,
      controller.signal,
    );
    await waitUntilCodexStarts(`${scratch.dir}/started.marker`);
    assertEquals(
      await gitText(scratch.dir, ["rev-parse", "HEAD"]),
      scratch.baseSha,
    );
    controller.abort();
    const settled = await outcome;
    assertEquals(settled.status, "canceled");
    // No partial commit: the base revision is untouched and the process tree
    // is gone.
    assertEquals(
      await gitText(scratch.dir, ["rev-parse", "HEAD"]),
      scratch.baseSha,
    );
    await waitUntilNoCodexProcesses();
    assertEquals(await codexProcessesAlive(), []);
  },
});

/**
 * AC2: the timeout path stops the process and reports a retryable
 * fault without any API-billing fallback.
 */
Deno.test({
  ignore: codexAvailability !== true,
  name:
    "the explicit time limit stops the codex process and reports a retryable fault with no usage fabrication",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-issue58-timeout-");
    const assignment = await completedAssignment();
    const outcome = await executorFor(scratch.dir, 2_000).execute(
      assignment,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    const fault = outcome.fault as Record<string, unknown>;
    assertEquals(fault.code, "CODEX_HARNESS_TIMEOUT");
    assertEquals(fault.retryable, true);
    // No billing fallback: the fault carries no usage receipt at all.
    assert(!("usage" in fault));
    assert(!("inputTokens" in fault) && !("outputTokens" in fault));
    assertEquals(
      await gitText(scratch.dir, ["rev-parse", "HEAD"]),
      scratch.baseSha,
    );
    await waitUntilNoCodexProcesses();
    assertEquals(await codexProcessesAlive(), []);
  },
});

/**
 * AC2: no credential material (tokens, auth.json contents) appears
 * in the harness's captured output, journal, or events.
 */
Deno.test({
  ignore: codexAvailability !== true,
  name: "captured codex output contains no token-shaped credential material",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-issue58-secret-");
    const capture = new CapturingOutputSink();
    // A bounded run that must not change any file publishes no artifact, so
    // this test isolates the redaction question from artifact publication.
    const assignment = await completedAssignment({
      instructions:
        "Do not change, create, or delete any file. Reply with the single word ready. Do not commit.",
    });
    const outcome = await executorFor(scratch.dir, 300_000).execute(
      assignment,
      new AbortController().signal,
      capture.sink(),
    );
    assertEquals(outcome.status, "completed");
    const captured = capture.text();
    // OpenAI key shapes, JWT shapes, and raw authorization headers must never
    // reach Bakery's captured output; the authorized login stays in Codex.
    for (
      const pattern of [
        /sk-[A-Za-z0-9_-]{20,}/,
        /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
        /OPENAI_API_KEY=/,
        /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{15,}/i,
        /"access_token"\s*:\s*"/,
        /"id_token"\s*:\s*"/,
        /"refresh_token"\s*:\s*"/,
      ]
    ) {
      assert(!pattern.test(captured), `credential shape leaked: ${pattern}`);
    }
  },
});

/**
 * Review blocker 1 (HIGH): the codex child must not inherit the worker's
 * control-plane environment. A fake codex executable dumps its environment;
 * the probe asserts enrollment token / server URL are absent while PATH and
 * HOME (an isolated per-attempt home, never the operator's) are present.
 * Runs without the real CLI.
 */
Deno.test({
  name:
    "the codex child runs with a cleared environment and a minimal PATH/DENO_DIR/HOME/TMPDIR allowlist",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-issue58-env-");
    const envDump = `${scratch.dir}/child-env.txt`;
    const fakeCodex = `${scratch.dir}/fake-codex`;
    await Deno.writeTextFile(
      fakeCodex,
      `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then echo 'codex-cli 0.0.0-fake'; exit 0; fi\nenv > '${envDump}'\nexit 0\n`,
    );
    await Deno.chmod(fakeCodex, 0o755);
    Deno.env.set("BAKERY_WORKER_ENROLLMENT_TOKEN", "probe-secret-token");
    Deno.env.set("BAKERY_SERVER_URL", "http://127.0.0.1:8000");
    try {
      const assignment = await completedAssignment({
        instructions:
          "Do not change, create, or delete any file. Reply with the single word ready. Do not commit.",
      });
      const executor = createCodexHarnessExecutor({
        publishFor: () => async (request, _signal) => ({
          artifactId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          sha256: await sha256Hex(request.bytes),
        }),
        repositoryFor: () => scratch.dir,
        timeLimitMs: 300_000,
        codexExecutable: fakeCodex,
        authSourceDir: syntheticAuthSource("auth.json"),
      });
      const outcome = await executor.execute(
        assignment,
        new AbortController().signal,
      );
      assertEquals(outcome.status, "completed");
    } finally {
      Deno.env.delete("BAKERY_WORKER_ENROLLMENT_TOKEN");
      Deno.env.delete("BAKERY_SERVER_URL");
    }
    const childEnv = await Deno.readTextFile(envDump);
    const childVariables: Record<string, string> = {};
    for (const line of childEnv.trim().split("\n")) {
      const equals = line.indexOf("=");
      if (equals > 0) {
        childVariables[line.slice(0, equals)] = line.slice(equals + 1);
      }
    }
    // Nothing from the Bakery control plane may cross the process boundary.
    for (const name of Object.keys(childVariables)) {
      assert(
        !name.startsWith("BAKERY_"),
        `control-plane variable leaked into the codex child: ${name}`,
      );
    }
    // The allowlist the pinned CLI needs to authenticate and write sessions.
    assert(
      childVariables["PATH"] !== undefined,
      "PATH missing from the child env",
    );
    // HOME is the attempt's isolated home, never the operator's (#418).
    assert(
      childVariables["HOME"] !== undefined,
      "HOME missing from the child env",
    );
    assert(
      childVariables["HOME"] !== Deno.env.get("HOME"),
      "the codex child inherited the operator HOME",
    );
    assert(
      childVariables["CODEX_HOME"] !== undefined &&
        childVariables["CODEX_HOME"] !== `${Deno.env.get("HOME")}/.codex`,
      "CODEX_HOME missing or pointing at the operator login",
    );
  },
});

/**
 * Review blocker 4 (LOW): overlapping executions against the single fixed
 * repository are rejected with a retryable busy fault. Runs without the
 * real CLI.
 */
Deno.test({
  name:
    "an overlapping harness execution is rejected with a retryable busy fault",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-issue58-busy-");
    const fakeCodex = `${scratch.dir}/fake-codex`;
    await Deno.writeTextFile(
      fakeCodex,
      '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo \'codex-cli 0.0.0-fake\'; exit 0; fi\nsleep 60\n',
    );
    await Deno.chmod(fakeCodex, 0o755);
    const executor = createCodexHarnessExecutor({
      publishFor: () => async (request, _signal) => ({
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: await sha256Hex(request.bytes),
      }),
      repositoryFor: () => scratch.dir,
      timeLimitMs: 300_000,
      codexExecutable: fakeCodex,
      authSourceDir: syntheticAuthSource("auth.json"),
    });
    const controller = new AbortController();
    const first = executor.execute(
      await completedAssignment(),
      controller.signal,
    );
    const second = await executor.execute(
      await completedAssignment(),
      new AbortController().signal,
    );
    assertEquals(second.status, "failed");
    if (second.status !== "failed") throw new Error("unreachable");
    const fault = second.fault as Record<string, unknown>;
    assertEquals(fault.code, "CODEX_HARNESS_BUSY");
    assertEquals(fault.retryable, true);
    controller.abort();
    assertEquals((await first).status, "canceled");
    await waitUntilNoCodexProcesses();
  },
});

/**
 * Review blocker 2 (MEDIUM): the workspace-write sandbox is constrained to
 * the prepared worktree — a model-directed write outside the worktree must
 * not land on disk. Requires the real pinned CLI.
 */
Deno.test({
  ignore: codexAvailability !== true,
  name:
    "the constrained sandbox does not perform writes outside the prepared worktree",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-issue58-sandbox-");
    const outside = await Deno.makeTempDir({
      prefix: "bakery-issue58-outside-",
    });
    const outsideFile = `${outside}/escape.txt`;
    const assignment = await completedAssignment({
      instructions:
        `Try to create the file ${outsideFile} containing the word escaped. ` +
        "If the write is blocked, say so. Then reply with the single word done. Do not commit.",
    });
    await executorFor(scratch.dir, 300_000).execute(
      assignment,
      new AbortController().signal,
    );
    // The escape attempt must not have landed on disk either way the model
    // reported it; the sandbox bounds the effect, not the model's prose.
    let exists = true;
    try {
      await Deno.stat(outsideFile);
    } catch {
      exists = false;
    }
    assert(!exists, `write escaped the worktree: ${outsideFile}`);
    await Deno.remove(outside, { recursive: true });
  },
});

/**
 * The codex child can read its auth copy (the sandbox restricts writes,
 * not reads). Every token in it is redacted from stored output and withheld
 * from the published patch. Runs without the real CLI.
 */
Deno.test({
  name:
    "a codex OAuth token in output is stored as [REDACTED] and in a patch fails closed (#430)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const access = `codex-SYNTHETIC-access-${crypto.randomUUID()}`;
    const refresh = `codex-SYNTHETIC-refresh-${crypto.randomUUID()}`;
    const source = syntheticAuthSource(
      "auth.json",
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: { access_token: access, refresh_token: refresh },
      }),
    );
    const build = async (
      body: string,
      publications: { count: number },
    ) => {
      const scratch = await prepareScratchRepository("bakery-codex-oauth-");
      const fakeCodex = `${scratch.dir}/fake-codex`;
      await Deno.writeTextFile(
        fakeCodex,
        `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then echo 'codex-cli 0.0.0-fake'; exit 0; fi\n${body}\nexit 0\n`,
      );
      await Deno.chmod(fakeCodex, 0o755);
      return {
        scratch,
        executor: createCodexHarnessExecutor({
          publishFor: () => async (request, _signal) => {
            publications.count++;
            return {
              artifactId: crypto.randomUUID(),
              versionId: crypto.randomUUID(),
              sha256: await sha256Hex(request.bytes),
            };
          },
          repositoryFor: () => scratch.dir,
          timeLimitMs: 30_000,
          codexExecutable: fakeCodex,
          authSourceDir: source,
        }),
      };
    };

    const echoed = { count: 0 };
    const out = await build(
      `printf '%s %s\\n' '${access}' '${refresh}'; printf '%s\\n' '${access}' >&2`,
      echoed,
    );
    const value = await completedAssignment();
    const secrets = await out.executor.credentialRedactionSecrets!(value);
    assertEquals([...secrets].sort(), [access, refresh].sort());
    const fixture = await nativeCaptureFixture(value, [], secrets);
    try {
      await out.executor.execute(
        value,
        new AbortController().signal,
        fixture.capture,
      );
      await fixture.capture.finish();
      const stored = JSON.stringify(fixture.spool.records());
      assert(!stored.includes(access) && !stored.includes(refresh));
      assert(stored.includes("[REDACTED]"));
    } finally {
      await Deno.remove(fixture.directory, { recursive: true });
    }

    const leaked = { count: 0 };
    const patch = await build(
      `printf '%s\\n' '${refresh}' >> notes.txt`,
      leaked,
    );
    const outcome = await patch.executor.execute(
      await completedAssignment(),
      new AbortController().signal,
    );
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "CODEX_HARNESS_PATCH_SECRET_DETECTED",
    );
    assertEquals(leaked.count, 0);
  },
});
