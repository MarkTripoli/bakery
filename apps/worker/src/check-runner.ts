import {
  CHECK_OBSERVATION_MAX_ITEMS,
  CHECK_REVISION_PATTERN,
  type CheckReason,
  type CheckResult,
  deriveCheckVerdict,
  effectivePolicyDigest,
} from "../../../packages/contracts/src/check-evidence.ts";
import { workerActionOutputSchema } from "../../../packages/contracts/src/contracts.ts";
import {
  RepositoryExecutionContextSchema,
  type RepositoryVersionedProfileConfig,
} from "../../../packages/contracts/src/repository-inspection.ts";
import type {
  PinnedRepositoryRules,
  RepositoryRuleKey,
} from "../../../packages/contracts/src/repository-rules.ts";
import { canonicalJson } from "../../../packages/contracts/src/workflow-compiler/canonical.ts";
import {
  addWorktree,
  ATTEMPT_WORKTREE_LIMITS,
  type AttemptLayout,
  type AttemptScope,
  prepareAttemptRoot,
  removeAttempt,
  sweepAttempts,
} from "./attempt-worktree.ts";
import type { ArtifactRef } from "./client.ts";
import {
  enforceWorkerFixedPolicy,
  type ExecutionOutcome,
  NativeExecutorError,
  type WorkerExecutor,
} from "./executor.ts";
import {
  harnessCanceledOutcome,
  harnessFault,
  type HarnessGroupTeardown,
  HarnessKillTracker,
  harnessTeardownFault,
  killHarnessProcessGroup,
  pumpHarnessOutput,
  sha256Hex,
  spawnHarnessProcess,
} from "./harness-common.ts";
import type { NativeOutputChannel, NativeOutputSink } from "./native-output.ts";
import {
  provenCanceledOutcome,
  type PublishArtifact,
  publishFailureOutcome,
} from "./task-brief.ts";
import type { JobAssignment, JsonValue } from "./types.ts";

/**
 * The worker `quality.check` executor. It checks the candidate
 * revision out into a throwaway detached `git worktree` of the operator
 * repository, runs each selected fixed-policy command there and reports what
 * the process did. Only the process status, the deadline and the output cap
 * decide a result: stdout and stderr are evidence, never a verdict, so a
 * command that prints `PASS` or forged JSON and exits 1 is still `failed`.
 *
 * Trust boundary, stated plainly: the commands are candidate code that runs
 * with the worker user's privileges, with a scrubbed environment, an isolated
 * HOME and TMPDIR, its own process group, a deadline and an output cap. The
 * worker is the trust root. The server recomputes every identity from its own
 * admission pins and verifies this report before it records anything.
 *
 * The worker credential files live in the same state directory as the attempt
 * roots, so where the root sits is not a defense: a candidate command running
 * as the worker user can read them. What the runner does guarantee is that the
 * root is a fresh 0700 subdirectory beside no credential file and that the
 * child environment is built from a closed list that names none of them.
 *
 * Time is bounded twice. Each command has the configured command deadline, and
 * the whole attempt (checkout, tool probes and commands) shares one code-owned
 * budget, so many slow commands cannot hold a worker for hours. A command still
 * running when the budget ends is cut and is `failed/deadline`; checks that had
 * not started are `unavailable/skipped`, which blocks a required check like any
 * other missing evidence. The checkout has its own, shorter deadline; an
 * exceeded checkout is `unavailable/revision_unavailable`.
 *
 * A command can lock directories or write-protect a tree, which nothing can
 * delete. Cleanup first gives the owner full access to every directory it
 * created, without following a symlink, so an attempt root never outlives its
 * attempt. It touches only paths below the attempt root.
 */

const CHECK_ACTION = "quality.check";
/** Where the runner keeps its attempt roots and how it names an unsafe one. */
const CHECK_ATTEMPT_SCOPE: AttemptScope = Object.freeze({
  directory: "checks",
  unsafeRootCode: "CHECK_ATTEMPT_ROOT_UNSAFE",
});
const CHECK_FAULT_TITLE = "The check executor could not run the checks";
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_DURATION_MS = 86_400_000;
const EVIDENCE_SCHEMA = "bakery.check-evidence/v1";
const REDACTION_MARKER = "[REDACTED]";

/** Environment variable that names the one pinned rule binding the command. */
export const CHECK_RULE_KEY_ENV = "BAKERY_CHECK_RULE_KEY";
/** Environment variable holding the canonical JSON options of that pinned rule. */
export const CHECK_RULE_OPTIONS_ENV = "BAKERY_CHECK_RULE_OPTIONS";

/**
 * Text-search tools that cannot honestly check a language-aware rule. A magic
 * value rule bound to one of these is `unsupported_checker`, never a pass.
 */
export const CHECK_UNSUPPORTED_EXECUTABLES: readonly string[] = Object.freeze([
  "grep",
  "egrep",
  "fgrep",
  "ggrep",
  "rg",
  "ag",
  "ack",
  "sed",
  "gsed",
  "awk",
  "gawk",
  "mawk",
  "nawk",
]);

/** Code-owned ceilings; assignment data cannot enlarge them. */
export const CHECK_RUNNER_LIMITS = Object.freeze({
  /** Combined stdout and stderr one command may write before it is cut off. */
  outputBytes: 4 * 1024 * 1024,
  /** Most bytes of each stream kept (the tail) in the evidence artifact. */
  evidenceStreamBytes: 128 * 1024,
  /** Deadline of each git call that prepares or removes the worktree. */
  gitMs: ATTEMPT_WORKTREE_LIMITS.gitMs,
  /** Deadline of the worktree checkout itself, which can be large. */
  checkoutMs: ATTEMPT_WORKTREE_LIMITS.checkoutMs,
  /** Budget of a whole attempt: checkout, tool probes and every command. */
  attemptMs: 4 * 60 * 60 * 1000,
  /** Deadline of the tool-resolution probe. */
  probeMs: 5_000,
  /** How long to wait for output pumps after the process group was cut. */
  pumpDrainMs: 2_000,
});
export type CheckRunnerLimits = {
  -readonly [K in keyof typeof CHECK_RUNNER_LIMITS]: number;
};

export type CheckExecutorOptions = {
  /** The operator repository that holds the candidate commit (the harness repository). */
  readonly repository: string;
  /** Private worker state root; attempt roots live in its `checks` subdirectory. */
  readonly stateDir: string;
  /** Publishes artifacts for one assignment through the worker byte boundary. */
  readonly publishFor: (assignment: JobAssignment) => PublishArtifact;
  /** Wall-clock deadline of each command, in milliseconds. */
  readonly commandTimeLimitMs: number;
  /** Values that must never reach the captured evidence (configured secrets). */
  readonly redactionSecrets?: readonly string[];
  /**
   * Credential and state files of the worker. The attempt root must sit
   * outside and beside none of them and no child environment value may name one.
   */
  readonly credentialPaths?: readonly string[];
  /** Test seam: overrides of the code-owned limits. */
  readonly limits?: Partial<CheckRunnerLimits>;
  /** Test seam: absolute group-kill helper used when Deno.kill is not granted. */
  readonly groupKillExecutable?: string;
};

type FixedPolicy = NonNullable<
  Extract<RepositoryVersionedProfileConfig, { schemaVersion: 2 }>["fixedPolicy"]
>;

/** One selected check after it was matched to the pinned policy and rules. */
export type PlannedCheck = {
  readonly checkId: string;
  /** Argv taken from the fixed policy; null when the policy has no such command. */
  readonly argv: readonly string[] | null;
  /** The one enabled pinned rule that binds this command, or null. */
  readonly ruleKey: RepositoryRuleKey | null;
  /** Canonical JSON of that rule's options, or null. */
  readonly ruleOptions: string | null;
  /** Reason the command must not run at all, or null when it may run. */
  readonly unavailable: CheckReason | null;
};

/** What the report says about one check, wire shape of `CheckObservation`. */
export type CheckObservation = {
  readonly checkRunId: string;
  readonly checkId: string;
  readonly kind: "command";
  readonly ruleKey: RepositoryRuleKey | null;
  readonly result: CheckResult;
  readonly reason: CheckReason;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputDigest: string;
  readonly evidence: ArtifactRef;
};

/** Artifact name for one check of one attempt; unique per job, fence and check. */
export function checkArtifactName(
  jobId: string,
  fence: string | number,
  checkId: string,
): string {
  return `check-${jobId}-${fence}-${checkId}.json`;
}

function executableBasename(argv0: string): string {
  const slash = argv0.lastIndexOf("/");
  return slash < 0 ? argv0 : argv0.slice(slash + 1);
}

/**
 * Matches every selected check to the pinned fixed policy and rules. Argv comes
 * from the policy only. A rule binds a command when it is enabled and its
 * `checkBinding` names the command: exactly one binding passes the rule key and
 * options to the command, more than one is ambiguous and a text-search tool
 * cannot check a language-aware rule. Nothing here starts a process.
 */
export function planChecks(
  policy: FixedPolicy,
  rules: PinnedRepositoryRules | undefined,
  checkIds: readonly string[],
): PlannedCheck[] {
  const commands = new Map(
    policy.commands.map((command) => [command.id, command.argv]),
  );
  return checkIds.map((checkId): PlannedCheck => {
    const argv = commands.get(checkId) ?? null;
    if (argv === null) {
      return {
        checkId,
        argv,
        ruleKey: null,
        ruleOptions: null,
        unavailable: "policy_missing",
      };
    }
    const bound = (rules?.entries ?? []).filter((entry) =>
      entry.enabled && "checkBinding" in entry.options &&
      entry.options.checkBinding === checkId
    );
    if (bound.length > 1) {
      return {
        checkId,
        argv,
        ruleKey: null,
        ruleOptions: null,
        unavailable: "rule_binding_ambiguous",
      };
    }
    const rule = bound[0];
    if (rule === undefined) {
      return {
        checkId,
        argv,
        ruleKey: null,
        ruleOptions: null,
        unavailable: null,
      };
    }
    return {
      checkId,
      argv,
      ruleKey: rule.ruleKey,
      ruleOptions: canonicalJson(rule.options),
      unavailable: CHECK_UNSUPPORTED_EXECUTABLES.includes(
          executableBasename(argv[0]!),
        )
        ? "unsupported_checker"
        : null,
    };
  });
}

function checkFault(
  code: string,
  detail: string,
  status = 422,
): ExecutionOutcome {
  return harnessFault(code, detail, status, false, CHECK_FAULT_TITLE);
}

function safeSegment(value: string | undefined): value is string {
  return value !== undefined && value !== "." && value !== ".." &&
    SAFE_SEGMENT.test(value);
}

/** The last bytes of a stream, bounded; the head is dropped as new bytes arrive. */
class TailBuffer {
  #chunks: Uint8Array[] = [];
  #size = 0;
  #truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Uint8Array): void {
    this.#chunks.push(chunk);
    this.#size += chunk.byteLength;
    while (
      this.#chunks.length > 1 &&
      this.#size - this.#chunks[0]!.byteLength >= this.limit
    ) {
      this.#size -= this.#chunks.shift()!.byteLength;
      this.#truncated = true;
    }
  }

  get truncated(): boolean {
    return this.#truncated || this.#size > this.limit;
  }

  bytes(): Uint8Array {
    const merged = new Uint8Array(this.#size);
    let offset = 0;
    for (const chunk of this.#chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged.byteLength > this.limit
      ? merged.subarray(merged.byteLength - this.limit)
      : merged;
  }
}

type CommandRun =
  | { readonly kind: "not_started" }
  | {
    readonly kind: "aborted";
    readonly teardown: HarnessGroupTeardown | "not-needed";
  }
  | {
    readonly kind: "finished";
    readonly code: number;
    readonly signal: string | null;
    readonly breach: "deadline" | "output_limit" | null;
    readonly durationMs: number;
    readonly stdout: TailBuffer;
    readonly stderr: TailBuffer;
    /** Whether the group cut after the leader exited was confirmed empty. */
    readonly teardown: HarnessGroupTeardown;
  };

type CommandOptions = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: { readonly HOME: string } & Record<string, string>;
  readonly deadlineMs: number;
  readonly outputLimitBytes: number;
  readonly tailBytes: number;
  readonly drainMs: number;
  readonly signal: AbortSignal;
  readonly output?: NativeOutputSink;
  readonly groupKillExecutable?: string;
};

/** Resolves when `work` settles or after `milliseconds`, whichever is first. */
async function settleWithin(
  work: Promise<unknown>,
  milliseconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Runs one argv in its own process group under a deadline and an output cap.
 * The result is the process status and limit breaches only. After the leader
 * exits the whole group is cut, so a background process cannot hold the pipes
 * open, outlive the check or write into the worktree being removed.
 */
async function runCommand(options: CommandOptions): Promise<CommandRun> {
  const startedAt = performance.now();
  let child: Deno.ChildProcess;
  try {
    child = await spawnHarnessProcess({
      executable: options.argv[0]!,
      args: options.argv.slice(1),
      cwd: options.cwd,
      environment: options.environment,
    });
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) return { kind: "not_started" };
    throw error;
  }
  // The checked command never reads input.
  await child.stdin.close().catch(() => undefined);

  const kills = new HarnessKillTracker();
  void child.status.then(() => kills.markExited(), () => undefined);
  let teardown: Promise<HarnessGroupTeardown> | undefined;
  let breach: "deadline" | "output_limit" | null = null;
  const terminate = () => {
    kills.markKilled();
    teardown ??= killHarnessProcessGroup(child, options.groupKillExecutable);
  };
  const timer = setTimeout(() => {
    breach ??= "deadline";
    terminate();
  }, options.deadlineMs);
  options.signal.addEventListener("abort", terminate, { once: true });
  if (options.signal.aborted) terminate();

  const stdout = new TailBuffer(options.tailBytes);
  const stderr = new TailBuffer(options.tailBytes);
  let total = 0;
  const onChunk = (channel: NativeOutputChannel, chunk: Uint8Array) => {
    (channel === "stdout" ? stdout : stderr).push(chunk);
    total += chunk.byteLength;
    if (total > options.outputLimitBytes && breach === null) {
      breach = "output_limit";
      terminate();
    }
  };
  const pumps = Promise.allSettled([
    pumpHarnessOutput(
      child.stdout,
      "stdout",
      options.output,
      kills.cutLiveLeader,
      onChunk,
    ),
    pumpHarnessOutput(
      child.stderr,
      "stderr",
      options.output,
      kills.cutLiveLeader,
      onChunk,
    ),
  ]);
  try {
    const status = await child.status;
    clearTimeout(timer);
    // The leader is gone: cut whatever it left behind so the pipes close.
    terminate();
    await settleWithin(pumps, options.drainMs);
    const closed = await teardown!;
    if (options.signal.aborted) return { kind: "aborted", teardown: closed };
    return {
      kind: "finished",
      code: status.code,
      signal: status.signal,
      breach,
      durationMs: Math.max(
        0,
        Math.min(MAX_DURATION_MS, Math.round(performance.now() - startedAt)),
      ),
      stdout,
      stderr,
      teardown: closed,
    };
  } catch (error) {
    clearTimeout(timer);
    terminate();
    await teardown;
    await child.status.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", terminate);
  }
}

/**
 * Script that answers whether an argv0 names something runnable, run through
 * the same launcher as the command. The worker's file grants are an exact list,
 * so a file lookup from the worker would throw PermissionDenied for every tool.
 */
const RESOLVE_SCRIPT = [
  'case "$1" in',
  '  */*) [ -f "$1" ] && [ -x "$1" ] ;;',
  '  *) found=$(command -v "$1") && [ "${found#/}" != "$found" ] ;;',
  "esac",
].join("\n");

/**
 * Asks the launcher whether `argv0` names a runnable tool on the child's PATH
 * or worktree. Returns the abort teardown when the attempt was canceled.
 */
async function toolResolves(
  argv0: string,
  command: Omit<CommandOptions, "argv" | "outputLimitBytes" | "tailBytes">,
  limits: CheckRunnerLimits,
): Promise<
  boolean | { readonly teardown: HarnessGroupTeardown | "not-needed" }
> {
  if (argv0.startsWith("-")) return false;
  const probe = await runCommand({
    ...command,
    argv: ["/bin/sh", "-c", RESOLVE_SCRIPT, "sh", argv0],
    deadlineMs: limits.probeMs,
    outputLimitBytes: 4_096,
    tailBytes: 1,
    output: undefined,
  });
  if (probe.kind === "aborted") return { teardown: probe.teardown };
  return probe.kind === "finished" && probe.code === 0 &&
    probe.signal === null && probe.breach === null;
}

function redactText(text: string, secrets: readonly string[]): string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    needles.add(secret);
    const json = JSON.stringify(secret).slice(1, -1);
    if (json.length > 0) needles.add(json);
  }
  let redacted = text;
  for (
    const needle of [...needles].sort((a, b) => b.length - a.length)
  ) redacted = redacted.replaceAll(needle, REDACTION_MARKER);
  return redacted;
}

/** JSON the media sniffer cannot read as markup: `<`, `>`, `&` and DEL are escaped. */
function evidenceJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u007f]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

type Observed = {
  readonly result: CheckResult;
  readonly reason: CheckReason;
  readonly exitCode: number | null;
  readonly signalName: string | null;
  readonly durationMs: number;
  readonly stdout: TailBuffer | null;
  readonly stderr: TailBuffer | null;
};

function notRun(reason: CheckReason): Observed {
  return {
    result: "unavailable",
    reason,
    exitCode: null,
    signalName: null,
    durationMs: 0,
    stdout: null,
    stderr: null,
  };
}

/** Maps process facts to a result. Output text is not an input. */
function observedFrom(
  run: Extract<CommandRun, { kind: "finished" }>,
): Observed {
  const base = {
    signalName: run.signal,
    durationMs: run.durationMs,
    stdout: run.stdout,
    stderr: run.stderr,
  };
  if (run.breach !== null) {
    return { ...base, result: "failed", reason: run.breach, exitCode: null };
  }
  if (run.signal !== null) {
    return { ...base, result: "failed", reason: "signal", exitCode: null };
  }
  if (run.code === 0) {
    return { ...base, result: "passed", reason: "verified", exitCode: 0 };
  }
  return {
    ...base,
    result: "failed",
    reason: "exit_nonzero",
    exitCode: run.code >= 1 && run.code <= 255 ? run.code : null,
  };
}

type InputCheck = {
  readonly revision: string;
  readonly checks: readonly string[];
};

function readCheckInput(
  input: Record<string, unknown> | null,
): InputCheck | ExecutionOutcome {
  const revision = input?.revision;
  if (typeof revision !== "string" || !CHECK_REVISION_PATTERN.test(revision)) {
    return checkFault(
      "CHECK_REVISION_INVALID",
      "quality.check needs a full 40-character lowercase commit SHA; no process started.",
    );
  }
  const checks = input?.checks;
  if (
    !Array.isArray(checks) || checks.length === 0 ||
    checks.length > CHECK_OBSERVATION_MAX_ITEMS ||
    checks.some((check) => typeof check !== "string") ||
    new Set(checks).size !== checks.length
  ) {
    return checkFault(
      "CHECK_INPUT_INVALID",
      "quality.check needs between one and 32 distinct check ids; no process started.",
    );
  }
  return { revision, checks: checks as string[] };
}

async function executeCheck(
  assignment: JobAssignment,
  signal: AbortSignal,
  output: NativeOutputSink | undefined,
  options: CheckExecutorOptions,
): Promise<ExecutionOutcome> {
  await enforceWorkerFixedPolicy(assignment);
  const input = assignment.input !== null &&
      typeof assignment.input === "object" && !Array.isArray(assignment.input)
    ? assignment.input as Record<string, unknown>
    : null;
  const profile = RepositoryExecutionContextSchema.safeParse(
    input?.repositoryProfile,
  );
  const policy = profile.success && profile.data.config.schemaVersion === 2
    ? profile.data.config.fixedPolicy
    : undefined;
  if (
    !profile.success || policy === undefined ||
    profile.data.baseSha === null ||
    profile.data.fixedPolicyDigest === undefined ||
    profile.data.trustedCheckerConfigDigest === undefined
  ) {
    return checkFault(
      "CHECK_POLICY_MISSING",
      "quality.check runs only the argv of a fixed repository policy; the job carries no repository profile with one. No process started.",
    );
  }
  const parsed = readCheckInput(input);
  if ("status" in parsed) return parsed;
  const { revision, checks } = parsed;
  if (!safeSegment(assignment.attemptId)) {
    return checkFault(
      "CHECK_INPUT_INVALID",
      "quality.check needs a safe attempt identifier; no process started.",
    );
  }
  if (signal.aborted) return provenCanceledOutcome();

  const limits: CheckRunnerLimits = {
    ...CHECK_RUNNER_LIMITS,
    ...options.limits,
  };
  // The attempt budget starts before the checkout and is shared by everything.
  const startedAt = performance.now();
  const remainingMs = () => limits.attemptMs - (performance.now() - startedAt);
  const plan = planChecks(policy, profile.data.repositoryRules, checks);
  const secrets = [assignment.leaseToken, ...(options.redactionSecrets ?? [])];
  const publish = options.publishFor(assignment);
  const baseSha = profile.data.baseSha;
  const credentialPaths = options.credentialPaths ?? [];

  let layout: AttemptLayout;
  try {
    layout = await prepareAttemptRoot(
      options,
      CHECK_ATTEMPT_SCOPE,
      assignment.attemptId,
    );
  } catch (error) {
    if (
      error instanceof NativeExecutorError &&
      error.message === "CHECK_ATTEMPT_ROOT_UNSAFE"
    ) {
      return checkFault(
        "CHECK_ATTEMPT_ROOT_UNSAFE",
        "The attempt root would sit beside or under a worker credential file; no process started.",
        500,
      );
    }
    throw error;
  }
  let worktreeAdded = false;
  try {
    const worktree = await addWorktree(options, layout, revision, signal);
    worktreeAdded = worktree.added;
    if (worktree.state === "aborted") return provenCanceledOutcome();

    const environment = {
      HOME: layout.home,
      TMPDIR: layout.tmp,
    };
    if (
      Object.values(environment).some((value) =>
        credentialPaths.some((path) => value.includes(path))
      )
    ) {
      return checkFault(
        "CHECK_ATTEMPT_ROOT_UNSAFE",
        "A child environment value would name a worker credential file; no process started.",
        500,
      );
    }

    const observations: CheckObservation[] = [];
    for (const planned of plan) {
      if (signal.aborted) return provenCanceledOutcome();
      let observed: Observed;
      if (worktree.state === "unavailable") {
        // Precedence, mirrored by the server's report check (check-report.ts):
        // an unreachable revision belongs to the whole attempt, so it is the
        // reason of every command, one with two bound rules included. The
        // ruleKey stays the plan's (null for an ambiguous binding).
        observed = notRun("revision_unavailable");
      } else if (planned.unavailable !== null) {
        observed = notRun(planned.unavailable);
      } else if (remainingMs() <= 0) {
        // The attempt budget is spent: nothing more may start.
        observed = notRun("skipped");
      } else {
        const argv = planned.argv!;
        const left = Math.max(1, Math.floor(remainingMs()));
        const resolved = await toolResolves(argv[0]!, {
          cwd: layout.worktree,
          environment,
          deadlineMs: limits.probeMs,
          drainMs: limits.pumpDrainMs,
          signal,
          groupKillExecutable: options.groupKillExecutable,
        }, { ...limits, probeMs: Math.min(limits.probeMs, left) });
        if (typeof resolved === "object") {
          return harnessCanceledOutcome(resolved.teardown);
        }
        if (!resolved) {
          observed = notRun("tool_missing");
        } else {
          const ruleEnvironment: Record<string, string> =
            planned.ruleKey !== null && planned.ruleOptions !== null
              ? {
                [CHECK_RULE_KEY_ENV]: planned.ruleKey,
                [CHECK_RULE_OPTIONS_ENV]: planned.ruleOptions,
              }
              : {};
          const run = await runCommand({
            argv,
            cwd: layout.worktree,
            environment: { ...environment, ...ruleEnvironment },
            // The command's own limit, or what is left of the attempt.
            deadlineMs: Math.min(
              options.commandTimeLimitMs,
              Math.max(1, Math.floor(remainingMs())),
            ),
            outputLimitBytes: limits.outputBytes,
            tailBytes: limits.evidenceStreamBytes,
            drainMs: limits.pumpDrainMs,
            signal,
            output,
            groupKillExecutable: options.groupKillExecutable,
          });
          if (run.kind === "aborted") {
            return harnessCanceledOutcome(run.teardown);
          }
          // A deadline or output cut whose group kill is unconfirmed may leave a
          // runaway process writing into the worktree about to be removed.
          if (
            run.kind === "finished" && run.breach !== null &&
            run.teardown.status === "unconfirmed"
          ) return harnessTeardownFault("CHECK", run.teardown);
          observed = run.kind === "finished"
            ? observedFrom(run)
            : notRun("tool_missing");
        }
      }
      if (signal.aborted) return provenCanceledOutcome();

      const decode = (tail: TailBuffer | null) =>
        tail === null
          ? ""
          : redactText(new TextDecoder().decode(tail.bytes()), secrets);
      const bytes = new TextEncoder().encode(evidenceJson({
        schema: EVIDENCE_SCHEMA,
        checkId: planned.checkId,
        kind: "command",
        result: observed.result,
        reason: observed.reason,
        exitCode: observed.exitCode,
        signal: observed.signalName,
        durationMs: observed.durationMs,
        headSha: revision,
        baseSha,
        stdout: decode(observed.stdout),
        stderr: decode(observed.stderr),
        stdoutTruncated: observed.stdout?.truncated ?? false,
        stderrTruncated: observed.stderr?.truncated ?? false,
      }));
      const outputDigest = await sha256Hex(bytes);
      let evidence: ArtifactRef;
      try {
        evidence = await publish({
          idempotencyKey:
            `check:${assignment.jobId}:${assignment.fence}:${planned.checkId}`,
          artifactType: "check",
          mediaType: "application/json",
          name: checkArtifactName(
            assignment.jobId,
            assignment.fence,
            planned.checkId,
          ),
          bytes,
          subjectHeadSha: revision,
          subjectBaseSha: baseSha,
          metadata: {
            checkId: planned.checkId,
            exitCode: observed.exitCode,
            reason: observed.reason,
          },
        }, signal);
      } catch (error) {
        return publishFailureOutcome(error, signal);
      }
      if (evidence.sha256 !== outputDigest) {
        return checkFault(
          "CHECK_ARTIFACT_DIGEST_MISMATCH",
          "The published check evidence digest differs from the captured bytes.",
          500,
        );
      }
      observations.push({
        checkRunId: crypto.randomUUID(),
        checkId: planned.checkId,
        kind: "command",
        ruleKey: planned.ruleKey,
        result: observed.result,
        reason: observed.reason,
        exitCode: observed.exitCode,
        durationMs: observed.durationMs,
        outputDigest,
        evidence,
      });
    }

    const verdict = deriveCheckVerdict(observations, policy.decisions);
    const result = {
      allRequired: verdict.allRequired,
      checkRunIds: observations.map((observation) => observation.checkRunId),
      failedCheckIds: [...verdict.failedCheckIds],
      observations,
      headSha: revision,
      baseSha,
      policyDigest: await effectivePolicyDigest({
        fixedPolicyDigest: profile.data.fixedPolicyDigest,
        trustedCheckerConfigDigest: profile.data.trustedCheckerConfigDigest,
        entries: profile.data.repositoryRules?.entries ?? [],
      }),
    };
    if (!workerActionOutputSchema(CHECK_ACTION).safeParse(result).success) {
      return checkFault(
        "CHECK_OUTPUT_INVALID",
        "The check report does not satisfy the quality.check output contract.",
        500,
      );
    }
    return { status: "completed", result: result as unknown as JsonValue };
  } finally {
    await removeAttempt(options, layout, worktreeAdded);
  }
}

/**
 * Wraps `inner` so it also runs `quality.check`. Every other action goes to
 * the wrapped executor unchanged; `quality.check` never reaches it, so a
 * test-only override on the inner executor cannot shadow the real runner.
 */
export function createCheckExecutor(
  inner: WorkerExecutor,
  options: CheckExecutorOptions,
): WorkerExecutor {
  return {
    supportedActions: [
      ...new Set([...(inner.supportedActions ?? []), CHECK_ACTION]),
    ],
    capturesNativeOutput: inner.capturesNativeOutput ?? true,
    async initialize() {
      await inner.initialize?.();
      await sweepAttempts(options, CHECK_ATTEMPT_SCOPE);
    },
    readinessChecks: inner.readinessChecks?.bind(inner),
    control: inner.control?.bind(inner),
    credentialRedactionSecrets: inner.credentialRedactionSecrets?.bind(inner),
    execute(assignment, signal, output, preparedSkills) {
      if (assignment.action !== CHECK_ACTION) {
        return inner.execute(assignment, signal, output, preparedSkills);
      }
      if (
        assignment.skillRefs.length > 0 ||
        (preparedSkills?.roots.length ?? 0) > 0
      ) {
        throw new NativeExecutorError(
          "PREPARED_SKILL_ROOTS_UNSUPPORTED:quality.check",
        );
      }
      return executeCheck(assignment, signal, output, options);
    },
  };
}
