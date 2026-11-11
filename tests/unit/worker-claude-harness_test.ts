import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  FAKE_CLAUDE_VERSION_PRELUDE,
  SYNTHETIC_CLAUDE_CREDENTIALS,
} from "../helpers/harness-auth.ts";
import {
  createClaudeHarnessExecutor,
  selectClaudeResumeSession,
} from "../../apps/worker/src/claude-harness.ts";
import { outcomeResult } from "../../apps/worker/src/supervisor-support.ts";
import {
  contractSchemas,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import { gitText, prepareScratchRepository } from "../helpers/harness.ts";

const RUN_PERMISSIONS = {
  sanitizeResources: false,
  sanitizeOps: false,
} as const;
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

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
  instructions = "Do not change any file.",
): Promise<JobAssignment> {
  const base = localAssignment();
  return {
    ...base,
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId: crypto.randomUUID(),
      planArtifact: crypto.randomUUID(),
      repositoryProfile: await repositoryProfile(),
      instructions,
      scratchDir,
    },
  } as JobAssignment;
}

async function fakeClaude(
  dir: string,
  body: string,
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
    `#!/bin/sh\n${FAKE_CLAUDE_VERSION_PRELUDE}\n${body}\n`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

function executorFor(
  dir: string,
  executable: string,
  timeLimitMs = 5_000,
  options: {
    readonly publicationCount?: { count: number };
    readonly authSourceDir?: string;
    readonly model?: string;
    readonly effort?: string;
  } = {},
) {
  return createClaudeHarnessExecutor({
    publishFor: () => async (request) => {
      if (options.publicationCount) options.publicationCount.count++;
      return {
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: await sha256Hex(request.bytes),
      };
    },
    repositoryFor: () => dir,
    claudeExecutable: executable,
    stateDir: `${dir}/worker-state`,
    authSourceDir: options.authSourceDir ?? `${dir}/auth-source`,
    timeLimitMs,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
  });
}

Deno.test({
  name:
    "Claude stream metadata, stdin prompt, api_retry, telemetry and argv stay normalized",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-unit-");
    const argsPath = `${scratch.dir}/args.txt`;
    const promptPath = `${scratch.dir}/prompt.txt`;
    const fake = await fakeClaude(
      scratch.dir,
      `cat > '${promptPath}'
printf '%s\\n' "$@" > '${argsPath}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0","model":"claude-sonnet","capabilities":["git","shell"]}'
printf '%s\\n' '{"type":"system","subtype":"api_retry","attempt":2,"retry_delay_ms":250}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}","total_cost_usd":0.25}'`,
    );
    const value = await assignment(scratch.dir);
    const outcome = await executorFor(
      scratch.dir,
      fake,
    ).execute(value, new AbortController().signal);
    assertEquals(outcome.status, "completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    const result = workerActionOutputSchema("harness.implement").parse(
      outcome.result,
    ) as Record<string, unknown>;
    assertEquals(result.sessionId, value.agentSessionId);
    assert(!JSON.stringify(result).includes(SESSION_ID));
    assertEquals(result.claudeCodeVersion, "2.1.0");
    assertEquals(result.model, "claude-sonnet");
    assertEquals(result.capabilities, ["git", "shell"]);
    assertEquals(result.events, [{
      type: "api_retry",
      attempt: 2,
      delayMs: 250,
    }]);
    assertEquals(result.telemetry, { total_cost_usd: 0.25 });
    assertFalse("usage" in outcome);
    const args = await Deno.readTextFile(argsPath);
    const prompt = await Deno.readTextFile(promptPath);
    assert(args.includes("-p\n"));
    assert(prompt.includes("Do not change any file."));
    assertFalse(args.includes("Implement the task pinned by plan artifact"));
    assert(args.includes("--output-format\nstream-json\n"));
    assert(args.includes("--verbose\n"));
    assert(args.includes("--restricted\n"));
    assert(args.includes("--tools\nRead,Edit,Write,Glob,Grep\n"));
    assert(args.includes("--permission-mode\nacceptEdits\n"));
    assert(args.includes("--permission-prompts\nnone\n"));
    assert(args.includes("--allowedTools\nRead,Edit,Write,Glob,Grep\n"));
    assertFalse(args.includes("Bash"));
  },
});

Deno.test({
  name: "malformed Claude stream cannot fabricate completion",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-malformed-");
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}"}'
printf '%s' '{"type":"result","subtype":"success"'`,
    );
    const outcome = await executorFor(
      scratch.dir,
      fake,
    ).execute(await assignment(scratch.dir), new AbortController().signal);
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_EXIT_NONZERO",
    );
    assertFalse("usage" in outcome);
  },
});

Deno.test("Claude resume requires identity, revision and checkpoint proof", () => {
  const base = localAssignment() as JobAssignment;
  const agentSessionId = base.agentSessionId ?? crypto.randomUUID();
  const checkpoint = {
    agentSessionId,
    nativeSessionId: SESSION_ID,
    worktreeRevision: "base-sha",
    resumeHandleRef: "checkpoint-1",
  };
  const input = {
    resume: {
      sessionId: SESSION_ID,
      worktreeRevision: "base-sha",
      resumeHandleRef: "checkpoint-1",
    },
  };
  assertEquals(
    selectClaudeResumeSession(
      { agentSessionId, currentCheckpoints: [checkpoint] },
      input,
      "base-sha",
    ),
    SESSION_ID,
  );
  assertEquals(
    selectClaudeResumeSession(
      { agentSessionId, currentCheckpoints: [checkpoint] },
      input,
      "changed-sha",
    ),
    undefined,
  );
});

Deno.test("Claude adapter maps invalid input and unsupported actions", async () => {
  const scratch = await prepareScratchRepository("bakery-claude-faults-");
  const fake = await fakeClaude(scratch.dir, "exit 0");
  const executor = executorFor(scratch.dir, fake);
  const invalid = {
    ...localAssignment(),
    input: {},
  } as JobAssignment;
  const invalidOutcome = await executor.execute(
    invalid,
    new AbortController().signal,
  );
  assertEquals(invalidOutcome.status, "failed");
  if (invalidOutcome.status !== "failed") throw new Error("unreachable");
  assertEquals(
    (invalidOutcome.fault as Record<string, unknown>).code,
    "CLAUDE_HARNESS_INPUT_INVALID",
  );
  assertEquals(
    (invalidOutcome.fault as Record<string, unknown>).retryable,
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
    (unsupportedOutcome.fault as Record<string, unknown>).code,
    "CLAUDE_HARNESS_ACTION_UNSUPPORTED",
  );
  assertEquals(
    (unsupportedOutcome.fault as Record<string, unknown>).retryable,
    false,
  );
});

Deno.test("Claude rejects contradictory terminal/session/version streams and overflow", async () => {
  const cases = [
    {
      name: "failure then success",
      body:
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"error","is_error":true,"session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    },
    {
      name: "result before init",
      body:
        `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'`,
    },
    {
      name: "assistant before init",
      body: `printf '%s\\n' '{"type":"assistant","message":"early"}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    },
    {
      name: "user before init",
      body: `printf '%s\\n' '{"type":"user","message":"early"}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    },
    {
      name: "assistant after result",
      body:
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"assistant","message":"late"}'`,
    },
    {
      name: "init after result",
      body:
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'`,
    },
    {
      name: "event session identity changes",
      body:
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"system","subtype":"api_retry","session_id":"00000000-0000-4000-8000-000000000003","retry_delay_ms":50}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    },
    {
      name: "session identity changes",
      body:
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"00000000-0000-4000-8000-000000000003"}'`,
    },
    {
      name: "missing Claude version",
      body:
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    },
    {
      name: "parser overflow",
      body: `printf '%s' '{"type":"assistant","message":"'
dd if=/dev/zero bs=70000 count=1 2>/dev/null | tr '\\0' x
printf '%s\\n' '"}'`,
    },
  ];
  for (const item of cases) {
    const scratch = await prepareScratchRepository(
      `bakery-claude-${item.name.replaceAll(" ", "-")}-`,
    );
    const fake = await fakeClaude(scratch.dir, item.body);
    const publicationCount = { count: 0 };
    const outcome = await executorFor(
      scratch.dir,
      fake,
      5_000,
      { publicationCount },
    ).execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(publicationCount.count, 0, item.name);
    assertEquals(outcome.status, "failed", item.name);
    if (outcome.status !== "failed") throw new Error("unreachable");
    assertEquals(
      (outcome.fault as Record<string, unknown>).code,
      "CLAUDE_HARNESS_EXIT_NONZERO",
      item.name,
    );
  }
});

Deno.test("Claude accepts documented startup hook and plugin records before init", async () => {
  const scratch = await prepareScratchRepository(
    "bakery-claude-startup-hooks-",
  );
  const fake = await fakeClaude(
    scratch.dir,
    `printf '%s\\n' '{"type":"system","subtype":"plugin_install","status":"started"}'
printf '%s\\n' '{"type":"system","subtype":"hook_started","session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"system","subtype":"hook_progress","session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"system","subtype":"hook_response","session_id":"${SESSION_ID}"}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
  );
  const outcome = await executorFor(
    scratch.dir,
    fake,
  ).execute(
    await assignment(scratch.dir),
    new AbortController().signal,
  );
  assertEquals(outcome.status, "completed");
});
Deno.test("Claude retry events remain observable on failure and timeout", async () => {
  const failureScratch = await prepareScratchRepository(
    "bakery-claude-retry-failure-",
  );
  const failureFake = await fakeClaude(
    failureScratch.dir,
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"system","subtype":"api_retry","attempt":3,"retry_delay_ms":125}'
printf '%s\\n' '{"type":"result","subtype":"error","is_error":true,"session_id":"${SESSION_ID}"}'`,
  );
  const failure = await executorFor(
    failureScratch.dir,
    failureFake,
  ).execute(
    await assignment(failureScratch.dir),
    new AbortController().signal,
  );
  assertEquals(failure.status, "failed");
  if (failure.status !== "failed") throw new Error("unreachable");
  assert(
    (
      outcomeResult(failure).fault as Record<string, unknown>
    ).detail?.toString().includes(
      'api_retry_events=[{"type":"api_retry","attempt":3,"delayMs":125}]',
    ),
  );

  const timeoutScratch = await prepareScratchRepository(
    "bakery-claude-retry-timeout-",
  );
  const timeoutFake = await fakeClaude(
    timeoutScratch.dir,
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"system","subtype":"api_retry","attempt":4,"retry_delay_ms":250}'
sleep 60`,
  );
  const timeout = await executorFor(
    timeoutScratch.dir,
    timeoutFake,
    1_000,
  ).execute(
    await assignment(timeoutScratch.dir),
    new AbortController().signal,
  );
  assertEquals(timeout.status, "failed");
  if (timeout.status !== "failed") throw new Error("unreachable");
  assert(
    (
      outcomeResult(timeout).fault as Record<string, unknown>
    ).detail?.toString().includes(
      'api_retry_events=[{"type":"api_retry","attempt":4,"delayMs":250}]',
    ),
  );
});

const QUOTA_FIXTURES = new URL(
  "../fixtures/claude-stream/",
  import.meta.url,
).pathname;

function claudeFault(outcome: unknown): Record<string, unknown> {
  const value = outcome as { status: string; fault?: unknown };
  assertEquals(value.status, "failed");
  assert(contractSchemas.Problem.safeParse(value.fault).success);
  return value.fault as Record<string, unknown>;
}

async function runClaudeStream(
  prefix: string,
  stream: string,
  exitCode: number,
  timeLimitMs = 5_000,
) {
  const scratch = await prepareScratchRepository(prefix);
  const fake = await fakeClaude(
    scratch.dir,
    `cat > /dev/null
cat <<'STREAM'
${stream}
STREAM
exit ${exitCode}`,
  );
  const publications = { count: 0 };
  const outcome = await executorFor(scratch.dir, fake, timeLimitMs, {
    publicationCount: publications,
  }).execute(await assignment(scratch.dir), new AbortController().signal);
  return { outcome, publications };
}

for (const variant of ["rate-limit", "billing"] as const) {
  Deno.test({
    name:
      `Claude maps a recorded provider ${variant} stream to quota_exceeded (#425)`,
    ...RUN_PERMISSIONS,
    fn: async () => {
      const stream = await Deno.readTextFile(
        `${QUOTA_FIXTURES}quota-${variant}.jsonl`,
      );
      const meta = JSON.parse(
        await Deno.readTextFile(`${QUOTA_FIXTURES}quota-${variant}.meta.json`),
      ) as { exitCode: number; stubMessageMarker: string; label: string };
      // The recording is real CLI output against a loopback stub, labeled so.
      assert(meta.label.includes("not a real provider quota"));
      const { outcome, publications } = await runClaudeStream(
        `bakery-claude-quota-${variant}-`,
        stream.trimEnd(),
        meta.exitCode,
      );
      const fault = claudeFault(outcome);
      assertEquals(fault.code, "quota_exceeded");
      assertEquals(fault.status, 429);
      assertEquals(fault.retryable, false);
      // No provider free text reaches the fault.
      const serialized = JSON.stringify(outcome);
      assertFalse(serialized.includes(meta.stubMessageMarker));
      assertFalse(serialized.includes("SYNTHETIC"));
      assertFalse(serialized.includes("credit balance"));
      assertEquals(publications.count, 0);
    },
  });
}

const QUOTA_INIT =
  `{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}`;
const QUOTA_FAILED_RESULT =
  `{"type":"result","subtype":"success","is_error":true,"session_id":"${SESSION_ID}"}`;
const SUCCESS_RESULT =
  `{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}`;

Deno.test({
  name:
    "Claude rate_limit_event rejected with a failed result maps to quota_exceeded (schema-derived, not recorded) (#425)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const rejected = (info: string) =>
      `{"type":"rate_limit_event","rate_limit_info":${info},"uuid":"u","session_id":"${SESSION_ID}"}`;
    const { outcome } = await runClaudeStream(
      "bakery-claude-quota-event-",
      [
        QUOTA_INIT,
        rejected(
          '{"status":"rejected","rateLimitType":"five_hour","resetsAt":1790000000}',
        ),
        QUOTA_FAILED_RESULT,
      ].join("\n"),
      1,
    );
    const fault = claudeFault(outcome);
    assertEquals(fault.code, "quota_exceeded");
    assert(String(fault.detail).includes("rate_limit_type=five_hour"));
    assert(String(fault.detail).includes("resets_at=1790000000"));
    // An unknown limit type or a non-integer reset time is dropped, not echoed.
    const unknown = await runClaudeStream(
      "bakery-claude-quota-unknown-",
      [
        QUOTA_INIT,
        rejected(
          '{"status":"rejected","rateLimitType":"x<script>","resetsAt":"soon"}',
        ),
        QUOTA_FAILED_RESULT,
      ].join("\n"),
      1,
    );
    const detail = String(claudeFault(unknown.outcome).detail);
    assertFalse(detail.includes("script"));
    assertFalse(detail.includes("rate_limit_type"));
    assertFalse(detail.includes("resets_at"));
  },
});

Deno.test({
  name: "Other Claude failures keep their code (#425)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const assistant = (error: string) =>
      `{"type":"assistant","message":{"role":"assistant","content":[]},"error":"${error}","session_id":"${SESSION_ID}"}`;
    const event = (status: string) =>
      `{"type":"rate_limit_event","rate_limit_info":{"status":"${status}"},"session_id":"${SESSION_ID}"}`;
    const retry =
      '{"type":"system","subtype":"api_retry","attempt":1,"retry_delay_ms":10,"error_status":429,"error":"rate_limit"}';
    // api_retry says rate_limit but the retry succeeded: completed.
    const retried = await runClaudeStream(
      "bakery-claude-quota-retry-ok-",
      [QUOTA_INIT, retry, SUCCESS_RESULT].join("\n"),
      0,
    );
    assertEquals(retried.outcome.status, "completed");
    // A quota signal followed by a success (an overage fallback) stands.
    const fallback = await runClaudeStream(
      "bakery-claude-quota-fallback-",
      [QUOTA_INIT, event("rejected"), SUCCESS_RESULT].join("\n"),
      0,
    );
    assertEquals(fallback.outcome.status, "completed");
    for (
      const [label, stream] of [
        ["overloaded", [
          QUOTA_INIT,
          assistant("overloaded"),
          QUOTA_FAILED_RESULT,
        ]],
        ["allowed_warning", [
          QUOTA_INIT,
          event("allowed_warning"),
          QUOTA_FAILED_RESULT,
        ]],
        ["api_retry only", [QUOTA_INIT, retry, QUOTA_FAILED_RESULT]],
        ["authentication_failed", [
          QUOTA_INIT,
          assistant("authentication_failed"),
          QUOTA_FAILED_RESULT,
        ]],
        ["quota plus malformed line", [
          QUOTA_INIT,
          assistant("rate_limit"),
          "not json",
          QUOTA_FAILED_RESULT,
        ]],
        ["quota plus contradictory result", [
          QUOTA_INIT,
          assistant("rate_limit"),
          QUOTA_FAILED_RESULT,
          QUOTA_FAILED_RESULT,
        ]],
        ["quota before init", [
          assistant("rate_limit"),
          QUOTA_INIT,
          QUOTA_FAILED_RESULT,
        ]],
      ] as const
    ) {
      const { outcome } = await runClaudeStream(
        "bakery-claude-quota-other-",
        stream.join("\n"),
        1,
      );
      const fault = claudeFault(outcome);
      assertEquals(fault.code, "CLAUDE_HARNESS_EXIT_NONZERO", label);
      assertEquals(fault.retryable, false, label);
    }
  },
});

Deno.test({
  name: "Claude quota while timed out keeps the timeout code (#425)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-quota-time-");
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' '${QUOTA_INIT}'
printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[]},"error":"rate_limit","session_id":"${SESSION_ID}"}'
sleep 60`,
    );
    const outcome = await executorFor(scratch.dir, fake, 1_000).execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    const fault = claudeFault(outcome);
    assertEquals(fault.code, "CLAUDE_HARNESS_TIMEOUT");
    assertEquals(fault.retryable, true);
  },
});

Deno.test({
  name: "Claude harness passes model and effort as pinned flags",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-model-");
    const argsPath = `${scratch.dir}/args.txt`;
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' "$@" > '${argsPath}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.296","model":"claude-opus-5-5","capabilities":[]}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}","total_cost_usd":0.5}'`,
    );
    const value = await assignment(scratch.dir);
    const outcome = await executorFor(scratch.dir, fake, 5_000, {
      model: "claude-opus-5-5",
      effort: "ultracode",
    }).execute(value, new AbortController().signal);
    assertEquals(outcome.status, "completed");
    const args = await Deno.readTextFile(argsPath);
    assert(args.includes("--model\nclaude-opus-5-5\n"));
    assert(args.includes("--effort\nultracode\n"));
  },
});

Deno.test({
  name: "Claude denies tool access to its config dir (#430)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-deny-");
    const argsPath = `${scratch.dir}/args.txt`;
    const fake = await fakeClaude(
      scratch.dir,
      `printf '%s\\n' "$@" > '${argsPath}'
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0","capabilities":[]}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const value = await assignment(scratch.dir);
    const outcome = await executorFor(scratch.dir, fake).execute(
      value,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
    const args = (await Deno.readTextFile(argsPath)).split("\n");
    // `//` marks an absolute path; the rule names the exact attempt config dir.
    const config =
      `${scratch.dir}/worker-state/claude-harness/${value.attemptId}/config`;
    const flag = args.indexOf("--disallowedTools");
    assert(flag >= 0, "the deny list is missing");
    assertEquals(args.slice(flag + 1, flag + 3), [
      `Read(/${config}/**)`,
      `Edit(/${config}/**)`,
    ]);
    // Deny rules come after the allow list so deny wins in the pinned CLI.
    assert(args.indexOf("--allowedTools") < flag);
  },
});

Deno.test({
  name: "Claude harness rejects an effort outside the pinned vocabulary",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-effort-");
    assertThrows(
      () => executorFor(scratch.dir, "claude", 5_000, { effort: "hyperdrive" }),
      Error,
      "CLAUDE_HARNESS_EFFORT_INVALID",
    );
  },
});

Deno.test({
  name: "Claude retained session state never carries an auth file at any depth",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-retain-");
    // The child hides its own credentials inside the allowlisted subtrees.
    const fake = await fakeClaude(
      scratch.dir,
      `cat > /dev/null
D="$CLAUDE_CONFIG_DIR"
mkdir -p "$D/projects/p" "$D/projects/leak" "$D/todos"
printf '%s\\n' '{"type":"user","session_id":"${SESSION_ID}"}' > "$D/projects/p/${SESSION_ID}.jsonl"
printf '[]' > "$D/todos/${SESSION_ID}.json"
cp "$D/.credentials.json" "$D/projects/leak/.credentials.json"
cp "$D/.credentials.json" "$D/todos/.credentials.json"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0"}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'`,
    );
    const value = {
      ...await assignment(scratch.dir),
      currentCheckpoints: [{
        agentSessionId: "",
        nativeSessionId: SESSION_ID,
        worktreeRevision: scratch.baseSha,
        checkpoint: "retain-checkpoint-1",
      }],
    } as unknown as JobAssignment;
    (value.currentCheckpoints[0] as { agentSessionId: string })
      .agentSessionId = value.agentSessionId!;
    const outcome = await executorFor(scratch.dir, fake).execute(
      value,
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
    const retained: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for await (const entry of Deno.readDir(directory)) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory) await walk(path);
        else retained.push(path);
      }
    };
    await walk(`${scratch.dir}/worker-state/claude-harness/sessions`);
    assert(
      retained.some((path) => path.endsWith(`${SESSION_ID}.jsonl`)),
      "the session record must still be retained",
    );
    assertFalse(
      retained.some((path) => path.endsWith("/.credentials.json")),
      `auth file retained: ${retained.join(", ")}`,
    );
  },
});

Deno.test({
  name:
    "Claude restores the clone after a timeout mid-edit so the next run starts clean",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-claude-restore-");
    const before = await gitText(scratch.dir, ["rev-parse", "HEAD"]);
    const init =
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${SESSION_ID}","claude_code_version":"2.1.0","model":"claude-sonnet","capabilities":["git"]}'`;
    const fake = await fakeClaude(
      scratch.dir,
      `if [ -e '${scratch.dir}/fake-second-run' ]; then
${init}
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"${SESSION_ID}"}'
exit 0
fi
touch '${scratch.dir}/fake-second-run'
printf 'half-edit\\n' >> '${scratch.notesPath}'
printf 'orphan\\n' > '${scratch.dir}/orphan-edit.txt'
${init}
sleep 60`,
    );
    const first = await executorFor(scratch.dir, fake, 1_000).execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(first.status, "failed");
    assertEquals(
      await gitText(scratch.dir, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]),
      "",
    );
    assertEquals(await gitText(scratch.dir, ["rev-parse", "HEAD"]), before);
    const second = await executorFor(scratch.dir, fake).execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(second.status, "completed", JSON.stringify(second));
  },
});
