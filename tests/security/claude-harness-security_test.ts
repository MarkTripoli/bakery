import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
  FAKE_CLAUDE_VERSION_PRELUDE,
  SYNTHETIC_CLAUDE_CREDENTIALS,
} from "../helpers/harness-auth.ts";
import { createClaudeHarnessExecutor } from "../../apps/worker/src/claude-harness.ts";
import { readWorkerLaunchPermissions } from "../../apps/worker/src/config.ts";
import type { WorkerApiClient } from "../../apps/worker/src/client.ts";
import {
  NATIVE_OUTPUT_LIMITS,
  NativeOutputCapture,
  type NativeOutputChannel,
  type NativeOutputSink,
} from "../../apps/worker/src/native-output.ts";
import {
  EventSpool,
  SpoolError,
  terminalReservationBytes,
} from "../../apps/worker/src/spool.ts";
import type {
  JobAssignment,
  OutputBatch,
  WorkerOutputBinding,
} from "../../apps/worker/src/types.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import { prepareScratchRepository } from "../helpers/harness.ts";
import {
  buildCoordinatorTurnJobInput,
  COORDINATOR_TURN_ACTION,
} from "../../packages/contracts/src/coordinator-turn.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";

const RUN_PERMISSIONS = {
  sanitizeResources: false,
  sanitizeOps: false,
} as const;
const CLAUDE_FAKE_VERSION = "2.1.0 (Claude Code)";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
function nativeSessionRecord(
  sessionId = SESSION_ID,
): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    claude_code_version: "2.1.0",
  });
}

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

async function profile() {
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

async function assignment(): Promise<JobAssignment> {
  const base = localAssignment();
  return {
    ...base,
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId: crypto.randomUUID(),
      planArtifact: crypto.randomUUID(),
      repositoryProfile: await profile(),
    },
  } as JobAssignment;
}

async function fakeClaude(
  dir: string,
  body: string,
  launchMarker?: string,
): Promise<string> {
  const authSource = `${dir}/auth-source`;
  await Deno.mkdir(authSource, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    `${authSource}/.credentials.json`,
    SYNTHETIC_CLAUDE_CREDENTIALS,
  );
  const path = `${dir}/fake-claude`;
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\n${
      launchMarker === undefined ? "" : `: > '${launchMarker}'\n`
    }${FAKE_CLAUDE_VERSION_PRELUDE}\n${body}\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

function executorFor(
  dir: string,
  executable: string,
  timeLimitMs = 5_000,
  options: {
    readonly authSourceDir?: string;
    readonly badDigest?: boolean;
    readonly publicationCount?: { count: number };
    readonly redactionSecrets?: readonly string[];
  } = {},
) {
  return createClaudeHarnessExecutor({
    publishFor: () => async (request) => {
      if (options.publicationCount) options.publicationCount.count++;
      return {
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: options.badDigest
          ? "0".repeat(64)
          : await sha256Hex(request.bytes),
      };
    },
    repositoryFor: () => dir,
    claudeExecutable: executable,
    stateDir: `${dir}/state`,
    authSourceDir: options.authSourceDir ?? `${dir}/auth-source`,
    timeLimitMs,
    redactionSecrets: options.redactionSecrets,
  });
}

async function syntheticAuthSource(dir: string): Promise<string> {
  const source = `${dir}/auth-source`;
  await Deno.mkdir(source, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    source + "/.credentials.json",
    SYNTHETIC_CLAUDE_CREDENTIALS,
  );
  await Deno.writeTextFile(source + "/not-allowlisted.txt", "must-not-copy");
  return source;
}
async function writeCheckpointSidecar(
  statePath: string,
  value: {
    readonly repositoryId: string;
    readonly agentSessionId: string;
    readonly sessionId: string;
    readonly checkpointToken: string;
    readonly worktreeRevision: string;
    readonly nativeFile?: string;
    readonly nativeFileSha256?: string;
    readonly harnessVersion?: string;
  },
): Promise<void> {
  await Deno.mkdir(statePath, { recursive: true, mode: 0o700 });
  const nativeFileSha256 = value.nativeFile
    ? value.nativeFileSha256 ??
      await sha256Hex(
        await Deno.readFile(`${statePath}/${value.nativeFile}`),
      )
    : value.nativeFileSha256;
  await Deno.writeTextFile(
    `${statePath}/.bakery-checkpoint.json`,
    JSON.stringify({
      schemaVersion: 1,
      harnessVersion: CLAUDE_FAKE_VERSION,
      ...value,
      ...(nativeFileSha256 ? { nativeFileSha256 } : {}),
    }),
  );
}

async function assertNativeResumeStartsFresh(
  prefix: string,
  nativeText: string,
  nativeFileSha256?: string,
  sidecarVersion: { readonly harnessVersion?: string } = {},
): Promise<void> {
  const scratch = await prepareScratchRepository(prefix);
  const authSource = await syntheticAuthSource(scratch.dir);
  const value = await assignment();
  const input = value.input as Record<string, unknown>;
  const baseSha = await gitHead(scratch.dir);
  const repositoryId = input.repositoryId as string;
  const statePath =
    `${scratch.dir}/state/claude-harness/sessions/${repositoryId}/${value.agentSessionId}/${SESSION_ID}`;
  await Deno.mkdir(`${statePath}/projects`, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    `${statePath}/projects/retained.jsonl`,
    nativeText,
  );
  await writeCheckpointSidecar(statePath, {
    repositoryId,
    agentSessionId: value.agentSessionId!,
    sessionId: SESSION_ID,
    checkpointToken: "checkpoint-1",
    worktreeRevision: baseSha,
    nativeFile: "projects/retained.jsonl",
    nativeFileSha256,
    ...sidecarVersion,
  });
  value.currentCheckpoints = [{
    agentSessionId: value.agentSessionId,
    nativeSessionId: SESSION_ID,
    worktreeRevision: baseSha,
    resumeHandleRef: "checkpoint-1",
    localStatePath: statePath,
  }] as never;
  input.resume = {
    sessionId: SESSION_ID,
    worktreeRevision: baseSha,
    resumeHandleRef: "checkpoint-1",
  };
  const argsPath = `${scratch.dir}/args.txt`;
  const fake = await fakeClaude(
    scratch.dir,
    `printf '%s\\n' "$@" > '${argsPath}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
  );
  const outcome = await executorFor(scratch.dir, fake, 5_000, {
    authSourceDir: authSource,
  }).execute(value, new AbortController().signal);
  assertEquals(outcome.status, "completed");
  assertFalse((await Deno.readTextFile(argsPath)).includes("--resume"));
}

async function gitHead(dir: string): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["-C", dir, "rev-parse", "HEAD"],
    stdout: "piped",
  }).output();
  if (!result.success) throw new Error("GIT_HEAD_READ_FAILED");
  return new TextDecoder().decode(result.stdout).trim();
}
function outputBinding(attemptId: string): WorkerOutputBinding {
  const id = () => crypto.randomUUID();
  return {
    sessionId: id(),
    organizationId: id(),
    applicationId: id(),
    jobId: id(),
    taskId: null,
    runStepId: null,
    conversationId: null,
    logicalActor: "harness.implement:claude",
    attemptId,
    workerHostId: id(),
    workerSessionId: id(),
    workerSessionGeneration: "1",
    fence: "1",
    writerGeneration: "1",
    highwater: "0",
    nextSequence: "1",
    closed: false,
    capture: "capturing",
    reason: null,
    archive: "pending",
  };
}

async function nativeCaptureFixture(
  assignmentValue: JobAssignment,
  configuredSecrets: readonly string[],
  options: {
    readonly maxRecords?: number;
    readonly maxBytes?: number;
    readonly waitForAck?: () => Promise<void>;
    readonly credentialSecrets?: readonly string[];
  } = {},
): Promise<{
  directory: string;
  spool: EventSpool;
  capture: NativeOutputCapture;
}> {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-claude-native-capture-",
  });
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: options.maxRecords ?? 1_000,
    maxBytes: options.maxBytes ?? 1024 * 1024,
  });
  await spool.restoreJournalState(assignmentValue.attemptId, "3", "2");
  await spool.reserveTerminal(
    assignmentValue.attemptId,
    terminalReservationBytes({
      attemptId: assignmentValue.attemptId,
      leaseToken: assignmentValue.leaseToken,
      fence: assignmentValue.fence,
    }),
  );
  const binding = outputBinding(assignmentValue.attemptId);
  const capture = new NativeOutputCapture({
    assignment: assignmentValue,
    binding,
    client: null as unknown as WorkerApiClient,
    spool,
    workerSessionId: binding.workerSessionId,
    workerSessionGeneration: binding.workerSessionGeneration,
    configuredSecrets,
    credentialSecrets: options.credentialSecrets,
    leaseActive: () => true,
    waitForAck: options.waitForAck ?? (() => Promise.resolve()),
  });
  return { directory, spool, capture };
}

type SplitCaptureWrite = {
  readonly channel: NativeOutputChannel;
  readonly bytes: Uint8Array;
};

function splitNativeCapture(
  capture: NativeOutputCapture,
  token: string,
): { sink: NativeOutputSink; writes: SplitCaptureWrite[] } {
  const writes: SplitCaptureWrite[] = [];
  const encoder = new TextEncoder();
  const tokenBytes = encoder.encode(token).byteLength;
  const sink: NativeOutputSink = {
    async write(channel, chunk) {
      const decoded = new TextDecoder().decode(chunk);
      const tokenOffset = decoded.indexOf(token);
      const requestedSplit = tokenOffset >= 0
        ? encoder.encode(decoded.slice(0, tokenOffset)).byteLength +
          Math.ceil(tokenBytes / 2)
        : chunk.byteLength;
      const splitAt = Math.min(
        chunk.byteLength,
        Math.max(1, requestedSplit),
      );
      for (const part of [chunk.slice(0, splitAt), chunk.slice(splitAt)]) {
        if (part.byteLength === 0) continue;
        writes.push({ channel, bytes: part.slice() });
        await capture.write(channel, part);
      }
    },
    sourceLost: (channel, reason) => capture.sourceLost(channel, reason),
  };
  return { sink, writes };
}

Deno.test({
  name:
    "Claude child receives no Bakery credentials and uses isolated config state",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-env-");
    const envDump = `${scratch.dir}/env.txt`;
    const fake = await fakeClaude(
      scratch.dir,
      `env > '${envDump}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const parentNames = [
      "BAKERY_WORKER_ENROLLMENT_TOKEN",
      "BAKERY_SERVER_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    for (const name of parentNames) Deno.env.set(name, "secret-value");
    try {
      const value = await assignment();
      const outcome = await executorFor(scratch.dir, fake).execute(
        value,
        new AbortController().signal,
      );
      assertEquals(outcome.status, "completed");
      const variables = Object.fromEntries(
        (await Deno.readTextFile(envDump)).trim().split("\n").map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
      );
      for (const name of Object.keys(variables)) {
        assertFalse(name.startsWith("BAKERY_"), `leaked ${name}`);
      }
      assertEquals(variables.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assertEquals(variables.ANTHROPIC_API_KEY, undefined);
      const attemptRoot =
        `${scratch.dir}/state/claude-harness/${value.attemptId}`;
      assertEquals(variables.CLAUDE_CONFIG_DIR, `${attemptRoot}/config`);
      // The child never inherits the operator HOME (#418).
      assertEquals(variables.HOME, `${attemptRoot}/home`);
    } finally {
      for (const name of parentNames) Deno.env.delete(name);
    }
  },
});

Deno.test({
  name:
    "Claude removes per-attempt auth/config state and sweeps stale attempts",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-auth-");
    const authSource = await syntheticAuthSource(scratch.dir);
    const fake = await fakeClaude(
      scratch.dir,
      `cat "$CLAUDE_CONFIG_DIR/.credentials.json" > '${scratch.dir}/observed-auth'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const value = await assignment();
    const harnessRoot = `${scratch.dir}/state/claude-harness`;
    const staleDir = `${harnessRoot}/stale-attempt`;
    const sessionsDir = `${harnessRoot}/sessions`;
    await Deno.mkdir(staleDir, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(`${staleDir}/.credentials.json`, "stale-oauth");
    await Deno.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(`${sessionsDir}/keep.txt`, "keep");
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      authSourceDir: authSource,
    }).execute(value, new AbortController().signal);
    assertEquals(outcome.status, "completed");
    const configDir = `${harnessRoot}/${value.attemptId}`;
    assertEquals(
      await Deno.readTextFile(`${scratch.dir}/observed-auth`),
      SYNTHETIC_CLAUDE_CREDENTIALS,
    );
    assertFalse(
      await Deno.stat(configDir).then(
        () => true,
        () => false,
      ),
    );
    assertFalse(
      await Deno.stat(staleDir).then(
        () => true,
        () => false,
      ),
    );
    assertEquals(await Deno.readTextFile(`${sessionsDir}/keep.txt`), "keep");
  },
});

Deno.test({
  name: "Claude rejects unsafe attempt identifiers before creating state",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-attempt-");
    const fake = await fakeClaude(scratch.dir, "exit 0");
    const value = await assignment();
    const outcome = await executorFor(scratch.dir, fake).execute(
      { ...value, attemptId: "../escape" } as JobAssignment,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_INPUT_INVALID",
    );
    assertFalse(
      await Deno.stat(`${scratch.dir}/state/escape`).then(
        () => true,
        () => false,
      ),
    );
  },
});

Deno.test({
  name: "missing Claude auth fails before child spawn and publication",
  ...RUN_PERMISSIONS,
  fn: async () => {
    for (const mode of ["missing-directory", "missing-credentials"]) {
      const scratch = await prepareScratchRepository(
        `bakery-claude-no-auth-${mode}-`,
      );
      const authSource = `${scratch.dir}/configured-auth`;
      if (mode === "missing-credentials") {
        await Deno.mkdir(authSource, { recursive: true, mode: 0o700 });
        await Deno.writeTextFile(`${authSource}/settings.json`, "{}");
      }
      const marker = `${scratch.dir}/child-launched`;
      const fake = await fakeClaude(
        scratch.dir,
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
        marker,
      );
      const beforeHead = await gitHead(scratch.dir);
      const publicationCount = { count: 0 };
      const outcome = await executorFor(scratch.dir, fake, 5_000, {
        authSourceDir: authSource,
        publicationCount,
      }).execute(await assignment(), new AbortController().signal);
      assertEquals(outcome.status, "failed", mode);
      if (outcome.status !== "failed") throw new Error("unreachable");
      const fault = outcome.fault as Record<string, unknown>;
      assertEquals(fault.code, "CLAUDE_HARNESS_CREDENTIAL_UNAVAILABLE");
      assertEquals(fault.status, 503);
      assertEquals(fault.retryable, false);
      assertFalse(
        await Deno.stat(marker).then(
          () => true,
          () => false,
        ),
      );
      assertEquals(publicationCount.count, 0);
      assertEquals(await gitHead(scratch.dir), beforeHead);
    }
  },
});

Deno.test({
  name:
    "production Claude grants fail closed before launch without synthetic auth",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository(
      "bakery-claude-production-grants-",
    );
    const home = `${scratch.dir}/home`;
    await Deno.mkdir(`${home}/.claude`, { recursive: true, mode: 0o700 });
    const marker = `${scratch.dir}/production-child-launched`;
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
      marker,
    );
    const value = await assignment();
    const stateDir = `${scratch.dir}/production-state`;
    const environment = {
      BAKERY_ENV: "production",
      BAKERY_SERVER_URL: "https://worker.example",
      BAKERY_WORKER_STATE_DIR: stateDir,
      BAKERY_WORKER_CAPABILITIES: "git",
      BAKERY_CLAUDE_HARNESS: "1",
      BAKERY_CLAUDE_HARNESS_REPOSITORY: scratch.dir,
      BAKERY_CLAUDE_HARNESS_EXECUTABLE: fake,
      HOME: home,
    };
    const grants = readWorkerLaunchPermissions(environment, Deno.cwd());
    const scriptPath = `${scratch.dir}/production-launch-test.ts`;
    const adapterUrl = new URL(
      "../../apps/worker/src/claude-harness.ts",
      import.meta.url,
    ).href;
    await Deno.writeTextFile(
      scriptPath,
      `
import { createClaudeHarnessExecutor } from ${JSON.stringify(adapterUrl)};
const assignment = ${JSON.stringify(value)};
let publications = 0;
const executor = createClaudeHarnessExecutor({
  repositoryFor: () => ${JSON.stringify(scratch.dir)},
  claudeExecutable: ${JSON.stringify(fake)},
  stateDir: ${JSON.stringify(stateDir)},
  authSourceDir: ${JSON.stringify(`${home}/.claude`)},
  publishFor: () => async () => {
    publications++;
    return {
      artifactId: "artifact",
      versionId: "version",
      sha256: "0".repeat(64),
    };
  },
});
const outcome = await executor.execute(assignment, new AbortController().signal);
console.log(JSON.stringify({ outcome, publications }));
`,
    );
    const command = new Deno.Command(Deno.execPath(), {
      cwd: Deno.cwd(),
      args: [
        "run",
        "--no-prompt",
        "--no-check",
        `--config=${Deno.cwd()}/deno.json`,
        `--allow-read=${[...grants.read, scratch.dir].join(",")}`,
        `--allow-write=${grants.write.join(",")}`,
        `--allow-net=${grants.net.join(",")}`,
        `--allow-run=${grants.run.join(",")}`,
        `--allow-sys=${grants.sys.join(",")}`,
        "--allow-env=HOME,TMPDIR",
        scriptPath,
      ],
      env: { HOME: home, TMPDIR: scratch.dir },
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const payload = JSON.parse(new TextDecoder().decode(result.stdout).trim());
    assertEquals(payload.outcome.status, "failed");
    assertEquals(
      payload.outcome.fault.code,
      "CLAUDE_HARNESS_CREDENTIAL_UNAVAILABLE",
    );
    assertEquals(payload.publications, 0);
    assertFalse(
      await Deno.stat(marker).then(
        () => true,
        () => false,
      ),
    );
  },
});

Deno.test({
  name: "assistant before init cannot publish or change HEAD",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-pre-init-");
    const beforeHead = await gitHead(scratch.dir);
    const publicationCount = { count: 0 };
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' 'invalid early edit' >> notes.txt
printf '%s\\n' '{"type":"assistant","message":"early"}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      publicationCount,
    }).execute(await assignment(), new AbortController().signal);
    assertEquals(outcome.status, "failed");
    assertEquals(publicationCount.count, 0);
    assertEquals(await gitHead(scratch.dir), beforeHead);
  },
});
Deno.test({
  name: "Claude adapter uses native capture redaction and bounds",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-redact-");
    const secret = "split-secret";
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s' '{"type":"assistant","message":"split-'
printf '%s\\n' 'secret"}'
printf '%b' '\\033[31mred\\033[0m\\033]52;c;clipboard\\007\\000ok' >&2
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"assistant","message":"late"}'`,
    );
    const value = await assignment();
    const beforeHead = await gitHead(scratch.dir);
    const publicationCount = { count: 0 };
    const fixture = await nativeCaptureFixture(value, [secret]);
    try {
      const outcome = await executorFor(scratch.dir, fake, 5_000, {
        publicationCount,
      }).execute(
        value,
        new AbortController().signal,
        fixture.capture,
      );
      assertEquals(outcome.status, "failed");
      assertEquals(await fixture.capture.finish(), {
        capture: "complete",
        reason: "clean-end",
      });
      const output = fixture.spool.records().filter((record) =>
        record.type === "job.output"
      );
      assert(output.length > 0);
      assert(output.length <= 32);
      const persisted = JSON.stringify(output);
      assertFalse(persisted.includes(secret));
      assert(persisted.includes("[REDACTED]"));
      assertFalse(persisted.includes("\\u001b"));
      assertFalse(persisted.includes("\\u0000"));
      assertFalse(persisted.includes("clipboard"));
      for (const record of output) {
        assert(JSON.stringify(record.payload).length <= 32_000);
      }
      assertEquals(publicationCount.count, 0);
      assertEquals(await gitHead(scratch.dir), beforeHead);
    } finally {
      await Deno.remove(fixture.directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "adapter capture redacts a deterministic cross-chunk secret",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-split-");
    const secret = "split-secret";
    const record = `{"type":"assistant","message":"${secret}"}
`;
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'
printf '%s' '${record}'`,
    );
    const value = await assignment();
    const beforeHead = await gitHead(scratch.dir);
    const publicationCount = { count: 0 };
    const captureState: { spool?: EventSpool } = {};
    const fixture = await nativeCaptureFixture(value, [secret], {
      waitForAck: async () => {
        const last = captureState.spool?.records().filter((record) =>
          record.type === "job.output"
        ).at(-1);
        if (last && captureState.spool) {
          await captureState.spool.acknowledge(value.attemptId, last.localSeq);
        }
      },
    });
    captureState.spool = fixture.spool;
    const split = splitNativeCapture(fixture.capture, secret);
    try {
      const outcome = await executorFor(scratch.dir, fake, 5_000, {
        publicationCount,
      }).execute(value, new AbortController().signal, split.sink);
      assertEquals(outcome.status, "failed");
      assertEquals(await fixture.capture.finish(), {
        capture: "complete",
        reason: "clean-end",
      });
      const stdoutWrites = split.writes.filter((write) =>
        write.channel === "stdout"
      );
      const decodedWrites = stdoutWrites.map((write) =>
        new TextDecoder().decode(write.bytes)
      );
      const joined = decodedWrites.join("");
      const secretStart = joined.indexOf(secret);
      assert(secretStart >= 0);
      const secretEnd = secretStart + secret.length;
      let offset = 0;
      let spanningWrites = 0;
      for (const decoded of decodedWrites) {
        if (secretStart < offset + decoded.length && secretEnd > offset) {
          spanningWrites++;
        }
        offset += decoded.length;
      }
      assert(spanningWrites >= 2);
      const persisted = JSON.stringify(fixture.spool.records());
      assertFalse(persisted.includes(secret));
      assert(persisted.includes("[REDACTED]"));
      assertEquals(publicationCount.count, 0);
      assertEquals(await gitHead(scratch.dir), beforeHead);
    } finally {
      await Deno.remove(fixture.directory, { recursive: true });
    }
  },
});

const oauthSources: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const source of oauthSources) {
    try {
      Deno.removeSync(source, { recursive: true });
    } catch {
      // Already removed.
    }
  }
});

/** Synthetic OAuth credentials with per-test unique tokens, outside the clone. */
async function oauthAuthSource(
  accessToken: string,
  refreshToken: string,
): Promise<string> {
  const source = await Deno.makeTempDir({ prefix: "bakery-claude-oauth-src-" });
  oauthSources.push(source);
  await Deno.writeTextFile(
    `${source}/.credentials.json`,
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken } }),
  );
  return source;
}

Deno.test({
  name: "Claude OAuth token in output is stored as [REDACTED] (#430)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-oauth-out-");
    const access = `sk-ant-oat01-SYNTHETIC-${crypto.randomUUID()}`;
    const refresh = `sk-ant-ort01-SYNTHETIC-${crypto.randomUUID()}`;
    const authSource = await oauthAuthSource(access, refresh);
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"assistant","message":"read ${access} and ${refresh}"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'
printf 'err %s %s\\n' '${access}' '${refresh}' >&2`,
    );
    const run = async (useHook: boolean) => {
      const value = await assignment();
      const executor = executorFor(scratch.dir, fake, 5_000, {
        authSourceDir: authSource,
      });
      // The supervisor asks the executor for credential values before it
      // opens the capture; this builds the capture the same way.
      const credentialSecrets = useHook
        ? await executor.credentialRedactionSecrets!(value)
        : [];
      assertEquals(
        [...credentialSecrets].sort(),
        useHook ? [access, refresh].sort() : [],
      );
      const fixture = await nativeCaptureFixture(value, [], {
        credentialSecrets,
      });
      const split = splitNativeCapture(fixture.capture, access);
      try {
        // The redacted run splits the access token across two writes.
        await executor.execute(
          value,
          new AbortController().signal,
          useHook ? split.sink : fixture.capture,
        );
        await fixture.capture.finish();
        return JSON.stringify(fixture.spool.records());
      } finally {
        await Deno.remove(fixture.directory, { recursive: true });
      }
    };
    const control = await run(false);
    assert(
      control.includes(access) && control.includes(refresh),
      "control: tokens are stored without the credential hook",
    );
    const redacted = await run(true);
    assertFalse(redacted.includes(access));
    assertFalse(redacted.includes(refresh));
    assert(redacted.includes("[REDACTED]"));
  },
});

Deno.test({
  name: "Claude patch containing the OAuth token fails closed (#430)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const access = `sk-ant-oat01-SYNTHETIC-${crypto.randomUUID()}`;
    const refresh = `sk-ant-ort01-SYNTHETIC-${crypto.randomUUID()}`;
    const refreshed = `sk-ant-oat01-SYNTHETIC-refreshed-${crypto.randomUUID()}`;
    for (const variant of ["access-token", "refreshed-token"] as const) {
      const scratch = await prepareScratchRepository(
        `bakery-claude-oauth-patch-${variant}-`,
      );
      const authSource = await oauthAuthSource(access, refresh);
      const leak = variant === "access-token" ? access : refreshed;
      // The refreshed variant rewrites the child's auth copy first, so only a
      // post-run re-read of that copy can know the new token.
      const refresh_step = variant === "refreshed-token"
        ? `printf '%s' '{"claudeAiOauth":{"accessToken":"${refreshed}","refreshToken":"${refresh}"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"\n`
        : "";
      const fake = await fakeClaude(
        scratch.dir,
        `${refresh_step}printf '%s\\n' '${leak}' > notes.txt
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
      );
      const beforeHead = await gitHead(scratch.dir);
      const publicationCount = { count: 0 };
      const outcome = await executorFor(scratch.dir, fake, 5_000, {
        authSourceDir: authSource,
        publicationCount,
      }).execute(await assignment(), new AbortController().signal);
      assertEquals(outcome.status, "failed", variant);
      if (outcome.status !== "failed") throw new Error("unreachable");
      const fault = outcome.fault as Record<string, unknown>;
      assertEquals(fault.code, "CLAUDE_HARNESS_PATCH_SECRET_DETECTED", variant);
      assertFalse(JSON.stringify(outcome).includes(leak), variant);
      assertEquals(publicationCount.count, 0, variant);
      assertEquals(await gitHead(scratch.dir), beforeHead, variant);
    }
  },
});

Deno.test({
  name:
    "no credentials file leaves redaction unchanged and fails closed (#430)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-oauth-none-");
    const empty = await Deno.makeTempDir({ prefix: "bakery-claude-empty-" });
    oauthSources.push(empty);
    const fake = await fakeClaude(scratch.dir, "exit 0");
    const value = await assignment();
    const executor = executorFor(scratch.dir, fake, 5_000, {
      authSourceDir: empty,
    });
    // A missing file adds no redaction value (behaviour unchanged) ...
    assertEquals(await executor.credentialRedactionSecrets!(value), []);
    // ... and the run itself still fails closed on the missing login.
    const outcome = await executor.execute(
      value,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_CREDENTIAL_UNAVAILABLE",
    );
    // An unparseable credentials file fails the hook closed.
    await Deno.writeTextFile(`${empty}/.credentials.json`, "not json");
    await assertRejects(
      () => executor.credentialRedactionSecrets!(value),
      Error,
      "HARNESS_CREDENTIAL_FILE_INVALID",
    );
  },
});

Deno.test({
  name: "quota fault carries no provider free text or secret (#425)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-quota-sec-");
    const configured = `configured-redaction-secret-${crypto.randomUUID()}`;
    const token = `sk-ant-oat01-SYNTHETIC-${crypto.randomUUID()}`;
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"limit hit ${configured} ${token}"}]},"error":"rate_limit","session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":true,"result":"limit hit ${configured} ${token}","session_id":"${SESSION_ID}"}'
exit 1`,
    );
    const beforeHead = await gitHead(scratch.dir);
    const publicationCount = { count: 0 };
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      publicationCount,
      redactionSecrets: [configured],
    }).execute(await assignment(), new AbortController().signal);
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "quota_exceeded",
    );
    const serialized = JSON.stringify(outcome);
    assertFalse(serialized.includes(configured));
    assertFalse(serialized.includes(token));
    assertFalse(serialized.includes("limit hit"));
    assertEquals(publicationCount.count, 0);
    assertEquals(await gitHead(scratch.dir), beforeHead);
  },
});

Deno.test({
  name: "adapter timeout interrupts pending redactor carry without publication",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-carry-");
    const secret = "split-secret";
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s' 'split-'
sleep 60`,
    );
    const value = await assignment();
    const beforeHead = await gitHead(scratch.dir);
    const publicationCount = { count: 0 };
    const fixture = await nativeCaptureFixture(value, [secret]);
    const split = splitNativeCapture(fixture.capture, "split-");
    try {
      const outcome = await executorFor(scratch.dir, fake, 250, {
        publicationCount,
      }).execute(value, new AbortController().signal, split.sink);
      assertEquals(outcome.status, "failed");
      if (outcome.status !== "failed") throw new Error("unreachable");
      const fault = outcome.fault;
      if (
        fault === null || typeof fault !== "object" ||
        Array.isArray(fault)
      ) throw new Error("missing Claude timeout fault");
      assertEquals(
        "code" in fault ? fault.code : undefined,
        "CLAUDE_HARNESS_TIMEOUT",
      );
      assertEquals(await fixture.capture.finish(), {
        capture: "interrupted",
        reason: "source-lost",
      });
      const emitted = split.writes
        .filter((write) => write.channel === "stdout")
        .map((write) => new TextDecoder().decode(write.bytes))
        .join("");
      assert(emitted.includes("split-"));
      const persisted = JSON.stringify(fixture.spool.records());
      assertFalse(persisted.includes(secret));
      assertFalse(persisted.includes("split-"));
      assert(persisted.includes("unknown bytes discarded"));
      assertEquals(publicationCount.count, 0);
      assertEquals(await gitHead(scratch.dir), beforeHead);
    } finally {
      await Deno.remove(fixture.directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "adapter capture truncation preserves terminal spool capacity",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-saturation-");
    const fake = await fakeClaude(
      scratch.dir,
      `head -c 500000 /dev/zero | tr '\\0' y`,
    );
    const value = await assignment();
    const beforeHead = await gitHead(scratch.dir);
    const publicationCount = { count: 0 };
    const saturation = { spool: undefined as EventSpool | undefined };
    const fixture = await nativeCaptureFixture(value, [], {
      maxRecords: 25,
      maxBytes: 12 * 1024 * 1024,
      waitForAck: async () => {
        const spool = saturation.spool;
        if (!spool) return;
        const last = spool.records().filter((record) =>
          record.type === "job.output"
        ).at(-1);
        if (last) await spool.acknowledge(value.attemptId, last.localSeq);
      },
    });
    saturation.spool = fixture.spool;
    try {
      const outcome = await executorFor(scratch.dir, fake, 10_000, {
        publicationCount,
      }).execute(value, new AbortController().signal, fixture.capture);
      assertEquals(outcome.status, "failed");
      assertEquals(await fixture.capture.finish(), {
        capture: "truncated",
        reason: "text-limit",
      });
      const output = fixture.spool.records().filter((record) =>
        record.type === "job.output"
      );
      const depth = fixture.spool.outputDepth(value.attemptId);
      assert(
        depth.bytes >=
          NATIVE_OUTPUT_LIMITS.outstandingBytes -
            NATIVE_OUTPUT_LIMITS.statusReserveBytes -
            NATIVE_OUTPUT_LIMITS.appendBytes,
        `unexpected saturated output depth: ${JSON.stringify(depth)}`,
      );
      assert(depth.records <= NATIVE_OUTPUT_LIMITS.outstandingRecords);
      assert(depth.bytes <= NATIVE_OUTPUT_LIMITS.outstandingBytes);
      const persistedBeforeDrain = JSON.parse(
        await Deno.readTextFile(fixture.spool.path),
      ) as Record<string, unknown>;
      const persistedRecords = persistedBeforeDrain.records;
      assert(Array.isArray(persistedRecords));
      assert(persistedRecords.length <= fixture.spool.maxRecords);
      assert(
        new TextEncoder().encode(
          JSON.stringify(persistedBeforeDrain),
        ).byteLength <= fixture.spool.maxBytes,
      );
      const reservations = persistedBeforeDrain.terminalReservations as Record<
        string,
        unknown
      >;
      assertEquals(
        reservations[value.attemptId],
        terminalReservationBytes({
          attemptId: value.attemptId,
          leaseToken: value.leaseToken,
          fence: value.fence,
        }),
      );
      const statuses = output.flatMap((record) =>
        (record.payload as OutputBatch).parts
      ).filter((part) => part.channel === "status");
      assertEquals(statuses.length, 1);
      assert(statuses[0]!.text.includes("truncated"));
      assertEquals(publicationCount.count, 0);
      assertEquals(await gitHead(scratch.dir), beforeHead);
      assert(fixture.spool.hasPendingOutputClose(value.attemptId));
      let closeError: unknown;
      try {
        await fixture.spool.enqueueNextResult({
          attemptId: value.attemptId,
          leaseToken: value.leaseToken,
          fence: value.fence,
          eventId: crypto.randomUUID(),
          status: "failed",
          fault: { code: "CLAUDE_HARNESS_EXIT_NONZERO" },
        });
      } catch (error) {
        closeError = error;
      }
      assert(closeError instanceof SpoolError);
      assertEquals(closeError.code, "SPOOL_OUTPUT_CLOSE_PENDING");
      const last = fixture.spool.records().at(-1);
      if (last) await fixture.spool.acknowledge(value.attemptId, last.localSeq);
      await fixture.spool.acknowledgeOutputClose(value.attemptId);
      const result = await fixture.spool.enqueueNextResult({
        attemptId: value.attemptId,
        leaseToken: value.leaseToken,
        fence: value.fence,
        eventId: crypto.randomUUID(),
        status: "failed",
        fault: { code: "CLAUDE_HARNESS_EXIT_NONZERO" },
      });
      assertEquals(result.type, "result");
    } finally {
      await Deno.remove(fixture.directory, { recursive: true });
    }
  },
});
Deno.test({
  name:
    "overlapping Claude executions return retryable busy and abort kills the child",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-busy-");
    const marker = `${scratch.dir}/started`;
    const childPid = `${scratch.dir}/child.pid`;
    const beforeHead = await gitHead(scratch.dir);
    const fake = await fakeClaude(
      scratch.dir,
      `sleep 60 &\necho $! > '${childPid}'\ntouch '${marker}'\nwait`,
    );
    const executor = executorFor(scratch.dir, fake, 300_000);
    const controller = new AbortController();
    const first = executor.execute(
      await assignment(),
      controller.signal,
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await Deno.stat(marker);
        break;
      } catch {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 10);
        await promise;
      }
    }
    await Deno.stat(marker);
    const second = await executor.execute(
      await assignment(),
      new AbortController().signal,
    );
    assertEquals(second.status, "failed");
    if (second.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (second.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_BUSY",
    );
    assertEquals((second.fault as Record<string, unknown>).retryable, true);
    controller.abort();
    assertEquals((await first).status, "canceled");
    assertEquals(await gitHead(scratch.dir), beforeHead);
    const childCheck = await new Deno.Command("kill", {
      args: ["-0", (await Deno.readTextFile(childPid)).trim()],
      stdout: "null",
      stderr: "null",
    }).output();
    assertFalse(childCheck.success);
  },
});

Deno.test({
  name: "Claude timeout is retryable and does not fabricate usage",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-timeout-");
    const fake = await fakeClaude(scratch.dir, "sleep 60");
    const outcome = await executorFor(scratch.dir, fake, 1_000).execute(
      await assignment(),
      new AbortController().signal,
    );
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_TIMEOUT",
    );
    assertEquals((outcome.fault as Record<string, unknown>).retryable, true);
    assertFalse("usage" in outcome);
  },
});
Deno.test({
  name: "Claude exit 143 is non-retryable and cannot publish",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-143-");
    const fake = await fakeClaude(scratch.dir, "exit 143");
    const beforeHead = await gitHead(scratch.dir);
    const publicationCount = { count: 0 };
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      publicationCount,
    }).execute(await assignment(), new AbortController().signal);
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_EXIT_NONZERO",
    );
    assertEquals((outcome.fault as Record<string, unknown>).retryable, false);
    assertEquals(publicationCount.count, 0);
    assertEquals(await gitHead(scratch.dir), beforeHead);
  },
});

Deno.test({
  name: "matching resume metadata without retained local state starts fresh",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-fresh-");
    const argsPath = `${scratch.dir}/args.txt`;
    const value = await assignment();
    const input = value.input as Record<string, unknown>;
    const baseSha = await gitHead(scratch.dir);
    const checkpoint = {
      agentSessionId: value.agentSessionId,
      nativeSessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    };
    value.currentCheckpoints = [checkpoint] as never;
    input.resume = {
      sessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    };
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' "$@" > '${argsPath}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const outcome = await executorFor(scratch.dir, fake).execute(
      value,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
    assertFalse((await Deno.readTextFile(argsPath)).includes("--resume"));
  },
});

Deno.test({
  name: "successful Claude run retains selected session content and sidecar",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-retain-");
    const authSource = await syntheticAuthSource(scratch.dir);
    const value = await assignment();
    const input = value.input as Record<string, unknown>;
    const baseSha = await gitHead(scratch.dir);
    const repositoryId = input.repositoryId as string;
    value.currentCheckpoints = [{
      agentSessionId: value.agentSessionId,
      nativeSessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    }] as never;
    const nativeRecord = nativeSessionRecord();
    const fake = await fakeClaude(
      scratch.dir,
      `mkdir -p "$CLAUDE_CONFIG_DIR/projects"
printf '%s\\n' '${nativeRecord}' > "$CLAUDE_CONFIG_DIR/projects/retained.jsonl"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      authSourceDir: authSource,
    }).execute(value, new AbortController().signal);
    assertEquals(outcome.status, "completed");
    const statePath =
      `${scratch.dir}/state/claude-harness/sessions/${repositoryId}/${value.agentSessionId}/${SESSION_ID}`;
    assertEquals(
      await Deno.readTextFile(`${statePath}/projects/retained.jsonl`),
      `${nativeRecord}\n`,
    );
    const nativeFileSha256 = await sha256Hex(
      new TextEncoder().encode(`${nativeRecord}\n`),
    );
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(`${statePath}/.bakery-checkpoint.json`),
      ),
      {
        schemaVersion: 1,
        repositoryId,
        agentSessionId: value.agentSessionId,
        sessionId: SESSION_ID,
        checkpointToken: "checkpoint-1",
        worktreeRevision: baseSha,
        harnessVersion: CLAUDE_FAKE_VERSION,
        nativeFile: "projects/retained.jsonl",
        nativeFileSha256,
      },
    );
  },
});
Deno.test({
  name: "todo/settings-only retained Claude state cannot authorize resume",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository(
      "bakery-claude-todo-settings-",
    );
    const authSource = await syntheticAuthSource(scratch.dir);
    const value = await assignment();
    const input = value.input as Record<string, unknown>;
    const baseSha = await gitHead(scratch.dir);
    const repositoryId = input.repositoryId as string;
    const statePath =
      `${scratch.dir}/state/claude-harness/sessions/${repositoryId}/${value.agentSessionId}/${SESSION_ID}`;
    await writeCheckpointSidecar(statePath, {
      repositoryId,
      agentSessionId: value.agentSessionId!,
      sessionId: SESSION_ID,
      checkpointToken: "checkpoint-1",
      worktreeRevision: baseSha,
    });
    await Deno.writeTextFile(`${statePath}/settings.json`, "{}");
    await Deno.mkdir(`${statePath}/todos`, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(`${statePath}/todos/unrelated.json`, "[]");
    value.currentCheckpoints = [{
      agentSessionId: value.agentSessionId,
      nativeSessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    }] as never;
    input.resume = {
      sessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    };
    const argsPath = `${scratch.dir}/args.txt`;
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' "$@" > '${argsPath}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      authSourceDir: authSource,
    }).execute(value, new AbortController().signal);
    assertEquals(outcome.status, "completed");
    assertFalse((await Deno.readTextFile(argsPath)).includes("--resume"));
  },
});

Deno.test({
  name: "wrong native session identity cannot authorize resume",
  ...RUN_PERMISSIONS,
  fn: () =>
    assertNativeResumeStartsFresh(
      "bakery-claude-wrong-native-session-",
      `${nativeSessionRecord("00000000-0000-4000-8000-000000000003")}\n`,
    ),
});

Deno.test({
  name: "incidental native UUID mention cannot authorize resume",
  ...RUN_PERMISSIONS,
  fn: () =>
    assertNativeResumeStartsFresh(
      "bakery-claude-incidental-native-session-",
      `${
        JSON.stringify({
          type: "assistant",
          message: `reference ${SESSION_ID}`,
        })
      }\n`,
    ),
});

Deno.test({
  name: "malformed native session record cannot authorize resume",
  ...RUN_PERMISSIONS,
  fn: () =>
    assertNativeResumeStartsFresh(
      "bakery-claude-malformed-native-session-",
      `{"type":"system","session_id":"${SESSION_ID}"\n`,
    ),
});

Deno.test({
  name: "native session digest sidecar mismatch cannot authorize resume",
  ...RUN_PERMISSIONS,
  fn: () =>
    assertNativeResumeStartsFresh(
      "bakery-claude-native-digest-mismatch-",
      `${nativeSessionRecord()}\n`,
      "0".repeat(64),
    ),
});

Deno.test({
  name: "a Claude checkpoint from another CLI version cannot authorize resume",
  ...RUN_PERMISSIONS,
  fn: () =>
    assertNativeResumeStartsFresh(
      "bakery-claude-version-mismatch-",
      `${nativeSessionRecord()}\n`,
      undefined,
      { harnessVersion: "2.0.0 (Claude Code)" },
    ),
});

Deno.test({
  name:
    "a Claude checkpoint sidecar without a CLI version cannot authorize resume",
  ...RUN_PERMISSIONS,
  fn: () =>
    assertNativeResumeStartsFresh(
      "bakery-claude-version-missing-",
      `${nativeSessionRecord()}\n`,
      undefined,
      { harnessVersion: undefined },
    ),
});

Deno.test({
  name: "mismatched retained Claude checkpoint evidence starts fresh",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-mismatch-");
    const authSource = await syntheticAuthSource(scratch.dir);
    const value = await assignment();
    const input = value.input as Record<string, unknown>;
    const baseSha = await gitHead(scratch.dir);
    const repositoryId = input.repositoryId as string;
    const statePath =
      `${scratch.dir}/state/claude-harness/sessions/${repositoryId}/${value.agentSessionId}/${SESSION_ID}`;
    await Deno.mkdir(`${statePath}/projects`, { recursive: true, mode: 0o700 });
    const nativeRecord = nativeSessionRecord();
    const nativeFile = `${statePath}/projects/retained.jsonl`;
    await Deno.writeTextFile(nativeFile, `${nativeRecord}\n`);
    await writeCheckpointSidecar(statePath, {
      repositoryId,
      agentSessionId: value.agentSessionId!,
      sessionId: SESSION_ID,
      checkpointToken: "wrong-token",
      worktreeRevision: baseSha,
      nativeFile: "projects/retained.jsonl",
    });
    value.currentCheckpoints = [{
      agentSessionId: value.agentSessionId,
      nativeSessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    }] as never;
    input.resume = {
      sessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    };
    const argsPath = `${scratch.dir}/args.txt`;
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' "$@" > '${argsPath}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      authSourceDir: authSource,
    }).execute(value, new AbortController().signal);
    assertEquals(outcome.status, "completed");
    assertFalse((await Deno.readTextFile(argsPath)).includes("--resume"));
  },
});

Deno.test({
  name: "resume rejects a different returned Claude session identity",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-resume-id-");
    const authSource = await syntheticAuthSource(scratch.dir);
    const value = await assignment();
    const input = value.input as Record<string, unknown>;
    const baseSha = await gitHead(scratch.dir);
    const repositoryId = input.repositoryId as string;
    const statePath =
      `${scratch.dir}/state/claude-harness/sessions/${repositoryId}/${value.agentSessionId}/${SESSION_ID}`;
    await Deno.mkdir(`${statePath}/projects`, { recursive: true, mode: 0o700 });
    const nativeRecord = nativeSessionRecord();
    await Deno.writeTextFile(
      `${statePath}/projects/retained.jsonl`,
      `${nativeRecord}\n`,
    );
    await writeCheckpointSidecar(statePath, {
      repositoryId,
      agentSessionId: value.agentSessionId!,
      sessionId: SESSION_ID,
      checkpointToken: "checkpoint-1",
      worktreeRevision: baseSha,
      nativeFile: "projects/retained.jsonl",
    });
    value.currentCheckpoints = [{
      agentSessionId: value.agentSessionId,
      nativeSessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
      localStatePath: statePath,
    }] as never;
    input.resume = {
      sessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    };
    const otherSession = "00000000-0000-4000-8000-000000000003";
    const beforeHead = await gitHead(scratch.dir);
    const publicationCount = { count: 0 };
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${otherSession}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${otherSession}"}'`,
    );
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      authSourceDir: authSource,
      publicationCount,
    }).execute(value, new AbortController().signal);
    assertEquals(outcome.status, "failed");
    assertEquals(publicationCount.count, 0);
    assertEquals(await gitHead(scratch.dir), beforeHead);
  },
});
Deno.test({
  name:
    "retained local Claude state is restored before resume and removed after",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-resume-");
    const authSource = await syntheticAuthSource(scratch.dir);
    const value = await assignment();
    const input = value.input as Record<string, unknown>;
    const baseSha = await gitHead(scratch.dir);
    const repositoryId = input.repositoryId as string;
    const statePath =
      `${scratch.dir}/state/claude-harness/sessions/${repositoryId}/${value.agentSessionId}/${SESSION_ID}`;
    await Deno.mkdir(`${statePath}/projects`, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(
      `${statePath}/.credentials.json`,
      "synthetic-resume-oauth",
    );
    const nativeRecord = nativeSessionRecord();
    await Deno.writeTextFile(
      `${statePath}/projects/retained.jsonl`,
      `${nativeRecord}\n`,
    );
    await writeCheckpointSidecar(statePath, {
      repositoryId,
      agentSessionId: value.agentSessionId!,
      sessionId: SESSION_ID,
      checkpointToken: "checkpoint-1",
      worktreeRevision: baseSha,
      nativeFile: "projects/retained.jsonl",
    });
    await Deno.writeTextFile(`${statePath}/ignored.txt`, "must-not-copy");
    const checkpoint = {
      agentSessionId: value.agentSessionId,
      nativeSessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
      localStatePath: statePath,
    };
    value.currentCheckpoints = [checkpoint] as never;
    input.resume = {
      sessionId: SESSION_ID,
      worktreeRevision: baseSha,
      resumeHandleRef: "checkpoint-1",
    };
    const argsPath = `${scratch.dir}/args.txt`;
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' "$@" > '${argsPath}'
cat "$CLAUDE_CONFIG_DIR/.credentials.json" > '${scratch.dir}/observed-resume-auth'
cat "$CLAUDE_CONFIG_DIR/projects/retained.jsonl" > '${scratch.dir}/observed-resume-native'
test ! -f "$CLAUDE_CONFIG_DIR/ignored.txt"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      authSourceDir: authSource,
    }).execute(
      value,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
    assert((await Deno.readTextFile(argsPath)).includes("--resume\n"));
    const attemptConfig =
      `${scratch.dir}/state/claude-harness/${value.attemptId}`;
    assertEquals(
      await Deno.readTextFile(`${scratch.dir}/observed-resume-auth`),
      SYNTHETIC_CLAUDE_CREDENTIALS,
    );
    assertEquals(
      await Deno.readTextFile(`${scratch.dir}/observed-resume-native`),
      `${nativeRecord}\n`,
    );
    assertFalse(
      await Deno.stat(attemptConfig).then(
        () => true,
        () => false,
      ),
    );
  },
});

Deno.test({
  name: "Claude commit and digest publication failures remain normalized",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const commitScratch = await prepareScratchRepository(
      "bakery-claude-commit-",
    );
    const hook = `${commitScratch.dir}/.git/hooks/pre-commit`;
    await Deno.writeTextFile(hook, "#!/bin/sh\nexit 1\n");
    await Deno.chmod(hook, 0o755);
    const commitFake = await fakeClaude(
      commitScratch.dir,
      `printf '%s\\n' changed > '${commitScratch.dir}/patch.txt'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const commitBefore = await gitHead(commitScratch.dir);
    const commitOutcome = await executorFor(
      commitScratch.dir,
      commitFake,
    ).execute(await assignment(), new AbortController().signal);
    assertEquals(commitOutcome.status, "failed");
    if (commitOutcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (commitOutcome.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_COMMIT_FAILED",
    );
    assertEquals(await gitHead(commitScratch.dir), commitBefore);

    const digestScratch = await prepareScratchRepository(
      "bakery-claude-digest-",
    );
    const digestFake = await fakeClaude(
      digestScratch.dir,
      `printf '%s\\n' changed > '${digestScratch.dir}/patch.txt'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const digestOutcome = await executorFor(
      digestScratch.dir,
      digestFake,
      5_000,
      { badDigest: true },
    ).execute(await assignment(), new AbortController().signal);
    assertEquals(digestOutcome.status, "failed");
    if (digestOutcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (digestOutcome.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_ARTIFACT_DIGEST_MISMATCH",
    );
  },
});

const PATCH_CANARY = "canary-secret-Zq81xPLm47vN";

async function gitStatusPorcelain(dir: string): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["-C", dir, "status", "--porcelain"],
    stdout: "piped",
  }).output();
  if (!result.success) throw new Error("GIT_STATUS_READ_FAILED");
  return new TextDecoder().decode(result.stdout);
}

async function runPatchCanary(
  prefix: string,
  write: (dir: string) => string,
  expected: string | null,
): Promise<void> {
  const scratch = await prepareScratchRepository(prefix);
  const beforeHead = await gitHead(scratch.dir);
  const publicationCount = { count: 0 };
  const fake = await fakeClaude(
    scratch.dir,
    `${write(scratch.dir)}
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
  );
  const outcome = await executorFor(scratch.dir, fake, 5_000, {
    publicationCount,
    redactionSecrets: [PATCH_CANARY],
  }).execute(await assignment(), new AbortController().signal);
  if (expected === null) {
    assertEquals(outcome.status, "completed");
    assertEquals(publicationCount.count, 1);
    return;
  }
  assertEquals(outcome.status, "failed");
  if (outcome.status !== "failed") throw new Error("unreachable");
  const fault = outcome.fault as Record<string, unknown>;
  assertEquals(fault.code, expected);
  assertEquals(fault.status, 422);
  assertEquals(fault.retryable, false);
  assertFalse(JSON.stringify(fault).includes(PATCH_CANARY));
  assertEquals(publicationCount.count, 0);
  assertEquals(await gitHead(scratch.dir), beforeHead);
  assertEquals(await gitStatusPorcelain(scratch.dir), "");
}

Deno.test({
  name: "patch holding a configured secret in a text file is not published",
  ...RUN_PERMISSIONS,
  fn: () =>
    runPatchCanary(
      "bakery-claude-patch-text-",
      (dir) => `printf '%s\\n' '${PATCH_CANARY}' > '${dir}/leak.txt'`,
      "CLAUDE_HARNESS_PATCH_SECRET_DETECTED",
    ),
});

Deno.test({
  name: "patch holding a configured secret in a binary file is not published",
  ...RUN_PERMISSIONS,
  fn: () =>
    runPatchCanary(
      "bakery-claude-patch-binary-",
      (dir) => `printf 'x\\0%s' '${PATCH_CANARY}' > '${dir}/bin.dat'`,
      "CLAUDE_HARNESS_PATCH_SECRET_DETECTED",
    ),
});

Deno.test({
  name: "clean patch still publishes when secrets are configured",
  ...RUN_PERMISSIONS,
  fn: () =>
    runPatchCanary(
      "bakery-claude-patch-clean-",
      (dir) => `printf '%s\\n' clean > '${dir}/ok.txt'`,
      null,
    ),
});

async function runDirtyWorktree(
  prefix: string,
  dirty: (dir: string) => Promise<void>,
): Promise<void> {
  const scratch = await prepareScratchRepository(prefix);
  await dirty(scratch.dir);
  const beforeHead = await gitHead(scratch.dir);
  const beforeStatus = await gitStatusPorcelain(scratch.dir);
  const publicationCount = { count: 0 };
  const marker = `${scratch.dir}/child-started`;
  const fake = await fakeClaude(
    scratch.dir,
    `printf 'started\\n' >> '${marker}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
  );
  const outcome = await executorFor(scratch.dir, fake, 5_000, {
    publicationCount,
  }).execute(await assignment(), new AbortController().signal);
  assertEquals(outcome.status, "failed");
  if (outcome.status !== "failed") throw new Error("unreachable");
  const fault = outcome.fault as Record<string, unknown>;
  assertEquals(fault.code, "CLAUDE_HARNESS_WORKTREE_DIRTY");
  assertEquals(fault.status, 409);
  assertEquals(fault.retryable, false);
  assertFalse(JSON.stringify(fault).includes("leftover"));
  assertEquals(publicationCount.count, 0);
  let started = "";
  try {
    started = await Deno.readTextFile(marker);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  assertEquals(started, "");
  assertEquals(await gitHead(scratch.dir), beforeHead);
  assertEquals(await gitStatusPorcelain(scratch.dir), beforeStatus);
}

Deno.test({
  name: "dirty tracked file refuses the run before the child starts",
  ...RUN_PERMISSIONS,
  fn: () =>
    runDirtyWorktree(
      "bakery-claude-dirty-tracked-",
      (dir) => Deno.writeTextFile(`${dir}/notes.txt`, "edited leftover\n"),
    ),
});

Deno.test({
  name: "untracked file refuses the run before the child starts",
  ...RUN_PERMISSIONS,
  fn: () =>
    runDirtyWorktree(
      "bakery-claude-dirty-untracked-",
      (dir) => Deno.writeTextFile(`${dir}/leftover-new.txt`, "leftover\n"),
    ),
});

async function coordinatorSecurityRun(
  scratchDir: string,
  auxDir: string,
  body: string,
  options: { readonly timeLimitMs?: number; readonly signal?: AbortSignal } =
    {},
) {
  await Deno.mkdir(`${auxDir}/auth-source`, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    `${auxDir}/auth-source/.credentials.json`,
    "synthetic-oauth",
  );
  const fake = `${auxDir}/fake-claude`;
  await Deno.writeTextFile(fake, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(fake, 0o755);
  const input = buildCoordinatorTurnJobInput({
    turnId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    contextThroughSequence: "1",
    messages: [{
      sequence: "1",
      authorId: crypto.randomUUID(),
      messageType: "user_message",
      intent: "agent_request",
      body: "plan the change",
    }],
    scope: { applicationId: null, repositoryId: null, taskId: null },
    openQuestions: [],
    currentPlanRevision: null,
  });
  const value = {
    ...localAssignment(),
    action: COORDINATOR_TURN_ACTION,
    input,
  } as JobAssignment;
  const outcome = await createClaudeHarnessExecutor({
    publishFor: () => () => Promise.reject(new Error("unexpected publish")),
    repositoryFor: () => scratchDir,
    claudeExecutable: fake,
    stateDir: `${auxDir}/state`,
    authSourceDir: `${auxDir}/auth-source`,
    coordinatorTimeLimitMs: options.timeLimitMs ?? 5_000,
  }).execute(value, options.signal ?? new AbortController().signal);
  return { outcome, value };
}

const COORDINATOR_STREAM =
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.296","model":"fake"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}","structured_output":{"effects":[{"type":"noop"}]}}'`;

Deno.test({
  name:
    "Coordinator child holds no Bakery credentials, no --add-dir, and a config dir outside the repository",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-coord-sec-repo-");
    const aux = await Deno.makeTempDir({ prefix: "bakery-coord-sec-aux-" });
    const dump = `${aux}/dump.txt`;
    const parentNames = [
      "BAKERY_WORKER_ENROLLMENT_TOKEN",
      "BAKERY_SERVER_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ];
    for (const name of parentNames) Deno.env.set(name, "secret-value");
    try {
      const { outcome } = await coordinatorSecurityRun(
        scratch.dir,
        aux,
        `env > '${dump}.env'
printf '%s\\n' "$@" > '${dump}.args'
cp "$CLAUDE_CONFIG_DIR/.credentials.json" '${dump}.cred' 2>/dev/null
printf '%s' "$CLAUDE_CONFIG_DIR" > '${dump}.config'
${COORDINATOR_STREAM}`,
      );
      assertEquals(outcome.status, "completed");
      const variables = Object.fromEntries(
        (await Deno.readTextFile(`${dump}.env`)).trim().split("\n").map(
          (line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index), line.slice(index + 1)];
          },
        ),
      );
      for (const name of Object.keys(variables)) {
        assertFalse(name.startsWith("BAKERY_"), `leaked ${name}`);
      }
      assertEquals(variables.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assertEquals(variables.ANTHROPIC_API_KEY, undefined);
      const repoReal = await Deno.realPath(scratch.dir);
      const configDir = await Deno.readTextFile(`${dump}.config`);
      // The attempt root (config dir and child HOME) is removed after the
      // run, so resolve the nearest surviving ancestor instead.
      let ancestor = configDir.slice(0, configDir.lastIndexOf("/"));
      while (!(await Deno.stat(ancestor).then(() => true, () => false))) {
        ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
      }
      const configParent = await Deno.realPath(ancestor);
      assert(
        configParent !== repoReal && !configParent.startsWith(`${repoReal}/`),
        `config dir ${configParent} is inside ${repoReal}`,
      );
      assertEquals(
        await Deno.readTextFile(`${dump}.cred`),
        "synthetic-oauth",
      );
      const args = (await Deno.readTextFile(`${dump}.args`)).split("\n");
      assertFalse(args.includes("--add-dir"));
      assert(args.includes("--restricted"));
      assert(args.includes("--strict-mcp-config"));
    } finally {
      for (const name of parentNames) Deno.env.delete(name);
    }
  },
});

Deno.test({
  name:
    "Coordinator results and faults never carry credentials and the whole process group dies on timeout",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-coord-sec2-repo-");
    const aux = await Deno.makeTempDir({ prefix: "bakery-coord-sec2-aux-" });
    const leaked = await coordinatorSecurityRun(
      scratch.dir,
      aux,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.296","model":"fake"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}","result":"synthetic-oauth sk-ant-leak","structured_output":{"effects":[{"type":"bogus"}]}}'`,
    );
    assertEquals(leaked.outcome.status, "failed");
    const faultText = JSON.stringify(leaked.outcome);
    assertFalse(faultText.includes("synthetic-oauth"));
    assertFalse(faultText.includes("sk-ant-leak"));

    const aux2 = await Deno.makeTempDir({ prefix: "bakery-coord-sec3-aux-" });
    const timed = await coordinatorSecurityRun(
      scratch.dir,
      aux2,
      `sleep 35 &
echo $! > '${aux2}/child.pid'
wait`,
      { timeLimitMs: 500 },
    );
    assertEquals(timed.outcome.status, "failed");
    if (timed.outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (timed.outcome.fault as Record<string, unknown>).code,
      "CLAUDE_COORDINATOR_TIMEOUT",
    );
    const pid = (await Deno.readTextFile(`${aux2}/child.pid`)).trim();
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      alive = await Deno.stat(`/proc/${pid}`).then(() => true, () => false);
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assertFalse(alive, "background child survived the process-group kill");
  },
});
