import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "node:path";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import { createClaudeHarnessExecutor } from "../../apps/worker/src/claude-harness.ts";
import { selectClaudeResumeSession } from "../../apps/worker/src/claude-harness.ts";
import { createCodexHarnessExecutor } from "../../apps/worker/src/codex-harness.ts";
import { createPiHarnessExecutor } from "../../apps/worker/src/pi-harness.ts";
import { selectPiResumeSessionFile } from "../../apps/worker/src/pi-harness.ts";
import type { WorkerApiClient } from "../../apps/worker/src/client.ts";
import type {
  ExecutionOutcome,
  WorkerExecutor,
} from "../../apps/worker/src/executor.ts";
import {
  NATIVE_OUTPUT_LIMITS,
  NativeOutputCapture,
} from "../../apps/worker/src/native-output.ts";
import {
  EventSpool,
  terminalReservationBytes,
} from "../../apps/worker/src/spool.ts";
import type {
  JobAssignment,
  WorkerOutputBinding,
} from "../../apps/worker/src/types.ts";
import {
  contractSchemas,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import { localAssignment } from "./worker-execution/recovery-support.ts";
import { gitText, prepareScratchRepository } from "./harness.ts";

/** Deno test options for cases that spawn real child processes. */
export const CONFORMANCE_TEST_OPTIONS = {
  sanitizeResources: false,
  sanitizeOps: false,
} as const;

/** Stable native session id every fake reports. */
export const FAKE_NATIVE_SESSION_ID = "00000000-0000-4000-8000-000000000002";

/** Behaviors a fake harness binary can exhibit. */
export type FakeBehavior =
  | "complete"
  | "malformed-stream"
  | "truncated-result"
  | "no-terminal"
  | "exit-nonzero"
  | "hang"
  /**
   * Like `hang`, but a Pi fake honors the RPC `abort` (answers, then exits)
   * while the detached heartbeat grandchild keeps running; Codex and Claude
   * are signal-driven so it behaves as `hang` there.
   */
  | "hang-cooperative"
  /**
   * Like `hang`, but the leader's sleep holds no pipe, so a leader-only kill
   * (group kill unavailable) still lets the output pumps finish promptly.
   */
  | "hang-silent"
  /** Claude reports `total_cost_usd`; Pi reports provider usage; Codex like `complete`. */
  | "complete-usage"
  /** Dumps env, probes HOME, lists the state dir, plants auth, then completes. */
  | "isolation-probe";

/** Counts publishes and keeps the last published bytes for digest checks. */
export type PublishRecord = { count: number; bytes?: Uint8Array };

export type ConformanceAdapterName = "codex" | "claude" | "pi";

export type ExecutorOptions = {
  readonly repository: string;
  readonly markers: string;
  readonly executable: string;
  readonly timeLimitMs: number;
  readonly publishCount: PublishRecord;
  /** Test seam: group-kill helper path (absent file forces an unconfirmed teardown). */
  readonly groupKillExecutable?: string;
  /** Worker-advertised control capabilities (Pi only). */
  readonly capabilities?: readonly string[];
};

/** Everything the corpus needs to know about one harness adapter. */
export type ConformanceAdapter = {
  readonly name: ConformanceAdapterName;
  readonly faultPrefix: "CODEX" | "CLAUDE" | "PI";
  readonly versionField: "codexVersion" | "claudeCodeVersion" | "piVersion";
  readonly versionValue: string;
  readonly stateEnv: "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "PI_CODING_AGENT_DIR";
  readonly authFile: ".credentials.json" | "auth.json";
  readonly resumeFlag: undefined | "--resume" | "--session";
  /** Fake behaviors that must fail closed as an exit-nonzero fault. */
  readonly faultBehaviors: readonly FakeBehavior[];
  readonly selectResume: (
    assignment: Pick<JobAssignment, "agentSessionId" | "currentCheckpoints">,
    input: unknown,
    baseSha: string,
  ) => string | undefined;
  readonly executor: (options: ExecutorOptions) => WorkerExecutor;
  /** Writes a POSIX sh fake into `markers` and returns its path. */
  readonly writeFake: (
    markers: string,
    behavior: FakeBehavior,
    sentinel: string,
  ) => Promise<string>;
};

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

/** One admitted `harness.implement` assignment shared by every adapter. */
export async function conformanceAssignment(
  scratchDir: string,
): Promise<JobAssignment> {
  return {
    ...localAssignment(),
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId: crypto.randomUUID(),
      planArtifact: crypto.randomUUID(),
      repositoryProfile: await repositoryProfile(),
      instructions: "Do not change any file.",
      scratchDir,
    },
  } as JobAssignment;
}

export function publishFor(count: PublishRecord) {
  return () => async (request: { readonly bytes: Uint8Array }) => {
    count.count++;
    count.bytes = request.bytes;
    return {
      artifactId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      sha256: await sha256Hex(request.bytes),
    };
  };
}

/** Last-resort cleanup: kill the process group the hang fake recorded. */
export async function killLeftoverHeartbeat(markers: string): Promise<void> {
  try {
    const pgid = (await Deno.readTextFile(join(markers, "beat.pgid"))).trim();
    await new Deno.Command("/usr/bin/kill", {
      args: ["-s", "KILL", "--", `-${pgid}`],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  } catch {
    // Already gone or never started.
  }
}

/**
 * Shell preamble shared by all fakes. `$M` is the markers dir (outside the
 * scratch repository so `git add -A` commits only notes.txt); `hang` starts a
 * DETACHED bounded heartbeat grandchild that holds no pipe, so only a real
 * process-group kill stops it.
 */
function shellPrelude(markers: string, sentinel: string): string {
  return `M='${markers}'
S='${sentinel}'
hang() {
  echo $$ > "$M/beat.pgid"
  ( i=0; while [ $i -lt 300 ]; do date +%s%N >> "$M/beat"; i=$((i+1)); sleep 0.1; done ) >/dev/null 2>&1 &
  sleep 30
}
hang_silent() {
  echo $$ > "$M/beat.pgid"
  ( i=0; while [ $i -lt 300 ]; do date +%s%N >> "$M/beat"; i=$((i+1)); sleep 0.1; done ) >/dev/null 2>&1 &
  sleep 30 >/dev/null 2>&1
}
hang_detached() {
  echo $$ > "$M/beat.pgid"
  ( i=0; while [ $i -lt 300 ]; do date +%s%N >> "$M/beat"; i=$((i+1)); sleep 0.1; done ) >/dev/null 2>&1 &
}`;
}

/**
 * Opens every fake: records that the binary was launched at all, then answers
 * `--version` with `$M/version` when a test wrote one, else the constant.
 */
function versionPrelude(markers: string, constant: string): string {
  return `M='${markers}'
: > "$M/launched"
if [ "$1" = "--version" ]; then
  if [ -f "$M/version" ]; then cat "$M/version"; else printf '%s\\n' '${constant}'; fi
  exit 0
fi`;
}

/** Synthetic auth file bytes; carry the sentinel so any retained copy is detectable. */
export function fakeAuthBytes(sentinel: string): string {
  return `{"synthetic-auth":"${sentinel}-auth"}`;
}

/**
 * Probe run by the isolation fakes before they complete: env dump, HOME
 * exposure (readable? only, never the bytes) and the adapter state dir as the
 * child sees it (mode and file list).
 */
function probeScript(stateVar: string): string {
  const state = `D="\$${stateVar}"
stat -c '%a' "$D" > "$M/state-mode"
( cd "$D" && find . -mindepth 1 | sort ) > "$M/state-listing"`;
  return `env > "$M/env"
echo "home:$HOME" > "$M/home"
for p in .codex/auth.json .claude/.credentials.json .pi/agent/auth.json; do
  if [ -n "\${HOME:-}" ] && [ -r "$HOME/$p" ]; then echo "readable:$p" >> "$M/home-readable"; fi
done
${state}`;
}

async function writeExecutable(path: string, body: string): Promise<string> {
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(path, 0o755);
  return path;
}

async function writeCodexFake(
  markers: string,
  behavior: FakeBehavior,
  sentinel: string,
): Promise<string> {
  const authSource = join(markers, "auth-source");
  await Deno.mkdir(authSource, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    join(authSource, "auth.json"),
    fakeAuthBytes(sentinel),
  );
  const complete = `echo 'change from fake codex' >> notes.txt`;
  const probe = behavior === "isolation-probe" ? probeScript("CODEX_HOME") : "";
  const action: Record<FakeBehavior, string> = {
    "complete": complete,
    "complete-usage": complete,
    "isolation-probe": complete,
    // Opaque stdout is cut mid-record by a hard kill: exit status is the only
    // completion proof Codex has.
    "truncated-result":
      `printf 'partial output without newline'; kill -KILL $$`,
    "exit-nonzero": `exit 1`,
    "hang": `hang`,
    "hang-cooperative": `hang`,
    "hang-silent": `hang_silent`,
    "malformed-stream": `exit 1`,
    "no-terminal": `exit 1`,
  };
  return await writeExecutable(
    join(markers, "fake-codex"),
    `${versionPrelude(markers, "codex-cli 0.0.0-fake")}
${shellPrelude(markers, sentinel)}
echo started > "$M/started"
printf '%s\\n' "$@" > "$M/argv"
printf 'out %s\\n' "$S"
printf 'err %s\\n' "$S" >&2
${probe}
${action[behavior]}`,
  );
}

async function writeClaudeFake(
  markers: string,
  behavior: FakeBehavior,
  sentinel: string,
): Promise<string> {
  const authSource = join(markers, "auth-source");
  await Deno.mkdir(authSource, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    join(authSource, ".credentials.json"),
    fakeAuthBytes(sentinel),
  );
  const sid = FAKE_NATIVE_SESSION_ID;
  const init =
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${sid}","claude_code_version":"2.1.0"}'`;
  const result =
    `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${sid}"}'`;
  const costResult =
    `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${sid}","total_cost_usd":0.0123}'`;
  const complete = `echo 'change from fake claude' >> notes.txt
${result}`;
  // Honest session records plus the child planting its auth file where the
  // retention allowlist (projects, todos) would copy it.
  const plant = `mkdir -p "$D/projects/p" "$D/projects/leak" "$D/todos"
printf '%s\\n' '{"type":"user","session_id":"${sid}"}' > "$D/projects/p/${sid}.jsonl"
printf '[]' > "$D/todos/${sid}.json"
cp "$D/.credentials.json" "$D/projects/leak/.credentials.json"
cp "$D/.credentials.json" "$D/todos/.credentials.json"`;
  const probe = behavior === "isolation-probe"
    ? `${probeScript("CLAUDE_CONFIG_DIR")}\n${plant}`
    : "";
  const action: Record<FakeBehavior, string> = {
    "complete": complete,
    "isolation-probe": complete,
    "complete-usage": `echo 'change from fake claude' >> notes.txt
${costResult}`,
    "malformed-stream": `printf '%s\\n' "not json $S"`,
    "truncated-result": `printf '%s' '{"type":"result","subtype":"success"'`,
    "no-terminal": `:`,
    "exit-nonzero": `exit 1`,
    "hang": `hang`,
    "hang-cooperative": `hang`,
    "hang-silent": `hang_silent`,
  };
  return await writeExecutable(
    join(markers, "fake-claude"),
    `${versionPrelude(markers, "2.1.0 (Claude Code)")}
${shellPrelude(markers, sentinel)}
cat > /dev/null
echo started > "$M/started"
printf '%s\\n' "$@" > "$M/argv"
printf 'err %s\\n' "$S" >&2
${probe}
${init}
${action[behavior]}`,
  );
}

async function writePiFake(
  markers: string,
  behavior: FakeBehavior,
  sentinel: string,
): Promise<string> {
  const authSource = join(markers, "auth-source");
  await Deno.mkdir(authSource, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    join(authSource, "auth.json"),
    fakeAuthBytes(sentinel),
  );
  const sid = FAKE_NATIVE_SESSION_ID;
  const reply = (command: string) =>
    `printf '%s\\n' '{"id":"'"$id"'","type":"response","command":"${command}","success":true,"data":`;
  const start = `${reply("prompt")}{"disposition":"started"}}'`;
  const event = (json: string) => `printf '%s\\n' '${json}'`;
  const settle = [
    event('{"type":"agent_start"}'),
    event('{"type":"turn_start"}'),
    event(
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
    ),
    event(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}',
    ),
    event(
      '{"type":"turn_end","message":{"role":"assistant","stopReason":"stop"},"toolResults":[]}',
    ),
    event('{"type":"agent_end","messages":[],"willRetry":false}'),
    event('{"type":"agent_settled","aborted":false}'),
  ].join("\n");
  const complete = `echo 'change from fake pi' >> notes.txt
${start}
${settle}`;
  const usageSettle = settle.replace(
    event(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}',
    ),
    `${
      event(
        '{"type":"message_update","usage":{"input":10,"output":5}}',
      )
    }\n${
      event(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}',
      )
    }`,
  );
  const probe = behavior === "isolation-probe"
    ? `${probeScript("PI_CODING_AGENT_DIR")}
mkdir -p "$session_dir/leak"
cp "$PI_CODING_AGENT_DIR/auth.json" "$session_dir/auth.json"
cp "$PI_CODING_AGENT_DIR/auth.json" "$session_dir/leak/auth.json"`
    : "";
  const action: Record<FakeBehavior, string> = {
    "complete": complete,
    "isolation-probe": complete,
    "complete-usage": `echo 'change from fake pi' >> notes.txt
${start}
${usageSettle}`,
    "malformed-stream": `${start}
printf '%s\\n' "not json $S"
exit 0`,
    "truncated-result": `${start}
printf '%s' '{"type":"agent_settled","abor'
exit 0`,
    "no-terminal": `${start}
${event('{"type":"agent_start"}')}
exit 0`,
    "exit-nonzero": `${start}
exit 1`,
    "hang": `${start}
${event('{"type":"agent_start"}')}
hang`,
    "hang-cooperative": `${start}
${event('{"type":"agent_start"}')}
hang_detached`,
    "hang-silent": `${start}
${event('{"type":"agent_start"}')}
hang_silent`,
  };
  const cooperative = behavior === "hang-cooperative"
    ? `    *'"type":"clear_queue"'*)
      ${reply("clear_queue")}{}}'
      ;;
    *'"type":"abort"'*)
      ${reply("abort")}{}}'
      exit 0
      ;;
`
    : "";
  return await writeExecutable(
    join(markers, "fake-pi"),
    `${versionPrelude(markers, "pi 0.8.0-fake")}
${shellPrelude(markers, sentinel)}
echo started > "$M/started"
printf '%s\\n' "$@" > "$M/argv"
printf 'err %s\\n' "$S" >&2
session_dir=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--session-dir" ]; then session_dir="$2"; shift 2; else shift; fi
done
mkdir -p "$session_dir"
printf '%s\\n' '{"type":"session","id":"${sid}"}' > "$session_dir/session.jsonl"
${probe}
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
  case "$line" in
    *'"type":"get_state"'*)
      ${
      reply("get_state")
    }{"sessionId":"${sid}","sessionFile":"session.jsonl","model":{"provider":"fake-provider","id":"fake-model"}}}'
      ;;
    *'"type":"prompt"'*)
      ${action[behavior].replaceAll("\n", "\n      ")}
      ;;
${cooperative}  esac
done`,
  );
}

export const CONFORMANCE_ADAPTERS: readonly ConformanceAdapter[] = [
  {
    name: "codex",
    faultPrefix: "CODEX",
    versionField: "codexVersion",
    versionValue: "codex-cli 0.0.0-fake",
    stateEnv: "CODEX_HOME",
    authFile: "auth.json",
    resumeFlag: undefined,
    faultBehaviors: ["truncated-result", "exit-nonzero"],
    selectResume: () => undefined,
    executor: (options) =>
      createCodexHarnessExecutor({
        publishFor: publishFor(options.publishCount),
        repositoryFor: () => options.repository,
        codexExecutable: options.executable,
        groupKillExecutable: options.groupKillExecutable,
        stateDir: join(options.markers, "state"),
        authSourceDir: join(options.markers, "auth-source"),
        timeLimitMs: options.timeLimitMs,
      }),
    writeFake: writeCodexFake,
  },
  {
    name: "claude",
    faultPrefix: "CLAUDE",
    versionField: "claudeCodeVersion",
    versionValue: "2.1.0",
    stateEnv: "CLAUDE_CONFIG_DIR",
    authFile: ".credentials.json",
    resumeFlag: "--resume",
    faultBehaviors: [
      "malformed-stream",
      "truncated-result",
      "no-terminal",
      "exit-nonzero",
    ],
    selectResume: selectClaudeResumeSession,
    executor: (options) =>
      createClaudeHarnessExecutor({
        publishFor: publishFor(options.publishCount),
        repositoryFor: () => options.repository,
        claudeExecutable: options.executable,
        groupKillExecutable: options.groupKillExecutable,
        stateDir: join(options.markers, "state"),
        authSourceDir: join(options.markers, "auth-source"),
        timeLimitMs: options.timeLimitMs,
      }),
    writeFake: writeClaudeFake,
  },
  {
    name: "pi",
    faultPrefix: "PI",
    versionField: "piVersion",
    versionValue: "pi 0.8.0-fake",
    stateEnv: "PI_CODING_AGENT_DIR",
    authFile: "auth.json",
    resumeFlag: "--session",
    faultBehaviors: ["malformed-stream", "no-terminal", "exit-nonzero"],
    selectResume: selectPiResumeSessionFile,
    executor: (options) =>
      createPiHarnessExecutor({
        publishFor: publishFor(options.publishCount),
        repositoryFor: () => options.repository,
        piExecutable: options.executable,
        groupKillExecutable: options.groupKillExecutable,
        stateDir: join(options.markers, "state"),
        piAgentSourceDir: join(options.markers, "auth-source"),
        timeLimitMs: options.timeLimitMs,
        capabilities: options.capabilities ??
          ["stream", "resume", "steer", "follow_up"],
      }),
    writeFake: writePiFake,
  },
];

/** A real spool plus `NativeOutputCapture` with the sentinel as a configured secret. */
export type NativeCaptureFixture = {
  readonly directory: string;
  readonly spool: EventSpool;
  readonly capture: NativeOutputCapture;
  readonly attemptId: string;
};

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
    logicalActor: "harness.implement:conformance",
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

export async function nativeCaptureFixture(
  assignment: JobAssignment,
  configuredSecrets: readonly string[],
  credentialSecrets: readonly string[] = [],
): Promise<NativeCaptureFixture> {
  const directory = await Deno.makeTempDir({
    prefix: "bakery-conformance-capture-",
  });
  const spool = await EventSpool.open({
    path: `${directory}/spool.json`,
    maxRecords: 1_000,
    maxBytes: 1024 * 1024,
  });
  await spool.restoreJournalState(assignment.attemptId, "3", "2");
  await spool.reserveTerminal(
    assignment.attemptId,
    terminalReservationBytes({
      attemptId: assignment.attemptId,
      leaseToken: assignment.leaseToken,
      fence: assignment.fence,
    }),
  );
  const binding = outputBinding(assignment.attemptId);
  const capture = new NativeOutputCapture({
    assignment,
    binding,
    client: null as unknown as WorkerApiClient,
    spool,
    workerSessionId: binding.workerSessionId,
    workerSessionGeneration: binding.workerSessionGeneration,
    configuredSecrets,
    credentialSecrets,
    leaseActive: () => true,
    waitForAck: () => Promise.resolve(),
  });
  return { directory, spool, capture, attemptId: assignment.attemptId };
}

export type ConformanceRun = {
  readonly adapter: ConformanceAdapter;
  readonly repository: string;
  readonly markers: string;
  readonly baseSha: string;
  readonly sentinel: string;
  readonly assignment: JobAssignment;
  readonly publishCount: PublishRecord;
  readonly fixture: NativeCaptureFixture;
  readonly beat: string;
  readonly executor: WorkerExecutor;
  /** What `onStarted` returned while the harness was running, if it ran. */
  readonly startedResult: unknown;
  /** Wall-clock ms at which `execute` returned. */
  returnedAt: number;
  outcome: ExecutionOutcome;
  readonly elapsedMs: number;
};

export type RunOptions = {
  readonly timeLimitMs?: number;
  /** Group-kill helper path handed to the adapter (test seam). */
  readonly groupKillExecutable?: string;
  /** Aborts the signal before `execute` starts. */
  readonly preAbort?: boolean;
  /** Aborts once the fake wrote its `started` marker and heartbeat. */
  readonly abortAfterStart?: boolean;
  /** Overrides `assignment.action` (unsupported-action scenario). */
  readonly action?: string;
  /** Control capabilities handed to the executor (Pi only). */
  readonly capabilities?: readonly string[];
  /** Rewrites the assignment once the base SHA is known (checkpoints, resume input). */
  readonly assignmentFor?: (
    assignment: JobAssignment,
    baseSha: string,
  ) => JobAssignment;
  /** Runs after the fake is written and before the executor starts. */
  readonly prepare?: (context: { readonly markers: string }) => Promise<void>;
  /** Runs while the harness is live (needs `abortAfterStart`), before the abort. */
  readonly onStarted?: (
    context: {
      readonly executor: WorkerExecutor;
      readonly assignment: JobAssignment;
    },
  ) => Promise<unknown>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  waitMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("CONFORMANCE_WAIT_TIMEOUT");
}

/**
 * Runs one fake behavior through one adapter and always cleans up: the scratch
 * repository, the markers dir, the capture spool, and any leftover heartbeat.
 */
export async function withConformanceRun(
  adapter: ConformanceAdapter,
  behavior: FakeBehavior,
  options: RunOptions,
  body: (run: ConformanceRun) => Promise<void>,
): Promise<void> {
  const scratch = await prepareScratchRepository(
    `bakery-conformance-${adapter.name}-`,
  );
  const markers = await Deno.makeTempDir({
    prefix: `bakery-conformance-markers-${adapter.name}-`,
  });
  const sentinel = `FAKE_SENTINEL_${crypto.randomUUID()}`;
  let assignment = await conformanceAssignment(scratch.dir);
  if (options.assignmentFor) {
    assignment = options.assignmentFor(assignment, scratch.baseSha);
  }
  if (options.action !== undefined) {
    assignment = { ...assignment, action: options.action } as JobAssignment;
  }
  const fixture = await nativeCaptureFixture(assignment, [sentinel]);
  const publishCount: PublishRecord = { count: 0 };
  try {
    const executable = await adapter.writeFake(markers, behavior, sentinel);
    await options.prepare?.({ markers });
    const executor = adapter.executor({
      repository: scratch.dir,
      markers,
      executable,
      timeLimitMs: options.timeLimitMs ?? 10_000,
      publishCount,
      capabilities: options.capabilities,
      groupKillExecutable: options.groupKillExecutable,
    });
    let startedResult: unknown;
    const controller = new AbortController();
    if (options.preAbort) controller.abort();
    const startedAt = Date.now();
    const running = executor.execute(
      assignment,
      controller.signal,
      fixture.capture,
    );
    if (options.abortAfterStart) {
      await waitFor(
        async () =>
          await exists(join(markers, "started")) &&
          // The shell creates `beat` before `date` writes to it: wait for a
          // real heartbeat line, not just the file.
          (await Deno.readTextFile(join(markers, "beat")).catch(() => ""))
            .includes("\n"),
        8_000,
      );
      startedResult = await options.onStarted?.({ executor, assignment });
      controller.abort();
    }
    const outcome = await running;
    const returnedAt = Date.now();
    await body({
      adapter,
      repository: scratch.dir,
      markers,
      baseSha: scratch.baseSha,
      sentinel,
      assignment,
      publishCount,
      fixture,
      beat: join(markers, "beat"),
      executor,
      startedResult,
      returnedAt,
      outcome,
      elapsedMs: returnedAt - startedAt,
    });
  } finally {
    await killLeftoverHeartbeat(markers);
    await Deno.remove(fixture.directory, { recursive: true }).catch(() =>
      undefined
    );
    await Deno.remove(markers, { recursive: true }).catch(() => undefined);
    await Deno.remove(scratch.dir, { recursive: true }).catch(() => undefined);
  }
}

/** Raw, untrimmed `git diff --binary base..head`, the exact bytes a worker publishes. */
async function patchBytes(
  repository: string,
  baseSha: string,
  headSha: string,
): Promise<Uint8Array> {
  const output = await new Deno.Command("git", {
    args: ["diff", "--binary", `${baseSha}..${headSha}`],
    cwd: repository,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(output.code, 0);
  return output.stdout;
}

type Fault = {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
};

function faultOf(outcome: ExecutionOutcome): Fault {
  assertEquals(outcome.status, "failed");
  if (outcome.status !== "failed") throw new Error("unreachable");
  const parsed = contractSchemas.Problem.parse(outcome.fault) as Record<
    string,
    unknown
  >;
  return parsed as unknown as Fault;
}

/** Scenario 1: schema-valid completion, actual version, truthful HEAD and patch. */
export async function assertCompletedConformance(
  run: ConformanceRun,
): Promise<void> {
  const { outcome, adapter } = run;
  assertEquals(outcome.status, "completed");
  if (outcome.status !== "completed") throw new Error("unreachable");
  assertFalse("usage" in outcome, "no usage receipt may be invented");
  const result = workerActionOutputSchema("harness.implement").parse(
    outcome.result,
  ) as Record<string, unknown>;
  assertEquals(result.sessionId, run.assignment.agentSessionId);
  assertEquals(result.baseSha, run.baseSha);
  const head = await gitText(run.repository, ["rev-parse", "HEAD"]);
  assertEquals(result.headSha, head);
  assert(head !== run.baseSha, "the fake edit must be committed");
  assertEquals(result[adapter.versionField], adapter.versionValue);
  const artifacts = result.artifacts as ReadonlyArray<
    Record<string, unknown>
  >;
  assertEquals(artifacts.length, 1);
  assertEquals(run.publishCount.count, 1);
  const expected = await patchBytes(run.repository, run.baseSha, head);
  assert(expected.byteLength > 0);
  const published = run.publishCount.bytes;
  assert(published !== undefined, "the patch was never published");
  assertEquals(published, expected);
  assertEquals(artifacts[0].sha256, await sha256Hex(published));
}

/** Scenarios 2 and 3: a schema-valid fault, nothing published, HEAD untouched. */
export async function assertFaultConformance(
  run: ConformanceRun,
  expected: { code: string; status: number; retryable: boolean },
): Promise<void> {
  const fault = faultOf(run.outcome);
  assertEquals(
    {
      code: fault.code,
      status: fault.status,
      retryable: fault.retryable,
    },
    {
      code: `${run.adapter.faultPrefix}_${expected.code}`,
      status: expected.status,
      retryable: expected.retryable,
    },
  );
  assertFalse("usage" in run.outcome);
  assertEquals(run.publishCount.count, 0);
  assertEquals(
    await gitText(run.repository, ["rev-parse", "HEAD"]),
    run.baseSha,
  );
  assertFalse(JSON.stringify(run.outcome).includes(run.sentinel));
}

/**
 * Scenario 2 diagnostic: the native output stream is bounded, redacted, and
 * never carries the sentinel the fake printed on stdout and stderr.
 */
export async function assertBoundedRedactedCapture(
  run: ConformanceRun,
): Promise<void> {
  const finished = await run.fixture.capture.finish();
  assert(
    finished !== null &&
      (finished.capture === "complete" || finished.capture === "truncated"),
    `unexpected capture disposition ${JSON.stringify(finished)}`,
  );
  const output = run.fixture.spool.records().filter((record) =>
    record.type === "job.output"
  );
  assert(output.length >= 1, "no job.output record was captured");
  assert(output.length <= NATIVE_OUTPUT_LIMITS.outstandingRecords);
  const depth = run.fixture.spool.outputDepth(run.fixture.attemptId);
  assert(depth.bytes <= NATIVE_OUTPUT_LIMITS.outstandingBytes);
  assert(depth.records <= NATIVE_OUTPUT_LIMITS.outstandingRecords);
  for (const record of output) {
    const parts = (record.payload as { parts: Array<{ text: string }> }).parts;
    let bytes = 0;
    for (const part of parts) {
      bytes += new TextEncoder().encode(part.text).length;
    }
    assert(
      bytes <= NATIVE_OUTPUT_LIMITS.appendBytes,
      `record carries ${bytes} bytes`,
    );
  }
  const persisted = JSON.stringify(output);
  assert(persisted.includes("[REDACTED]"), "sentinel was not redacted");
  assertFalse(persisted.includes(run.sentinel), "sentinel leaked into output");
}

/** Scenario 4: exact proven-cancellation evidence and an untouched repository. */
export async function assertCanceledConformance(
  run: ConformanceRun,
): Promise<void> {
  const { outcome } = run;
  assertEquals(outcome.status, "canceled");
  if (outcome.status !== "canceled") throw new Error("unreachable");
  assertFalse("usage" in outcome);
  const cancellation = outcome.cancellation as Record<string, unknown>;
  assertEquals(Object.keys(cancellation).sort(), [
    "cleanupStatus",
    "exitedAt",
    "processExited",
    "terminationStatus",
  ]);
  assertEquals(cancellation.processExited, true);
  assertEquals(cancellation.cleanupStatus, "complete");
  assertEquals(cancellation.terminationStatus, "confirmed");
  assertEquals(
    new Date(cancellation.exitedAt as string).toISOString(),
    cancellation.exitedAt,
  );
  assertEquals(run.publishCount.count, 0);
  assertEquals(
    await gitText(run.repository, ["rev-parse", "HEAD"]),
    run.baseSha,
  );
}

/**
 * Missing group-kill helper: the group could not be proven stopped, so a
 * cancel reports unknown termination (never replay-safe) and a timeout is a
 * non-retryable teardown fault.
 */
export function assertUnconfirmedCancel(run: ConformanceRun): void {
  const { outcome } = run;
  assertEquals(outcome.status, "canceled");
  if (outcome.status !== "canceled") throw new Error("unreachable");
  const cancellation = outcome.cancellation as Record<string, unknown>;
  assertEquals(cancellation.terminationStatus, "unknown");
  assertEquals(cancellation.processExited, false);
  assertEquals(cancellation.cleanupStatus, "pending");
  assertEquals(run.publishCount.count, 0);
}

/** The detached heartbeat grandchild is already dead when `execute` returns. */
export async function assertHeartbeatStoppedAtReturn(
  run: ConformanceRun,
): Promise<void> {
  const lines = async () => {
    try {
      return (await Deno.readTextFile(run.beat)).split("\n").filter(Boolean)
        .length;
    } catch {
      return 0;
    }
  };
  const first = await lines();
  assert(first > 0, "the detached heartbeat never started");
  await sleep(600);
  assertEquals(await lines(), first, "grandchild still beating after return");
}

/**
 * Adapter-neutral comparison shape. Keeps status, the fault code suffix after
 * the adapter prefix, HTTP status and retryability, and the common result
 * keys; replaces ids, timestamps, digests and versions with type tags.
 */
export function normalizedShape(
  adapter: ConformanceAdapter,
  outcome: ExecutionOutcome,
): unknown {
  if (outcome.status === "completed") {
    const result = outcome.result as Record<string, unknown>;
    const artifacts = result.artifacts as ReadonlyArray<
      Record<string, unknown>
    >;
    return {
      status: "completed",
      baseSha: typeof result.baseSha,
      headSha: typeof result.headSha,
      sessionId: typeof result.sessionId,
      version: typeof result[adapter.versionField],
      artifacts: artifacts.map((artifact) => ({
        keys: Object.keys(artifact).sort(),
      })),
      usage: "usage" in outcome,
    };
  }
  if (outcome.status === "failed") {
    const fault = outcome.fault as Record<string, unknown>;
    return {
      status: "failed",
      code: (fault.code as string).slice(adapter.faultPrefix.length + 1),
      httpStatus: fault.status,
      retryable: fault.retryable,
      usage: "usage" in outcome,
    };
  }
  const cancellation = outcome.cancellation as Record<string, unknown>;
  return {
    status: "canceled",
    processExited: cancellation.processExited,
    exitedAt: typeof cancellation.exitedAt,
    cleanupStatus: cancellation.cleanupStatus,
    terminationStatus: cancellation.terminationStatus,
    usage: "usage" in outcome,
  };
}
