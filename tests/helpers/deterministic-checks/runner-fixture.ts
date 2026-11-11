import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { effectivePolicyDigest } from "../../../packages/contracts/src/check-evidence.ts";
import {
  type PinnedRepositoryRules,
  pinRepositoryRules,
  RepositoryRuleOverridesSchema,
  resolveRepositoryRules,
} from "../../../packages/contracts/src/repository-rules.ts";
import {
  type CheckExecutorOptions,
  createCheckExecutor,
} from "../../../apps/worker/src/check-runner.ts";
import {
  createDeterministicExecutor,
  type ExecutionOutcome,
  type WorkerExecutor,
} from "../../../apps/worker/src/executor.ts";
import type { NativeOutputSink } from "../../../apps/worker/src/native-output.ts";
import type { PublishArtifact } from "../../../apps/worker/src/task-brief.ts";
import type { JobAssignment } from "../../../apps/worker/src/types.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import { gitText, prepareScratchRepository } from "../harness.ts";
import { localAssignment } from "../worker-execution/recovery-support.ts";

/**
 * Real-process fixtures for the worker `quality.check` executor: a scratch git
 * repository with a committed candidate, a v2 repository profile that carries a
 * fixed policy and pinned rules, and an artifact publisher that records every
 * upload. Nothing here is faked below the executor.
 */

export type FixtureCommand = {
  readonly id: string;
  readonly argv: readonly string[];
  readonly mode?: "guide" | "warn" | "require";
};

export type FixtureRule = Record<string, unknown>;

/** Everything the executor needs to see in `input.repositoryProfile`. */
export type FixtureProfile = {
  readonly context: Record<string, unknown>;
  readonly baseSha: string;
  readonly fixedPolicyDigest: string;
  readonly trustedCheckerConfigDigest: string;
  readonly pinned: PinnedRepositoryRules;
  readonly policyDigest: string;
  /** The effective fixed policy the context carries. */
  readonly fixedPolicy: unknown;
};

const checkPolicy = {
  schemaVersion: 1 as const,
  platform: "linux" as const,
  tools: [{ tool: "git" as const, required: true }],
  checks: [{
    id: "source.integrity",
    template: "source.integrity.v1" as const,
    tool: null,
    paths: [],
    required: true,
  }],
};

/** A repository override entry binding `ruleKey` to a fixed command id. */
export function boundRule(
  ruleKey: "code.magicNumbers" | "code.magicStrings",
  checkBinding: string | null,
  overrides: FixtureRule = {},
): FixtureRule {
  return {
    ruleKey,
    enabled: true,
    mode: "require",
    options: ruleKey === "code.magicNumbers"
      ? {
        checkBinding,
        allowedNumbers: [0, 1],
        excludedPaths: ["**/*.test.ts"],
      }
      : { checkBinding, allowedLiterals: ["utf-8"], excludedPaths: [] },
    ...overrides,
  };
}

/** Builds a v2 profile context with a fixed policy, digests and pinned rules. */
export async function fixtureProfile(
  commands: readonly FixtureCommand[],
  options: { baseSha: string; rules?: readonly FixtureRule[] },
): Promise<FixtureProfile> {
  const draft = {
    schemaVersion: 1 as const,
    commands: commands.map(({ id, argv }) => ({ id, argv: [...argv] })),
    allowedEffects: ["evidence_only"] as const,
    lockedConfiguration: { branches: true, worktree: true, checker: true },
    decisions: commands.map(({ id, mode }) => ({
      commandId: id,
      mode: mode ?? "require",
    })),
  };
  const trustedCheckerConfigDigest = await sha256Hex(
    canonicalJson(checkPolicy),
  );
  const fixedPolicy = {
    ...draft,
    trustedChecker: {
      kind: "repository-inspection" as const,
      configDigest: trustedCheckerConfigDigest,
    },
  };
  const config = {
    schemaVersion: 2 as const,
    workflow: { kind: "fixed" as const },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
    checkPolicy,
    fixedPolicy,
  };
  const id = crypto.randomUUID();
  const revision = 2;
  const resolved = await resolveRepositoryRules(
    null,
    RepositoryRuleOverridesSchema.parse({ entries: options.rules ?? [] }),
  );
  const pinned = pinRepositoryRules(resolved, { id, revision });
  const fixedPolicyDigest = await sha256Hex(canonicalJson(fixedPolicy));
  const context = {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    id,
    revision,
    digest: await sha256Hex(canonicalJson(config)),
    config,
    observationId: crypto.randomUUID(),
    observationDigest: "a".repeat(64),
    baseSha: options.baseSha,
    fixedPolicyDigest,
    trustedCheckerConfigDigest,
    repositoryRules: pinned,
  };
  return {
    context,
    baseSha: options.baseSha,
    fixedPolicyDigest,
    trustedCheckerConfigDigest,
    pinned,
    fixedPolicy,
    policyDigest: await effectivePolicyDigest({
      fixedPolicyDigest,
      trustedCheckerConfigDigest,
      entries: pinned.entries,
    }),
  };
}

/** A profile that is not fixed-policy governed, to prove the fail-closed path. */
export async function legacyProfileContext(): Promise<Record<string, unknown>> {
  const config = {
    schemaVersion: 1 as const,
    workflow: { kind: "fixed" as const },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  return {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    revision: 1,
    digest: await sha256Hex(canonicalJson(config)),
    config,
    observationId: null,
    observationDigest: null,
    baseSha: null,
  };
}

/** The `quality.check` assignment a worker would claim. */
export function checkAssignment(
  input: { revision: string; checks: readonly string[]; profile?: unknown },
): JobAssignment {
  return {
    ...localAssignment(),
    action: "quality.check",
    input: {
      repositoryId: crypto.randomUUID(),
      revision: input.revision,
      checks: [...input.checks],
      ...(input.profile === undefined
        ? {}
        : { repositoryProfile: input.profile }),
    },
  } as JobAssignment;
}

/** SHA-256 of raw bytes, computed independently of the executor under test. */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type RecordedPublication = {
  readonly request: Parameters<PublishArtifact>[0];
  readonly ref: { artifactId: string; versionId: string; sha256: string };
};

/** Publisher that records every upload and returns an honest reference. */
export function recordingPublisher(): {
  readonly publications: RecordedPublication[];
  readonly publishFor: CheckExecutorOptions["publishFor"];
} {
  const publications: RecordedPublication[] = [];
  return {
    publications,
    publishFor: () => async (request) => {
      const ref = {
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: await sha256OfBytes(request.bytes),
      };
      publications.push({ request, ref });
      return ref;
    },
  };
}

export type CommittedScratch = {
  readonly dir: string;
  readonly baseSha: string;
  readonly revision: string;
  /** Absolute path the tests use for markers the commands must not write. */
  readonly markers: string;
};

/**
 * A scratch repository whose HEAD commit adds `files` (path -> content, an
 * `#!` first line makes the file executable). `markers` is a directory outside
 * the repository, for proofs that a command did or did not run.
 */
export async function committedScratch(
  files: Readonly<Record<string, string>> = {},
  markers?: string,
): Promise<CommittedScratch> {
  const scratch = await prepareScratchRepository("bakery-check-runner-");
  for (const [path, content] of Object.entries(files)) {
    const target = join(scratch.dir, path);
    await Deno.mkdir(join(target, ".."), { recursive: true });
    await Deno.writeTextFile(target, content, {
      mode: content.startsWith("#!") ? 0o755 : 0o644,
    });
  }
  await gitText(scratch.dir, ["add", "-A"]);
  await gitText(scratch.dir, ["commit", "-m", "candidate", "--allow-empty"]);
  return {
    dir: scratch.dir,
    baseSha: scratch.baseSha,
    revision: await gitText(scratch.dir, ["rev-parse", "HEAD"]),
    markers: markers ??
      await Deno.makeTempDir({ prefix: "bakery-check-markers-" }),
  };
}

/** A fresh worker state directory holding stand-in credential files. */
export async function stateWithCredentials(): Promise<{
  readonly stateDir: string;
  readonly registrationPath: string;
  readonly spoolPath: string;
}> {
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-check-state-" });
  await Deno.chmod(stateDir, 0o700);
  const registrationPath = join(stateDir, "registration.json");
  const spoolPath = join(stateDir, "spool.json");
  await Deno.writeTextFile(registrationPath, "{}", { mode: 0o600 });
  await Deno.writeTextFile(spoolPath, "{}", { mode: 0o600 });
  return { stateDir, registrationPath, spoolPath };
}

export type FixtureRun = {
  readonly outcome: ExecutionOutcome;
  readonly publications: RecordedPublication[];
  readonly stateDir: string;
  readonly scratch: CommittedScratch;
  readonly registrationPath: string;
  readonly spoolPath: string;
};

/** The completed `CheckOutput`, or a thrown assertion with the outcome. */
export function completedResult(outcome: ExecutionOutcome): {
  allRequired: boolean;
  checkRunIds: string[];
  failedCheckIds: string[];
  observations: Array<{
    checkRunId: string;
    checkId: string;
    kind: string;
    ruleKey: string | null;
    result: string;
    reason: string;
    exitCode: number | null;
    durationMs: number;
    outputDigest: string | null;
    evidence: { artifactId: string; versionId: string; sha256: string } | null;
  }>;
  headSha: string;
  baseSha: string;
  policyDigest: string;
} {
  if (outcome.status !== "completed") {
    throw new Error(`NOT_COMPLETED:${JSON.stringify(outcome)}`);
  }
  return outcome.result as ReturnType<typeof completedResult>;
}

export function faultCode(outcome: ExecutionOutcome): string {
  if (outcome.status !== "failed") {
    throw new Error(`NOT_FAILED:${JSON.stringify(outcome)}`);
  }
  return (outcome.fault as { code: string }).code;
}

export type RunOptions = {
  readonly scratch: CommittedScratch;
  readonly commands: readonly FixtureCommand[];
  readonly rules?: readonly FixtureRule[];
  readonly checks?: readonly string[];
  readonly revision?: string;
  readonly profile?: unknown;
  readonly signal?: AbortSignal;
  readonly commandTimeLimitMs?: number;
  readonly limits?: CheckExecutorOptions["limits"];
  readonly groupKillExecutable?: string;
  readonly redactionSecrets?: readonly string[];
  readonly credentialPaths?: (state: {
    stateDir: string;
    registrationPath: string;
    spoolPath: string;
  }) => readonly string[];
  readonly inner?: WorkerExecutor;
  readonly output?: NativeOutputSink;
  readonly assignment?: (assignment: JobAssignment) => JobAssignment;
  readonly state?: Awaited<ReturnType<typeof stateWithCredentials>>;
};

/** Executes one `quality.check` against the scratch repository. */
export async function runCheckExecutor(options: RunOptions): Promise<
  FixtureRun & { profile: FixtureProfile; assignment: JobAssignment }
> {
  const state = options.state ?? await stateWithCredentials();
  const recorder = recordingPublisher();
  const profile = await fixtureProfile(options.commands, {
    baseSha: options.scratch.baseSha,
    rules: options.rules,
  });
  const executor = createCheckExecutor(
    options.inner ?? createDeterministicExecutor(),
    {
      repository: options.scratch.dir,
      stateDir: state.stateDir,
      publishFor: recorder.publishFor,
      commandTimeLimitMs: options.commandTimeLimitMs ?? 20_000,
      redactionSecrets: options.redactionSecrets,
      credentialPaths: options.credentialPaths?.(state) ??
        [state.registrationPath, state.spoolPath],
      limits: options.limits,
      groupKillExecutable: options.groupKillExecutable,
    },
  );
  const base = checkAssignment({
    revision: options.revision ?? options.scratch.revision,
    checks: options.checks ?? options.commands.map(({ id }) => id),
    profile: options.profile === undefined ? profile.context : options.profile,
  });
  const assignment = options.assignment ? options.assignment(base) : base;
  const outcome = await executor.execute(
    assignment,
    options.signal ?? new AbortController().signal,
    options.output,
  );
  return {
    outcome,
    publications: recorder.publications,
    stateDir: state.stateDir,
    scratch: options.scratch,
    registrationPath: state.registrationPath,
    spoolPath: state.spoolPath,
    profile,
    assignment,
  };
}

/** Worktree records git still holds for the repository, besides the main one. */
export async function extraWorktrees(dir: string): Promise<string[]> {
  const listing = await gitText(dir, ["worktree", "list", "--porcelain"]);
  return listing.split("\n").filter((line) => line.startsWith("worktree "))
    .slice(1);
}

/** True when the path exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** True while the process exists (`kill -0`, which needs no /proc access). */
export async function processAlive(pid: string): Promise<boolean> {
  const result = await new Deno.Command("/usr/bin/kill", {
    args: ["-0", pid],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  return result.success;
}

/** Waits briefly for a killed process to be reaped, then reports if it lives. */
export async function survives(
  pid: string,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await processAlive(pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await processAlive(pid);
}

/** Entries left in the state directory's `checks` subdirectory. */
export async function leftoverAttempts(stateDir: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(stateDir, "checks"))) {
      entries.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return entries;
}

/**
 * Gives the owner full access to every directory under `path`, without
 * following symlinks, so a tree a command locked can be deleted. Test cleanup
 * only: it never runs the production cleanup under test.
 */
export async function unlockTree(path: string): Promise<void> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  if (!stat.isDirectory) return;
  await Deno.chmod(path, 0o700);
  for await (const entry of Deno.readDir(path)) {
    if (entry.isDirectory) await unlockTree(join(path, entry.name));
  }
}

const SANITIZERS = { sanitizeResources: false, sanitizeOps: false } as const;

/** Registers a case that spawns real processes, so resources outlive the test body. */
export function runnerTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ...SANITIZERS, fn });
}

/** Argv that runs `script` under `sh -c`. */
export const sh = (script: string) => ["sh", "-c", script];

/** Polls until `predicate` holds or `timeoutMs` passes. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`TIMED_OUT_WAITING_FOR:${what}`);
}

/** The worktree and attempt root must be gone, as must git's record of them. */
export async function assertCleanedUp(
  run: { stateDir: string; scratch: { dir: string } },
): Promise<void> {
  assertEquals(await leftoverAttempts(run.stateDir), [], "attempt root left");
  assertEquals(
    await extraWorktrees(run.scratch.dir),
    [],
    "worktree record left",
  );
}

/** Removes the temporary directories a run created. */
export async function disposeRun(
  run: Pick<FixtureRun, "stateDir" | "scratch">,
): Promise<void> {
  for (
    const path of [run.stateDir, run.scratch.dir, run.scratch.markers]
  ) {
    await unlockTree(path).catch(() => undefined);
    await Deno.remove(path, { recursive: true }).catch(() => undefined);
  }
}

/** The stdout the evidence artifact of a check captured, parsed from the upload. */
export function evidenceOf(
  publications: readonly RecordedPublication[],
  checkId: string,
): {
  stdout: string;
  stderr: string;
  result: string;
  reason: string;
  exitCode: number | null;
  signal: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  headSha: string;
  baseSha: string;
} {
  const found = publications.find(({ request }) =>
    request.metadata?.checkId === checkId
  );
  if (!found) throw new Error(`NO_EVIDENCE:${checkId}`);
  return JSON.parse(new TextDecoder().decode(found.request.bytes));
}
