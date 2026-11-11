import { assert, assertEquals, assertRejects } from "@std/assert";
import { SYNTHETIC_PI_AUTH } from "../helpers/harness-auth.ts";
import { nativeCaptureFixture } from "../helpers/harness-conformance.ts";
import {
  createPiHarnessExecutor,
  type PiHarnessControl,
} from "../../apps/worker/src/pi-harness.ts";
import { outcomeResult } from "../../apps/worker/src/supervisor-support.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import {
  harnessProcessesAlive,
  prepareScratchRepository,
} from "../helpers/harness.ts";

import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
const RUN_PERMISSIONS = {
  sanitizeResources: false,
  sanitizeOps: false,
} as const;
const SESSION_ID = "00000000-0000-4000-8000-000000000012";
const SECRET = "pi-secret-must-not-be-an-environment-value";
const AUTH_BYTES = JSON.stringify({ anthropic: { key: SECRET } });

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

async function fakePi(
  dir: string,
  options: {
    readonly hang?: boolean;
    /** Written to stderr by the child, like a model echoing a credential. */
    readonly echo?: string;
    /** Appended to notes.txt, so the published patch would carry it. */
    readonly writeToPatch?: string;
  },
): Promise<{
  executable: string;
  envPath: string;
  authPath: string;
  commandPath: string;
}> {
  const executable = `${dir}/fake-pi-security`;
  const envPath = `${dir}/child-env.txt`;
  const authPath = `${dir}/child-auth.txt`;
  const commandPath = `${dir}/commands.txt`;
  await Deno.writeTextFile(
    executable,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'pi 0.8.0-security-fake'
  exit 0
fi
env > '${envPath}'
cat "$PI_CODING_AGENT_DIR/auth.json" > '${authPath}'
session_dir=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--session-dir" ]; then
    session_dir="$2"
    shift 2
  else
    shift
  fi
done
mkdir -p "$session_dir"
printf '%s\\n' '{"type":"session","id":"${SESSION_ID}"}' > "$session_dir/session.jsonl"
${options.echo ? `printf '%s\\n' '${options.echo}' >&2` : ""}
${
      options.writeToPatch
        ? `printf '%s\\n' '${options.writeToPatch}' >> notes.txt`
        : ""
    }
while IFS= read -r line; do
  printf '%s\\n' "$line" >> '${commandPath}'
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p')
  case "$line" in
    *'"type":"get_state"'*)
      printf '%s\\n' '{"id":"'"$id"'","type":"response","command":"get_state","success":true,"data":{"sessionId":"${SESSION_ID}","sessionFile":"session.jsonl"}}'
      ;;
    *'"type":"prompt"'*)
      printf '%s\\n' '{"id":"'"$id"'","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
      if [ '${options.hang ? "true" : "false"}' = 'true' ]; then
        printf '%s\\n' 'diagnostic stderr that is intentionally bounded' >&2
        sleep 60 &
        sleep_pid=$!
        while IFS= read -r stop_line; do
          printf '%s\\n' "$stop_line" >> '${commandPath}'
          stop_id=$(printf '%s' "$stop_line" | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p')
          case "$stop_line" in
            *'"type":"clear_queue"'*)
              printf '%s\\n' '{"id":"'"$stop_id"'","type":"response","command":"clear_queue","success":true}'
              ;;
            *'"type":"abort"'*)
              printf '%s\\n' '{"id":"'"$stop_id"'","type":"response","command":"abort","success":true}'
              kill "$sleep_pid" 2>/dev/null || true
              wait "$sleep_pid" 2>/dev/null || true
              exit 0
              ;;
          esac
        done
      else
        printf '%s\\n' '{"type":"agent_start"}'
        printf '%s\\n' '{"type":"agent_settled","aborted":false}'
      fi
      ;;
  esac
done
`,
  );
  await Deno.chmod(executable, 0o755);
  return { executable, envPath, authPath, commandPath };
}

async function assignment(scratchDir: string): Promise<JobAssignment> {
  const base = localAssignment();
  return {
    ...base,
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId: crypto.randomUUID(),
      planArtifact: crypto.randomUUID(),
      repositoryProfile: {
        organizationId: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        repositoryId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        revision: 1,
        digest: await sha256Hex(
          new TextEncoder().encode(
            canonicalJson({
              schemaVersion: 1,
              workflow: { kind: "fixed" },
              branches: { base: "main", allowedPatterns: ["feature/*"] },
              worktree: { root: ".bakery/worktrees" },
            }),
          ),
        ),
        config: {
          schemaVersion: 1,
          workflow: { kind: "fixed" },
          branches: { base: "main", allowedPatterns: ["feature/*"] },
          worktree: { root: ".bakery/worktrees" },
        },
        observationId: null,
        observationDigest: null,
        baseSha: null,
      },
      scratchDir,
    },
  } as JobAssignment;
}

function executorFor(
  worktree: string,
  fakeExecutable: string,
  stateDir: string,
  piAgentSourceDir: string,
  timeLimitMs = 5_000,
  registerControl?: (control: PiHarnessControl | undefined) => void,
  capabilities: readonly string[] = ["stream", "resume", "steer", "follow_up"],
) {
  return createPiHarnessExecutor({
    publishFor: () => async (request) => ({
      artifactId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      sha256: await sha256Hex(request.bytes),
    }),
    repositoryFor: () => worktree,
    piExecutable: fakeExecutable,
    piAgentSourceDir,
    stateDir,
    timeLimitMs,
    capabilities,
    registerControl,
  });
}
async function waitForFileText(path: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await Deno.readTextFile(path)).includes(text)) return;
    } catch {
      // The fake may not have created the log yet.
    }
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 10);
    await delay.promise;
  }
  throw new Error(`TEST_FILE_TEXT_TIMEOUT:${text}`);
}

Deno.test({
  name:
    "Pi re-homes auth/session state, clears stale attempts, and never exports auth bytes",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-security-");
    const source = `${scratch.dir}/operator-pi-agent`;
    await Deno.mkdir(source, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(`${source}/auth.json`, AUTH_BYTES);
    const fake = await fakePi(scratch.dir, {});
    const stateDir = `${scratch.dir}/worker-state`;
    await Deno.mkdir(`${stateDir}/pi-harness/stale`, { recursive: true });
    await Deno.writeTextFile(`${stateDir}/pi-harness/stale/old-secret`, SECRET);
    const value = await assignment(scratch.dir);

    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      stateDir,
      source,
    ).execute(value, new AbortController().signal);

    assertEquals(outcome.status, "completed");
    assertEquals(await Deno.readTextFile(fake.authPath), AUTH_BYTES);
    const childEnv = await Deno.readTextFile(fake.envPath);
    assert(!childEnv.includes(SECRET));
    assert(childEnv.includes("PI_CODING_AGENT_DIR="));
    // The child never inherits the operator HOME (#418).
    assert(
      childEnv.includes(
        `HOME=${stateDir}/pi-harness/${value.attemptId}/home\n`,
      ),
    );
    await assertRejects(() => Deno.stat(`${stateDir}/pi-harness/stale`));
    await assertRejects(() =>
      Deno.stat(`${stateDir}/pi-harness/${value.attemptId}`)
    );
  },
});

Deno.test({
  name: "Pi with a missing auth source directory fails closed before spawn",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-auth-nodir-");
    const fake = await fakePi(scratch.dir, {});
    const before = new TextDecoder().decode(
      (await new Deno.Command("git", {
        args: ["rev-parse", "HEAD"],
        cwd: scratch.dir,
        stdout: "piped",
      }).output()).stdout,
    );
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
      `${scratch.dir}/does-not-exist`,
    ).execute(await assignment(scratch.dir), new AbortController().signal);

    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    const fault = outcomeResult(outcome).fault as Record<string, unknown>;
    assertEquals(fault.code, "PI_HARNESS_CREDENTIAL_UNAVAILABLE");
    assertEquals(fault.status, 503);
    assertEquals(fault.retryable, false);
    // The child never launched: it would have written its env dump.
    await assertRejects(() => Deno.stat(fake.envPath));
    assertEquals(
      new TextDecoder().decode(
        (await new Deno.Command("git", {
          args: ["rev-parse", "HEAD"],
          cwd: scratch.dir,
          stdout: "piped",
        }).output()).stdout,
      ),
      before,
    );
  },
});

Deno.test({
  name: "Pi rejects a configured auth source that lacks auth.json",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-auth-missing-");
    const source = `${scratch.dir}/operator-pi-agent`;
    await Deno.mkdir(source, { recursive: true, mode: 0o700 });
    const fake = await fakePi(scratch.dir, {});
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
      source,
    ).execute(await assignment(scratch.dir), new AbortController().signal);

    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcomeResult(outcome).fault as Record<string, unknown>).code,
      "PI_HARNESS_CREDENTIAL_UNAVAILABLE",
    );
    assertEquals(
      (outcomeResult(outcome).fault as Record<string, unknown>).retryable,
      false,
    );
  },
});

Deno.test({
  name:
    "Pi timeout uses bounded teardown and the shared process-group kill fallback",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-timeout-");
    const source = `${scratch.dir}/operator-pi-agent`;
    await Deno.mkdir(source, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(`${source}/auth.json`, SYNTHETIC_PI_AUTH);
    const fake = await fakePi(scratch.dir, { hang: true });
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
      source,
      1_000,
    ).execute(await assignment(scratch.dir), new AbortController().signal);

    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcomeResult(outcome).fault as Record<string, unknown>).code,
      "PI_HARNESS_TIMEOUT",
    );
    assertEquals(
      (outcomeResult(outcome).fault as Record<string, unknown>).retryable,
      true,
    );
    const commands = await Deno.readTextFile(fake.commandPath);
    const clearQueue = commands.indexOf('"type":"clear_queue"');
    const abort = commands.indexOf('"type":"abort"');
    assert(clearQueue >= 0 && abort > clearQueue);
    assertEquals(await harnessProcessesAlive(fake.executable), []);
  },
});

Deno.test({
  name: "Pi rejects controls once cancellation teardown begins",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-cancel-race-");
    const source = `${scratch.dir}/operator-pi-agent`;
    await Deno.mkdir(source, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(`${source}/auth.json`, SYNTHETIC_PI_AUTH);
    const fake = await fakePi(scratch.dir, { hang: true });
    let control: PiHarnessControl | undefined;
    const executor = executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
      source,
      5_000,
      (value) => {
        control = value;
      },
    );
    const controller = new AbortController();
    const execution = executor.execute(
      await assignment(scratch.dir),
      controller.signal,
    );
    await waitForFileText(fake.commandPath, '"type":"prompt"');
    controller.abort();
    assert(control !== undefined);
    assertEquals(
      await control!.send("steer_message", "after-cancel", "must not queue"),
      "rejected",
    );
    const outcome = await execution;
    assertEquals(outcome.status, "canceled");
    const commands = await Deno.readTextFile(fake.commandPath);
    const clearQueue = commands.indexOf('"type":"clear_queue"');
    const abort = commands.indexOf('"type":"abort"');
    assert(clearQueue >= 0 && abort > clearQueue);
    assert(!commands.includes('"id":"after-cancel"'));
    assertEquals(await harnessProcessesAlive(fake.executable), []);
  },
});

Deno.test("Pi rejects traversal attempt identifiers before spawning a child", async () => {
  const scratch = await prepareScratchRepository("bakery-pi-attempt-");
  const source = `${scratch.dir}/operator-pi-agent`;
  await Deno.mkdir(source, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(`${source}/auth.json`, SYNTHETIC_PI_AUTH);
  const fake = await fakePi(scratch.dir, {});
  const executor = executorFor(
    scratch.dir,
    fake.executable,
    `${scratch.dir}/worker-state`,
    source,
  );
  for (const attemptId of [".", "..", "../escape", "bad/attempt"]) {
    const value = {
      ...(await assignment(scratch.dir)),
      attemptId,
    } as JobAssignment;
    const outcome = await executor.execute(
      value,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "failed", attemptId);
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcomeResult(outcome).fault as Record<string, unknown>).code,
      "PI_HARNESS_INPUT_INVALID",
      attemptId,
    );
  }
});

Deno.test({
  name:
    "Pi OAuth token in output is stored as [REDACTED] and in a patch fails closed (#430)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const access = `pi-SYNTHETIC-access-${crypto.randomUUID()}`;
    const refresh = `pi-SYNTHETIC-refresh-${crypto.randomUUID()}`;
    const source = await Deno.makeTempDir({ prefix: "bakery-pi-oauth-src-" });
    try {
      await Deno.writeTextFile(
        `${source}/auth.json`,
        JSON.stringify({ anthropic: { type: "oauth", access, refresh } }),
      );
      // Output: the child echoes both tokens; the capture stores [REDACTED].
      {
        const scratch = await prepareScratchRepository("bakery-pi-oauth-out-");
        const fake = await fakePi(scratch.dir, {
          echo: `${access} ${refresh}`,
        });
        const publications = { count: 0 };
        const executor = createPiHarnessExecutor({
          publishFor: () => async (request) => {
            publications.count++;
            return {
              artifactId: crypto.randomUUID(),
              versionId: crypto.randomUUID(),
              sha256: await sha256Hex(request.bytes),
            };
          },
          repositoryFor: () => scratch.dir,
          piExecutable: fake.executable,
          piAgentSourceDir: source,
          stateDir: `${scratch.dir}/worker-state`,
          timeLimitMs: 5_000,
          capabilities: [],
        });
        const value = await assignment(scratch.dir);
        const credentialSecrets = await executor.credentialRedactionSecrets!(
          value,
        );
        assertEquals([...credentialSecrets].sort(), [access, refresh].sort());
        const fixture = await nativeCaptureFixture(
          value,
          [],
          credentialSecrets,
        );
        try {
          await executor.execute(
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
      }
      // Patch: a token written into the patch is never published.
      {
        const scratch = await prepareScratchRepository(
          "bakery-pi-oauth-patch-",
        );
        const fake = await fakePi(scratch.dir, { writeToPatch: access });
        const publications = { count: 0 };
        const outcome = await createPiHarnessExecutor({
          publishFor: () => async (request) => {
            publications.count++;
            return {
              artifactId: crypto.randomUUID(),
              versionId: crypto.randomUUID(),
              sha256: await sha256Hex(request.bytes),
            };
          },
          repositoryFor: () => scratch.dir,
          piExecutable: fake.executable,
          piAgentSourceDir: source,
          stateDir: `${scratch.dir}/worker-state`,
          timeLimitMs: 5_000,
          capabilities: [],
        }).execute(await assignment(scratch.dir), new AbortController().signal);
        assertEquals(outcome.status, "failed");
        assertEquals(
          (outcomeResult(outcome).fault as Record<string, unknown>).code,
          "PI_HARNESS_PATCH_SECRET_DETECTED",
        );
        assertEquals(publications.count, 0);
      }
    } finally {
      await Deno.remove(source, { recursive: true });
    }
  },
});
