import { join } from "node:path";
import { enforceWorkerFixedPolicy, type WorkerExecutor } from "./executor.ts";
import type { ExecutionOutcome } from "./executor.ts";
import type { NativeOutputSink } from "./native-output.ts";
import {
  buildRepairPrompt,
  createHarnessBusyLatch,
  HARNESS_REPAIR_ACTION,
  harnessCanceledOutcome,
  harnessCredentialSecrets,
  harnessCredentialUnavailable,
  harnessFault as commonHarnessFault,
  harnessHeadRevision,
  harnessReadinessChecks,
  type HarnessRestoreTarget,
  harnessTeardownFault,
  harnessWorktreeGuard,
  initializeHarnessWorktree,
  isHarnessEditAction,
  prepareHarnessHome,
  probeHarnessVersion,
  publishHarnessPatch,
  readRepairInput,
  recordHarnessRestoreTarget,
  repairCommitMessage,
  repairRevisionMismatch,
  requireCleanHarnessWorktree,
  runBoundedHarness,
  withHarnessRestore,
} from "./harness-common.ts";
import { provenCanceledOutcome, type PublishArtifact } from "./task-brief.ts";
import type { JobAssignment } from "./types.ts";
import { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";

/**
 * The real Codex harness adapter. It runs the pinned,
 * non-interactive `codex exec` batch interface in the assignment's prepared
 * repository worktree. Per the harness-adapter contract
 * (docs/technical-design/05-runtime-and-protocols.md) this adapter owns the
 * subprocess pipes and relies on the operator's already-authorized local
 * Codex login; Bakery receives only normalized bounded evidence: exit status,
 * the actual Git revision after the run, and artifacts published through the
 * existing `PublishArtifact` byte boundary.
 *
 * Each run gets an isolated per-attempt HOME and CODEX_HOME. Only the
 * operator's `auth.json` is copied in (never config, history or sessions), and
 * a missing login fails closed as `CODEX_HARNESS_CREDENTIAL_UNAVAILABLE`.
 *
 * Before each run the adapter probes `codex --version` and records the
 * first line as `codexVersion` on the result, so the version that produced a
 * patch is evidence rather than an assumption.
 *
 * `harness.repair` runs the same batch interface from a repair prompt (the
 * blocking findings and failed checks of one candidate) after proving the clean
 * worktree sits at exactly the revision to repair.
 *
 * `codex exec` proves batch execution only. This adapter never advertises
 * steer, resume, or follow-up capabilities, and it contains no API-billing
 * fallback: no usage receipt is ever fabricated for a Codex subscription run.
 */

const CODEX_ACTION = "harness.implement";
const CODEX_AUTH_FILE = "auth.json";
const MAX_CODEX_AUTH_BYTES = 64 * 1024;
/** Only actions proven by the pinned batch interface. */
export const CODEX_HARNESS_SUPPORTED_ACTIONS = [
  CODEX_ACTION,
  HARNESS_REPAIR_ACTION,
] as const;
const CODEX_FAULT_TITLE =
  "The Codex harness could not complete the bounded task";
const CODEX_FAULT_NAMING = Object.freeze({
  prefix: "CODEX_HARNESS",
  title: CODEX_FAULT_TITLE,
});
/** Batch execution only: no steer/resume/interrupt advertisement (AC3). */
export const CODEX_HARNESS_CAPABILITIES: readonly string[] = Object.freeze([]);
export const CODEX_HARNESS_DEFAULT_TIME_LIMIT_MS = 120_000;

export type CodexHarnessOptions = {
  /** Configured output redaction secrets; also withheld from published patches. */
  readonly redactionSecrets?: readonly string[];
  /** Test seam: absolute group-kill helper used when Deno.kill is not granted. */
  readonly groupKillExecutable?: string;
  /** Publishes artifacts for one assignment through the worker byte boundary. */
  readonly publishFor: (assignment: JobAssignment) => PublishArtifact;
  /** Resolves the prepared repository worktree the assignment runs against. */
  readonly repositoryFor: (
    assignment: JobAssignment,
  ) => string | Promise<string>;
  /** Explicit wall-clock limit for one bounded run. */
  readonly timeLimitMs?: number;
  /** Pinned `codex` executable; defaults to the operator's PATH. */
  readonly codexExecutable?: string;
  /** Private worker state root; holds the durable restore marker. */
  readonly stateDir?: string;
  /**
   * Explicit source of the operator's Codex auth.json; never passed to the
   * child. Required: a run without credentials fails closed before spawn.
   */
  readonly authSourceDir: string;
  /**
   * Fixed harness repository. With `stateDir`, a durable restore marker lets a
   * restarted worker recover an interrupted run and report a dirty clone.
   */
  readonly repository?: string;
  /** Remaining unsupported actions delegate to this executor. */
  readonly inner?: WorkerExecutor;
};

function codexHarnessFault(
  code: string,
  detail: string,
  status: number,
  retryable: boolean,
): ExecutionOutcome {
  return commonHarnessFault(
    code,
    detail,
    status,
    retryable,
    "The Codex harness could not complete the bounded task",
  );
}

function safeStateSegment(value: string | undefined): value is string {
  return value !== undefined && value !== "." && value !== ".." &&
    /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

async function sweepCodexAttemptDirectories(stateDir: string): Promise<void> {
  const root = join(stateDir, "codex-harness");
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  await Deno.chmod(root, 0o700);
  for await (const entry of Deno.readDir(root)) {
    await Deno.remove(join(root, entry.name), { recursive: true }).catch(
      (error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      },
    );
  }
}

/**
 * Creates the per-attempt Codex layout: `home/` is the child HOME and
 * `codex/` is CODEX_HOME. The whole root is removed when the attempt ends;
 * Codex never resumes, so nothing is retained.
 */
async function codexAttemptDirectory(
  options: CodexHarnessOptions,
  assignment: JobAssignment,
): Promise<{ root: string; codexHome: string; home: string }> {
  let root: string;
  if (options.stateDir) {
    if (!safeStateSegment(assignment.attemptId)) {
      throw new Error("CODEX_HARNESS_ATTEMPT_ID_INVALID");
    }
    await sweepCodexAttemptDirectories(options.stateDir);
    root = join(options.stateDir, "codex-harness", assignment.attemptId);
    await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  } else {
    root = await Deno.makeTempDir({ prefix: "bakery-codex-harness-" });
  }
  try {
    await Deno.chmod(root, 0o700);
    const codexHome = join(root, "codex");
    await Deno.mkdir(codexHome, { recursive: true, mode: 0o700 });
    await Deno.chmod(codexHome, 0o700);
    return { root, codexHome, home: await prepareHarnessHome(root) };
  } catch (error) {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

/** Copies only the operator's auth.json into the attempt CODEX_HOME. */
async function prepareCodexAuth(
  sourceRoot: string,
  codexHome: string,
): Promise<void> {
  const sourceInfo = await Deno.lstat(sourceRoot).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  if (!sourceInfo) throw new Error("CODEX_HARNESS_AUTH_UNAVAILABLE");
  if (sourceInfo.isSymlink || !sourceInfo.isDirectory) {
    throw new Error("CODEX_HARNESS_AUTH_SOURCE_INVALID");
  }
  const source = join(sourceRoot, CODEX_AUTH_FILE);
  const info = await Deno.lstat(source).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  if (!info) throw new Error("CODEX_HARNESS_AUTH_UNAVAILABLE");
  if (info.isSymlink || !info.isFile || info.size > MAX_CODEX_AUTH_BYTES) {
    throw new Error("CODEX_HARNESS_AUTH_FILE_INVALID");
  }
  const destination = join(codexHome, CODEX_AUTH_FILE);
  await Deno.copyFile(source, destination);
  await Deno.chmod(destination, 0o600);
}

async function executeCodexHarness(
  assignment: JobAssignment,
  signal: AbortSignal,
  output: NativeOutputSink | undefined,
  options: CodexHarnessOptions,
  restore: HarnessRestoreTarget,
): Promise<ExecutionOutcome> {
  await enforceWorkerFixedPolicy(assignment);
  const input = assignment.input as Record<string, unknown> | null;
  const repair = assignment.action === HARNESS_REPAIR_ACTION
    ? readRepairInput(assignment, CODEX_FAULT_NAMING)
    : undefined;
  if (repair !== undefined && "status" in repair) return repair;
  const planArtifact = input !== null && typeof input === "object"
    ? input.planArtifact
    : undefined;
  const profile = RepositoryExecutionContextSchema.safeParse(
    input?.repositoryProfile,
  );
  if (
    repair === undefined &&
    (typeof planArtifact !== "string" || !profile.success)
  ) {
    return codexHarnessFault(
      "CODEX_HARNESS_INPUT_INVALID",
      "The Codex harness needs a plan artifact and a repository profile.",
      500,
      false,
    );
  }
  if (options.stateDir && !safeStateSegment(assignment.attemptId)) {
    return codexHarnessFault(
      "CODEX_HARNESS_INPUT_INVALID",
      "The Codex harness needs a safe attempt identifier.",
      500,
      false,
    );
  }
  if (signal.aborted) return provenCanceledOutcome();

  const worktree = await options.repositoryFor(assignment);
  const dirty = await requireCleanHarnessWorktree(worktree, "CODEX_HARNESS");
  if (dirty) return dirty;
  const baseSha = await harnessHeadRevision(worktree, "CODEX_HARNESS");
  if (repair !== undefined) {
    // Before the restore target is recorded: nothing was changed to restore.
    const mismatch = repairRevisionMismatch(
      CODEX_FAULT_NAMING,
      repair.revision,
      baseSha,
    );
    if (mismatch) return mismatch;
  }
  await recordHarnessRestoreTarget(
    restore,
    worktree,
    baseSha,
    harnessWorktreeGuard(options)?.stateDir,
  );

  const basePrompt = [
    "Implement the task pinned by plan artifact",
    planArtifact,
    "inside the current repository working tree.",
    "Edit files in place. Do not push, publish, or contact external services",
    "other than the model provider itself.",
  ].join(" ");
  // Optional bounded task instructions come from the admitted job input; the
  // adapter never derives executable argv or environment from assignment data.
  const instructions = typeof input?.instructions === "string" &&
      input.instructions.length > 0 && input.instructions.length <= 4_000
    ? input.instructions
    : undefined;
  const prompt = repair !== undefined
    ? buildRepairPrompt(repair)
    : instructions === undefined
    ? basePrompt
    : `${basePrompt}\n\nTask instructions:\n${instructions}`;
  const commitMessage = repair !== undefined
    ? repairCommitMessage(repair.revision)
    : `bakery: plan artifact ${planArtifact}`;

  const codexExecutable = options.codexExecutable ?? "codex";
  const dirs = await codexAttemptDirectory(options, assignment);
  try {
    try {
      await prepareCodexAuth(options.authSourceDir, dirs.codexHome);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "CODEX_HARNESS_AUTH_UNAVAILABLE"
      ) {
        return harnessCredentialUnavailable(
          "CODEX",
          "Codex",
          "The Codex harness could not complete the bounded task",
        );
      }
      return codexHarnessFault(
        "CODEX_HARNESS_INPUT_INVALID",
        "Codex native authentication preparation was unavailable.",
        500,
        false,
      );
    }
    // The sandbox restricts writes, not reads: the child can read its auth
    // copy, so redact every token in it from output and patches.
    let credentialSecrets: readonly string[];
    try {
      credentialSecrets = await harnessCredentialSecrets(
        join(options.authSourceDir, CODEX_AUTH_FILE),
      );
    } catch {
      return harnessCredentialUnavailable(
        "CODEX",
        "Codex",
        "The Codex harness could not complete the bounded task",
      );
    }
    const childEnvironment = { HOME: dirs.home, CODEX_HOME: dirs.codexHome };
    const versionProbe = await probeHarnessVersion(
      codexExecutable,
      worktree,
      childEnvironment,
      signal,
    );
    if (signal.aborted) return harnessCanceledOutcome(versionProbe.teardown);
    if (
      versionProbe.teardown !== "not-needed" &&
      versionProbe.teardown.status === "unconfirmed"
    ) {
      return harnessTeardownFault("CODEX", versionProbe.teardown);
    }
    if (versionProbe.timedOut) {
      return codexHarnessFault(
        "CODEX_HARNESS_TIMEOUT",
        "The pinned Codex CLI version probe exceeded its startup deadline.",
        504,
        true,
      );
    }
    const codexVersion = versionProbe.version;
    if (!codexVersion) {
      return codexHarnessFault(
        "CODEX_HARNESS_EXIT_NONZERO",
        "The pinned Codex CLI version probe did not complete successfully.",
        502,
        false,
      );
    }

    const run = await runBoundedHarness({
      executable: codexExecutable,
      cwd: worktree,
      prompt,
      timeLimitMs: options.timeLimitMs ?? CODEX_HARNESS_DEFAULT_TIME_LIMIT_MS,
      signal,
      output,
      groupKillExecutable: options.groupKillExecutable,
      environment: childEnvironment,
      args: [
        "exec",
        "--cd",
        worktree,
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        // Constrain workspace-write to the prepared worktree only: no extra
        // writable roots, no inherited TMPDIR, no hard-coded /tmp. Codex writes
        // its own session state under HOME outside this sandbox; that is the
        // pinned CLI's own boundary and must not be widened for the model.
        "-c",
        "sandbox_workspace_write.writable_roots=[]",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c",
        "sandbox_workspace_write.exclude_slash_tmp=true",
        "--color",
        "never",
        "-",
      ],
    });
    if (signal.aborted) return harnessCanceledOutcome(run.teardown);
    if (run.timedOut) {
      if (
        run.teardown !== "not-needed" && run.teardown.status === "unconfirmed"
      ) {
        return harnessTeardownFault("CODEX", run.teardown);
      }
      return codexHarnessFault(
        "CODEX_HARNESS_TIMEOUT",
        "The pinned Codex batch run exceeded its explicit time limit and was stopped.",
        504,
        true,
      );
    }
    if (run.code !== 0) {
      return codexHarnessFault(
        "CODEX_HARNESS_EXIT_NONZERO",
        `codex exec exited with code ${run.code}.`,
        502,
        false,
      );
    }

    // The child may have refreshed its token mid-run: scan for that too.
    let refreshedSecrets: readonly string[];
    try {
      refreshedSecrets = await harnessCredentialSecrets(
        join(dirs.codexHome, CODEX_AUTH_FILE),
      );
    } catch {
      return harnessCredentialUnavailable(
        "CODEX",
        "Codex",
        "The Codex harness could not complete the bounded task",
      );
    }
    const publication = await publishHarnessPatch({
      assignment,
      repository: worktree,
      baseSha,
      signal,
      publish: options.publishFor(assignment),
      commitMessage,
      commitUserEmail: "bakery-harness@bakery.local",
      commitUserName: "Bakery Codex Harness",
      artifactName: `codex-patch-${assignment.jobId}-${assignment.fence}.diff`,
      source: "codex-harness",
      commitFailureCode: "CODEX_HARNESS_COMMIT_FAILED",
      digestMismatchCode: "CODEX_HARNESS_ARTIFACT_DIGEST_MISMATCH",
      gitFailurePrefix: "CODEX_HARNESS",
      secrets: [
        assignment.leaseToken,
        ...(options.redactionSecrets ?? []),
        ...credentialSecrets,
        ...refreshedSecrets,
      ],
      faultTitle: "The Codex harness could not complete the bounded task",
    });
    if ("status" in publication) return publication;

    return {
      status: "completed",
      result: {
        baseSha,
        headSha: publication.headSha,
        sessionId: assignment.agentSessionId!,
        codexVersion,
        artifacts: publication.artifacts,
      },
    };
  } finally {
    await Deno.remove(dirs.root, { recursive: true }).catch(() => undefined);
  }
}

/**
 * Opt-in real harness executor. `harness.implement` runs the pinned
 * `codex exec` batch interface; every other action delegates to the wrapped
 * executor (the deterministic/native default). Production defaults stay on
 * the deterministic executor; this adapter activates only through explicit
 * configuration.
 */
export function createCodexHarnessExecutor(
  options: CodexHarnessOptions,
): WorkerExecutor {
  const inner = options.inner;
  // A single fixed repository cannot run two assignments concurrently: while
  // one bounded run stages and commits, another run's `add -A` would sweep
  // the first run's edits into its own commit. Overlapping claims are
  // rejected with a retryable fault, mirroring the spool/capacity codes.
  const harnessBusy = createHarnessBusyLatch();
  const guard = harnessWorktreeGuard(options);
  return {
    supportedActions: [
      ...new Set([
        ...(inner?.supportedActions ?? CODEX_HARNESS_SUPPORTED_ACTIONS),
        HARNESS_REPAIR_ACTION,
      ]),
    ],
    capturesNativeOutput: inner?.capturesNativeOutput ?? true,
    async initialize() {
      await inner?.initialize?.();
      await initializeHarnessWorktree(guard, harnessBusy);
    },
    async credentialRedactionSecrets(assignment) {
      if (!isHarnessEditAction(assignment.action)) {
        return await inner?.credentialRedactionSecrets?.(assignment) ?? [];
      }
      return await harnessCredentialSecrets(
        join(options.authSourceDir, CODEX_AUTH_FILE),
      );
    },
    readinessChecks: guard
      ? async () =>
        await harnessReadinessChecks(
          await inner?.readinessChecks?.() ?? [],
          guard,
          harnessBusy,
        )
      : inner?.readinessChecks?.bind(inner),
    execute(assignment, signal, output, preparedSkills) {
      if (!isHarnessEditAction(assignment.action)) {
        if (!inner) {
          return Promise.resolve(
            codexHarnessFault(
              "CODEX_HARNESS_ACTION_UNSUPPORTED",
              `The Codex harness supports only ${CODEX_ACTION} and ${HARNESS_REPAIR_ACTION}.`,
              500,
              false,
            ),
          );
        }
        return inner.execute(assignment, signal, output, preparedSkills);
      }
      // Wait for an in-flight readiness pass instead of failing as busy.
      return harnessBusy.settled().then(() => {
        if (!harnessBusy.acquire()) {
          return Promise.resolve(
            codexHarnessFault(
              "CODEX_HARNESS_BUSY",
              "The Codex harness is already running one bounded assignment against this repository; retry later.",
              503,
              true,
            ),
          );
        }
        return withHarnessRestore(
          (restore) =>
            executeCodexHarness(assignment, signal, output, options, restore),
          guard?.stateDir,
        ).finally(harnessBusy.release);
      });
    },
  };
}
