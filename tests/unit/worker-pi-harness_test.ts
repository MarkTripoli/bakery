import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { syntheticAuthSource } from "../helpers/harness-auth.ts";
import {
  createPiHarnessExecutor,
  type PiHarnessControl,
  selectPiResumeSessionFile,
} from "../../apps/worker/src/pi-harness.ts";
import { outcomeResult } from "../../apps/worker/src/supervisor-support.ts";
import { validateWorkerReferences } from "../../packages/persistence/src/event-journal.ts";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";
import type { AttemptRow } from "../../packages/persistence/src/types.ts";
import { workerActionOutputSchema } from "../../packages/contracts/src/contracts.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import { prepareScratchRepository } from "../helpers/harness.ts";

const RUN_PERMISSIONS = {
  sanitizeResources: false,
  sanitizeOps: false,
} as const;
const SESSION_ID = "00000000-0000-4000-8000-000000000011";
const FOREIGN_ID = "00000000-0000-4000-8000-000000000099";

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

async function assignment(
  scratchDir: string,
  repositoryId = crypto.randomUUID(),
): Promise<JobAssignment> {
  const base = localAssignment();
  return {
    ...base,
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId,
      planArtifact: crypto.randomUUID(),
      repositoryProfile: await repositoryProfile(),
      instructions: "Do not change any file.",
      scratchDir,
    },
  } as JobAssignment;
}

async function fakePi(
  dir: string,
  mode:
    | "complete"
    | "parse"
    | "control"
    | "overflow"
    | "large"
    | "reference" = "complete",
): Promise<
  { executable: string; argsPath: string; envPath: string; promptPath: string }
> {
  // A model tool call may echo server reference keys; "reference" mode emits
  // one so the shipped result can be checked against reference validation.
  const toolArguments = mode === "reference"
    ? JSON.stringify({
      path: "notes.txt",
      sessionId: FOREIGN_ID,
      nested: { checkRunIds: [FOREIGN_ID], snapshotId: FOREIGN_ID },
    })
    : JSON.stringify({ path: "notes.txt" });
  const argsPath = `${dir}/pi-args.txt`;
  const envPath = `${dir}/pi-env.txt`;
  const promptPath = `${dir}/pi-prompts.txt`;
  const executable = `${dir}/fake-pi`;
  await Deno.writeTextFile(
    executable,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' 'pi 0.8.0-fake'
  exit 0
fi
printf '%s\\n' "$@" > '${argsPath}'
env > '${envPath}'
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
control_count=0
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\\([^\"]*\\)".*/\\1/p')
  case "$line" in
    *'"type":"get_state"'*)
      if [ '${mode}' = 'parse' ]; then
        printf '%s\\n' '{"type":"response","command":"parse","success":false}'
        exit 0
      fi
      printf '%s\\n' '{"id":"'"$id"'","type":"response","command":"get_state","success":true,"data":{"sessionId":"${SESSION_ID}","sessionFile":"session.jsonl","model":{"provider":"fake-provider","id":"fake-model"}}}'
      ;;
    *'"type":"prompt"'*)
      if [ '${mode}' = 'control' ]; then
        case "$line" in
          *'"streamingBehavior":"steer"'*)
            printf '%s\\n' '{"id":"'"$id"'","type":"response","command":"prompt","success":true,"data":{"disposition":"queued"}}'
            control_count=1
            ;;
          *'"streamingBehavior":"followUp"'*)
            printf '%s\\n' '{"id":"'"$id"'","type":"response","command":"prompt","success":true,"data":{"disposition":"queued"}}'
            if [ "$control_count" -eq 1 ]; then
              printf '%s\\n' '{\"type\":\"agent_settled\",\"aborted\":false}'
            fi
            ;;
          *)
            printf '%s\\n' "$line" >> '${promptPath}'
            printf '%s\\n' '{"id":"'"$id"'","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
            ;;
        esac
      else
        printf '%s\\n' "$line" >> '${promptPath}'
        printf '%s\\n' '{"id":"'"$id"'","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
        printf '%s\\n' '{\"type\":\"agent_start\"}'
        if [ '${mode}' = 'overflow' ]; then
          printf '%s\\n' '{\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"content\":[]}}'
          chunk=$(printf '%060000d' 0 | tr '0' a)
          i=0
          while [ "$i" -lt 141 ]; do
            printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"%s"}}\\n' "$chunk"
            i=$((i + 1))
          done
          printf '%s\\n' '{\"type\":\"agent_settled\",\"aborted\":false}'
          exit 0
        fi
        if [ '${mode}' = 'large' ]; then
          large=$(printf '%015000d' 0 | tr '0' a)
          i=0
          while [ "$i" -lt 40 ]; do
            printf '{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\\n' "$large"
            printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"%s"}],"stopReason":"stop"}}\\n' "$large"
            printf '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"%s"}],"stopReason":"stop"},"toolResults":[]}\\n' "$large"
            i=$((i + 1))
          done
          printf '%s\\n' '{\"type\":\"agent_settled\",\"aborted\":false}'
          exit 0
        fi
        printf '%s\\n' '{\"type\":\"turn_start\"}'
        printf '%s\\n' '{\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"content\":[]}}'
        printf '%s\\n' '{\"type\":\"message_update\",\"usage\":{\"input\":3,\"output\":5,\"totalTokens\":8},\"assistantMessageEvent\":{\"type\":\"text_start\",\"contentIndex\":0}}'
        printf '%s\\n' '{"type":"message_update","usage":{"input":3,"output":5,"totalTokens":8},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hello   "}}'
        printf '%s\\n' '{"type":"message_update","usage":{"input":3,"output":5,"totalTokens":8},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"hello   world"}}'
        printf '%s\\n' '{\"type\":\"message_update\",\"usage\":{\"input\":3,\"output\":5,\"totalTokens\":8},\"assistantMessageEvent\":{\"type\":\"toolcall_start\",\"contentIndex\":1,\"id\":\"call-1\",\"toolName\":\"read\"}}'
        printf '%s\\n' '{\"type\":\"message_update\",\"usage\":{\"input\":3,\"output\":5,\"totalTokens\":8},\"assistantMessageEvent\":{\"type\":\"toolcall_delta\",\"contentIndex\":1,\"delta\":\"{\\\"path\\\":\\\"notes.txt\\\"}\"}}'
        printf '%s\\n' '{\"type\":\"message_update\",\"usage\":{\"input\":3,\"output\":5,\"totalTokens\":8},\"assistantMessageEvent\":{\"type\":\"toolcall_end\",\"contentIndex\":1,\"toolCall\":{\"type\":\"toolCall\",\"id\":\"call-1\",\"name\":\"read\",\"arguments\":${toolArguments}}}}'
        printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hello   world"},{"type":"toolCall","id":"call-1","name":"read","arguments":${toolArguments}}],"stopReason":"stop"}}'
        printf '%s\\n' '{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\"},\"toolResults\":[]}'
        printf '%s\\n' '{\"type\":\"agent_end\",\"messages\":[],\"willRetry\":false}'
        printf '%s\\n' '{\"type\":\"agent_settled\",\"aborted\":false}'
      fi
      ;;
  esac
done
`,
  );
  await Deno.chmod(executable, 0o755);
  return { executable, argsPath, envPath, promptPath };
}

function executorFor(
  worktree: string,
  fakeExecutable: string,
  stateDir: string,
  options: {
    readonly piAgentSourceDir?: string;
    readonly timeLimitMs?: number;
    readonly capabilities?: readonly string[];
    readonly registerControl?: (control: PiHarnessControl | undefined) => void;
  } = {},
) {
  return createPiHarnessExecutor({
    publishFor: () => async (request) => ({
      artifactId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      sha256: await sha256Hex(request.bytes),
    }),
    repositoryFor: () => worktree,
    piExecutable: fakeExecutable,
    stateDir,
    piAgentSourceDir: options.piAgentSourceDir ??
      syntheticAuthSource("auth.json"),
    capabilities: options.capabilities ??
      ["stream", "resume", "steer", "follow_up"],
    registerControl: options.registerControl,
  });
}

Deno.test({
  name:
    "Pi RPC normalizes LF-byte events, waits for agent_settled, and records telemetry only",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-unit-");
    const fake = await fakePi(scratch.dir);
    const repositoryId = crypto.randomUUID();
    const value = await assignment(scratch.dir, repositoryId);
    const stateDir = `${scratch.dir}/worker-state`;
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      stateDir,
    ).execute(value, new AbortController().signal);

    assertEquals(outcome.status, "completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    const result = workerActionOutputSchema("harness.implement").parse(
      outcome.result,
    ) as Record<string, unknown>;
    assertEquals(result.sessionId, value.agentSessionId);
    assertEquals(result.piVersion, "pi 0.8.0-fake");
    const checkpoint = result.checkpoint as Record<string, unknown>;
    assertEquals(checkpoint.repositoryId, repositoryId);
    assertEquals(checkpoint.agentSessionId, value.agentSessionId);
    assertEquals(checkpoint.nativeSessionId, SESSION_ID);
    assertFalse("sessionId" in checkpoint);
    assertEquals(checkpoint.sessionFile, "session.jsonl");
    assertEquals(checkpoint.eligible, true);
    assertEquals(checkpoint.resumeEligible, true);
    assertEquals(checkpoint.checkpointEligible, true);
    assertStringIncludes(
      checkpoint.checkpointToken as string,
      `pi-harness/sessions/${repositoryId}/${value.agentSessionId}/${SESSION_ID}/session.jsonl`,
    );
    assertEquals(result.capabilities, [
      "stream",
      "resume",
      "steer",
      "follow_up",
    ]);
    assertEquals(result.telemetry, {
      providerUsage: { input: 3, output: 5, totalTokens: 8 },
      costUsd: null,
    });
    assertFalse("usage" in outcome);

    const events = result.events as Array<Record<string, unknown>>;
    assertEquals(events.map((event) => event.type), [
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
    const messageEnd = events.find((event) => event.type === "message_end");
    assertEquals(
      (messageEnd?.message as Record<string, unknown>).content,
      [
        { type: "text", text: "hello \u2028\u2029world" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "notes.txt" },
        },
      ],
    );

    const args = await Deno.readTextFile(fake.argsPath);
    assertStringIncludes(args, "--mode\nrpc\n");
    assertStringIncludes(
      args,
      `--session-dir\n${stateDir}/pi-harness/${value.attemptId}/session\n`,
    );
    assertStringIncludes(args, "--no-context-files\n");
    assertStringIncludes(args, "--tools\nread,edit,write,grep,find,ls\n");
    assertStringIncludes(
      await Deno.readTextFile(fake.promptPath),
      "Do not change any file.",
    );
    await assertRejects(() =>
      Deno.stat(`${stateDir}/pi-harness/${value.attemptId}`)
    );
    await Deno.stat(
      `${stateDir}/pi-harness/sessions/${repositoryId}/${value.agentSessionId}/${SESSION_ID}/session.jsonl`,
    );
  },
});

// Answers the reference queries validateWorkerReferences issues for one
// workflow attempt: only the bound agent session and the published artifact
// versions exist; check runs do not.
function referenceTransaction(
  runStepId: string,
  agentSessionId: string,
  artifactVersionIds: ReadonlySet<string>,
): PgTransactionClient {
  return {
    query: (text: string, params: unknown[] = []) => {
      if (text.includes("from bakery.jobs job")) {
        return {
          rows: [{
            action: "harness.implement",
            runId: crypto.randomUUID(),
            runStepId,
            taskId: crypto.randomUUID(),
            jobInput: {},
            inspectionId: null,
          }],
        };
      }
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("from bakery.agent_sessions")) {
        return {
          rows: params[1] === agentSessionId && params[2] === runStepId
            ? [{ id: agentSessionId }]
            : [],
        };
      }
      if (text.includes("from bakery.check_runs")) return { rows: [] };
      if (text.includes("from bakery.artifact_versions")) {
        return {
          rows: artifactVersionIds.has(params[1] as string)
            ? [{ id: params[1] }]
            : [],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as PgTransactionClient;
}

async function referenceErrorCode(
  run: () => Promise<void>,
): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error && typeof error === "object" && "code" in error
      ? error.code
      : error;
  }
  return undefined;
}

Deno.test({
  name:
    "Pi completed result with checkpoint and events passes server reference validation",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-reference-");
    const fake = await fakePi(scratch.dir, "reference");
    const value = await assignment(scratch.dir);
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
    ).execute(value, new AbortController().signal);
    assertEquals(outcome.status, "completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    const result = workerActionOutputSchema("harness.implement").parse(
      outcome.result,
    ) as Record<string, unknown>;
    assert(result.checkpoint);
    const runStepId = crypto.randomUUID();
    const versions = new Set(
      (result.artifacts as Array<Record<string, unknown>>).map((artifact) =>
        artifact.versionId as string
      ),
    );
    const attempt: AttemptRow = {
      id: value.attemptId,
      organizationId: crypto.randomUUID(),
      jobId: value.jobId,
      workerHostId: crypto.randomUUID(),
      workerSessionId: null,
      workerSessionGeneration: "1",
      fence: "1",
      leaseTokenHash: "a".repeat(64),
      leaseExpiresAt: new Date(),
      leaseExpired: false,
      jobCurrentFence: "1",
      status: "running",
      lastEventSeq: "0",
    };
    const transaction = referenceTransaction(
      runStepId,
      value.agentSessionId!,
      versions,
    );
    // The checkpoint alone must not carry a server-resolved session key.
    assertEquals(
      await referenceErrorCode(() =>
        validateWorkerReferences(transaction, attempt, "job.succeeded", {
          result: { ...result, events: [] },
        })
      ),
      undefined,
    );
    assertEquals(
      await referenceErrorCode(() =>
        validateWorkerReferences(transaction, attempt, "job.succeeded", {
          result,
        })
      ),
      undefined,
    );
    assertEquals(
      await referenceErrorCode(() =>
        validateWorkerReferences(transaction, attempt, "job.succeeded", {
          result: { ...result, sessionId: crypto.randomUUID() },
        })
      ),
      "RESOURCE_NOT_FOUND",
    );
    assertFalse(JSON.stringify(result.events).includes(FOREIGN_ID));
    const messageEnd = (result.events as Array<Record<string, unknown>>)
      .find((event) => event.type === "message_end");
    assertEquals(
      ((messageEnd?.message as Record<string, unknown>).content as unknown[])
        .at(-1),
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "notes.txt", nested: {} },
      },
    );
  },
});

Deno.test({
  name: "Pi bounds completed event payloads below the worker result cap",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-large-events-");
    const fake = await fakePi(scratch.dir, "large");
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
    ).execute(await assignment(scratch.dir), new AbortController().signal);

    assertEquals(outcome.status, "completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    workerActionOutputSchema("harness.implement").parse(outcome.result);
    const resultBytes = new TextEncoder().encode(
      JSON.stringify(outcomeResult(outcome)),
    ).byteLength;
    assert(resultBytes < 32_000);
  },
});

Deno.test({
  name: "Pi rejects assistant message accumulation past the state cap",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository(
      "bakery-pi-message-overflow-",
    );
    const fake = await fakePi(scratch.dir, "overflow");
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
    ).execute(await assignment(scratch.dir), new AbortController().signal);

    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcomeResult(outcome).fault as Record<string, unknown>).code,
      "PI_HARNESS_EXIT_NONZERO",
    );
  },
});

Deno.test({
  name: "Pi resumes a retained session and refuses a tampered checkpoint",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const worktree = await prepareScratchRepository(
      "bakery-pi-resume-worktree-",
    );
    const fixture = await prepareScratchRepository(
      "bakery-pi-resume-fixture-",
    );
    const fake = await fakePi(fixture.dir);
    const stateDir = `${fixture.dir}/worker-state`;
    const firstAssignment = await assignment(worktree.dir);
    const executor = executorFor(worktree.dir, fake.executable, stateDir);
    const first = await executor.execute(
      firstAssignment,
      new AbortController().signal,
    );
    assertEquals(first.status, "completed");
    if (first.status !== "completed") throw new Error("unreachable");
    const firstResult = workerActionOutputSchema("harness.implement").parse(
      first.result,
    ) as Record<string, unknown>;
    const checkpoint = firstResult.checkpoint as Record<string, unknown>;
    const resumeInput = {
      ...(firstAssignment.input as Record<string, unknown>),
      resume: {
        sessionId: checkpoint.nativeSessionId,
        worktreeRevision: checkpoint.worktreeRevision,
        checkpointToken: checkpoint.checkpointToken,
        eligible: true,
        resumeEligible: true,
        checkpointEligible: true,
      },
    };
    const resumedAssignment = {
      ...firstAssignment,
      attemptId: crypto.randomUUID(),
      input: resumeInput,
      currentCheckpoints: [checkpoint],
    } as JobAssignment;
    const resumed = await executor.execute(
      resumedAssignment,
      new AbortController().signal,
    );
    assertEquals(resumed.status, "completed");
    if (resumed.status !== "completed") throw new Error("unreachable");
    const resumedResult = workerActionOutputSchema("harness.implement").parse(
      resumed.result,
    ) as Record<string, unknown>;
    assertEquals(resumedResult.sessionId, firstAssignment.agentSessionId);
    assertStringIncludes(
      await Deno.readTextFile(fake.argsPath),
      `--session\n${stateDir}/pi-harness/${resumedAssignment.attemptId}/session/${SESSION_ID}.jsonl\n`,
    );

    const retainedSession = `${stateDir}/pi-harness/sessions/${
      (firstAssignment.input as Record<string, unknown>).repositoryId
    }/${firstAssignment.agentSessionId}/${SESSION_ID}/session.jsonl`;
    await Deno.writeTextFile(
      retainedSession,
      `{"type":"session","id":"${SESSION_ID}"}\ntampered\n`,
    );
    const tamperedAssignment = {
      ...resumedAssignment,
      attemptId: crypto.randomUUID(),
    } as JobAssignment;
    const tampered = await executor.execute(
      tamperedAssignment,
      new AbortController().signal,
    );
    assertEquals(tampered.status, "completed");
    assert(
      !(await Deno.readTextFile(fake.argsPath)).includes(
        `--session\n${stateDir}/pi-harness/${tamperedAssignment.attemptId}/session/`,
      ),
    );
  },
});

Deno.test({
  name:
    "Pi starts fresh when the CLI version changed since the checkpoint (#418)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const worktree = await prepareScratchRepository("bakery-pi-ver-worktree-");
    const fixture = await prepareScratchRepository("bakery-pi-ver-fixture-");
    const fake = await fakePi(fixture.dir);
    const stateDir = `${fixture.dir}/worker-state`;
    const firstAssignment = await assignment(worktree.dir);
    const executor = executorFor(worktree.dir, fake.executable, stateDir);
    const first = await executor.execute(
      firstAssignment,
      new AbortController().signal,
    );
    assertEquals(first.status, "completed");
    if (first.status !== "completed") throw new Error("unreachable");
    const checkpoint = (first.result as Record<string, unknown>)
      .checkpoint as Record<string, unknown>;
    assertEquals(checkpoint.harnessVersion, "pi 0.8.0-fake");
    // The contract field is additive (older checkpoints lack it), so a
    // checkpoint without it still parses; the adapter treats it as a version
    // mismatch and starts fresh (asserted below, for a changed version and for a
    // missing one).
    const { harnessVersion: _omitted, ...withoutVersion } = checkpoint;
    workerActionOutputSchema("harness.implement").parse({
      ...(first.result as Record<string, unknown>),
      checkpoint: withoutVersion,
    });
    const resumeFrom = (attemptId: string) => ({
      ...firstAssignment,
      attemptId,
      input: {
        ...(firstAssignment.input as Record<string, unknown>),
        resume: {
          sessionId: checkpoint.nativeSessionId,
          worktreeRevision: checkpoint.worktreeRevision,
          checkpointToken: checkpoint.checkpointToken,
          eligible: true,
          resumeEligible: true,
          checkpointEligible: true,
        },
      },
      currentCheckpoints: [checkpoint],
    } as JobAssignment);
    // The CLI is upgraded between the checkpoint and the resume.
    await Deno.writeTextFile(
      fake.executable,
      (await Deno.readTextFile(fake.executable)).replace(
        "pi 0.8.0-fake",
        "pi 0.9.0-fake",
      ),
    );
    const upgraded = resumeFrom(crypto.randomUUID());
    const outcome = await executor.execute(
      upgraded,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
    assertFalse(
      (await Deno.readTextFile(fake.argsPath)).includes("--session\n"),
      "a checkpoint from another Pi version must not resume",
    );
    // An older checkpoint sidecar that lacks `harnessVersion` must not resume
    // either, even though the CLI version now matches the one it was written by.
    const sidecars: string[] = [];
    const collect = async (dir: string): Promise<void> => {
      for await (const entry of Deno.readDir(dir)) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory) await collect(path);
        else if (entry.name === ".bakery-checkpoint.json") sidecars.push(path);
      }
    };
    await collect(stateDir);
    assertEquals(sidecars.length, 1);
    const sidecar = JSON.parse(await Deno.readTextFile(sidecars[0]!)) as Record<
      string,
      unknown
    >;
    assertEquals(sidecar.harnessVersion, "pi 0.9.0-fake");
    delete sidecar.harnessVersion;
    await Deno.writeTextFile(sidecars[0]!, JSON.stringify(sidecar));
    const legacyOutcome = await executor.execute(
      resumeFrom(crypto.randomUUID()),
      new AbortController().signal,
    );
    assertEquals(legacyOutcome.status, "completed");
    assertFalse(
      (await Deno.readTextFile(fake.argsPath)).includes("--session\n"),
      "a checkpoint without harnessVersion must not resume",
    );
  },
});

Deno.test("Pi resume requires identity, revision, and checkpoint proof", () => {
  const base = localAssignment() as JobAssignment;
  const agentSessionId = base.agentSessionId ?? crypto.randomUUID();
  const checkpoint = {
    agentSessionId,
    nativeSessionId: SESSION_ID,
    worktreeRevision: "base-sha",
    checkpointToken: "pi-harness/sessions/repo/agent/session.jsonl",
  };
  const input = {
    resume: {
      sessionId: SESSION_ID,
      worktreeRevision: "base-sha",
      checkpointToken: "pi-harness/sessions/repo/agent/session.jsonl",
    },
  };
  assertEquals(
    selectPiResumeSessionFile(
      { agentSessionId, currentCheckpoints: [checkpoint] },
      input,
      "base-sha",
    ),
    "pi-harness/sessions/repo/agent/session.jsonl",
  );
  assertEquals(
    selectPiResumeSessionFile(
      { agentSessionId, currentCheckpoints: [checkpoint] },
      input,
      "changed-sha",
    ),
    undefined,
  );
  assertEquals(
    selectPiResumeSessionFile(
      {
        agentSessionId,
        currentCheckpoints: [{
          ...checkpoint,
          nativeSessionId: crypto.randomUUID(),
        }],
      },
      input,
      "base-sha",
    ),
    undefined,
  );
});

Deno.test({
  name: "Pi maps steer and follow-up controls to advertised streaming behavior",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-controls-");
    const fake = await fakePi(scratch.dir, "control");
    const value = await assignment(scratch.dir);
    const ready = Promise.withResolvers<PiHarnessControl>();
    const executor = executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
      { registerControl: (control) => control && ready.resolve(control) },
    );
    const running = executor.execute(value, new AbortController().signal);
    const busy = await executor.execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(busy.status, "failed");
    if (busy.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcomeResult(busy).fault as Record<string, unknown>).code,
      "PI_HARNESS_BUSY",
    );
    assertEquals(
      (outcomeResult(busy).fault as Record<string, unknown>).retryable,
      true,
    );
    const control = await ready.promise;
    assertEquals(
      await control.send("steer_message", "steer-1", "Use the smaller change."),
      "accepted",
    );
    assertEquals(
      await control.send("follow_up_message", "follow-1", "Then summarize it."),
      "accepted",
    );
    assertEquals((await running).status, "completed");
  },
});

Deno.test({
  name: "Pi reports steering unsupported when the capability is not advertised",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository(
      "bakery-pi-control-unsupported-",
    );
    const fake = await fakePi(scratch.dir, "control");
    const ready = Promise.withResolvers<PiHarnessControl>();
    const controller = new AbortController();
    const running = executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
      {
        capabilities: ["stream"],
        registerControl: (control) => control && ready.resolve(control),
      },
    ).execute(await assignment(scratch.dir), controller.signal);
    const control = await ready.promise;
    assertEquals(
      await control.send("steer_message", "unsupported-1", "No steering."),
      "unsupported",
    );
    controller.abort();
    assertEquals((await running).status, "canceled");
  },
});

Deno.test({
  name:
    "Pi no-id parse responses fail without waiting for a fabricated completion",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-parse-");
    const fake = await fakePi(scratch.dir, "parse");
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
    ).execute(await assignment(scratch.dir), new AbortController().signal);
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcomeResult(outcome).fault as Record<string, unknown>).code,
      "PI_HARNESS_EXIT_NONZERO",
    );
    assertFalse("usage" in outcome);
  },
});

Deno.test("Pi maps invalid input and unsupported actions to non-retryable faults", async () => {
  const scratch = await prepareScratchRepository("bakery-pi-faults-");
  const fake = await fakePi(scratch.dir);
  const executor = executorFor(
    scratch.dir,
    fake.executable,
    `${scratch.dir}/worker-state`,
  );
  const invalid = { ...localAssignment(), input: {} } as JobAssignment;
  const invalidOutcome = await executor.execute(
    invalid,
    new AbortController().signal,
  );
  assertEquals(invalidOutcome.status, "failed");
  if (invalidOutcome.status !== "failed") throw new Error("unreachable");
  assertEquals(
    (outcomeResult(invalidOutcome).fault as Record<string, unknown>).code,
    "PI_HARNESS_INPUT_INVALID",
  );
  assertEquals(
    (outcomeResult(invalidOutcome).fault as Record<string, unknown>).retryable,
    false,
  );

  const unsupported = {
    ...localAssignment(),
    action: "quality.check",
  } as JobAssignment;
  const unsupportedOutcome = await executor.execute(
    unsupported,
    new AbortController().signal,
  );
  assertEquals(unsupportedOutcome.status, "failed");
  if (unsupportedOutcome.status !== "failed") throw new Error("unreachable");
  assertEquals(
    (outcomeResult(unsupportedOutcome).fault as Record<string, unknown>).code,
    "PI_HARNESS_ACTION_UNSUPPORTED",
  );
});

Deno.test({
  name: "Pi refuses a dirty worktree before starting the child",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-pi-dirty-");
    await Deno.writeTextFile(`${scratch.dir}/notes.txt`, "edited leftover\n");
    const fake = await fakePi(scratch.dir);
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      `${scratch.dir}/worker-state`,
    ).execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    const fault = outcome.fault as Record<string, unknown>;
    assertEquals(fault.code, "PI_HARNESS_WORKTREE_DIRTY");
    assertEquals(fault.status, 409);
    assertEquals(fault.retryable, false);
    let started = true;
    try {
      await Deno.stat(fake.argsPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      started = false;
    }
    assertFalse(started);
  },
});
