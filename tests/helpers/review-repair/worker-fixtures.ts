import { join } from "node:path";
import { effectivePolicyDigest } from "../../../packages/contracts/src/check-evidence.ts";
import {
  pinRepositoryRules,
  RepositoryRuleOverridesSchema,
  resolveRepositoryRules,
} from "../../../packages/contracts/src/repository-rules.ts";
import {
  createReviewerExecutor,
  type ReviewerExecutorOptions,
} from "../../../apps/worker/src/reviewer.ts";
import type { WorkerExecutor } from "../../../apps/worker/src/executor.ts";
import type { JobAssignment } from "../../../apps/worker/src/types.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../../apps/server/src/platform/canonical-json.ts";
import { SYNTHETIC_CLAUDE_CREDENTIALS } from "../harness-auth.ts";
import { gitText, prepareScratchRepository } from "../harness.ts";
import { localAssignment } from "../worker-execution/recovery-support.ts";
import { unlockTree } from "../deterministic-checks/runner-fixture.ts";

/**
 * Real-process fixtures for the worker side of independent review and bounded
 * repair (issue #94): a scratch repository with a base and a candidate commit,
 * a v2 repository profile that carries a fixed policy and allows the review
 * and repair effects, fake `claude` executables, and assignment builders. No
 * live Claude, Codex or Pi credential is involved anywhere.
 */

export const REVIEW_SESSION_ID = "00000000-0000-4000-8000-0000000000a1";

/** Every effect a review-and-repair profile allows (the profile cap is five). */
export const REVIEW_REPAIR_EFFECTS = Object.freeze(
  [
    "artifact_only",
    "repository_revision",
    "evidence_only",
    "review_evidence",
  ] as const,
);

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

export type ReviewProfile = {
  readonly context: Record<string, unknown>;
  readonly baseSha: string;
  readonly policyDigest: string;
  readonly commands: readonly { id: string; argv: readonly string[] }[];
};

/** A v2 profile with a fixed policy the review and repair actions may run under. */
export async function reviewProfile(options: {
  readonly baseSha: string;
  readonly commands?: readonly { id: string; argv: readonly string[] }[];
  readonly allowedEffects?: readonly string[];
  readonly rules?: readonly Record<string, unknown>[];
}): Promise<ReviewProfile> {
  const commands = options.commands ?? [
    { id: "unit", argv: ["sh", "-c", "exit 0"] },
    { id: "lint", argv: ["deno", "lint", "--quiet"] },
  ];
  const trustedCheckerConfigDigest = await sha256Hex(
    canonicalJson(checkPolicy),
  );
  const fixedPolicy = {
    schemaVersion: 1 as const,
    commands: commands.map(({ id, argv }) => ({ id, argv: [...argv] })),
    allowedEffects: [...(options.allowedEffects ?? REVIEW_REPAIR_EFFECTS)],
    lockedConfiguration: { branches: true, worktree: true, checker: true },
    decisions: commands.map(({ id }) => ({ commandId: id, mode: "require" })),
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
  return {
    context: {
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
    },
    baseSha: options.baseSha,
    commands,
    policyDigest: await effectivePolicyDigest({
      fixedPolicyDigest,
      trustedCheckerConfigDigest,
      entries: pinned.entries,
    }),
  };
}

/** A legacy v1 profile: no fixed policy, so a review has nothing to be judged against. */
export async function legacyProfile(): Promise<Record<string, unknown>> {
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

export type CandidateRepository = {
  readonly dir: string;
  /** The profile's pinned base commit. */
  readonly baseSha: string;
  /** The candidate commit: base plus one source file and an edited notes file. */
  readonly revision: string;
  /** Directory outside the repository for fakes, markers and credentials. */
  readonly aux: string;
};

/**
 * Extra work on the candidate's working tree before it is committed, such as
 * symlinks. `aux` is the directory outside the repository that fakes, markers
 * and out-of-tree targets live in.
 */
export type CandidatePrepare = (
  context: { readonly dir: string; readonly aux: string },
) => Promise<void>;

/** A scratch repository whose HEAD is a candidate commit one change past the base. */
export async function candidateRepository(
  files: Readonly<Record<string, string>> = {
    "src/feature.ts": "export const feature = () => 42;\n",
  },
  prepare?: CandidatePrepare,
): Promise<CandidateRepository> {
  const scratch = await prepareScratchRepository("bakery-review-repo-");
  const aux = await Deno.makeTempDir({ prefix: "bakery-review-aux-" });
  for (const [path, content] of Object.entries(files)) {
    const target = join(scratch.dir, path);
    await Deno.mkdir(join(target, ".."), { recursive: true });
    await Deno.writeTextFile(target, content);
  }
  await Deno.writeTextFile(scratch.notesPath, "edited by the candidate\n");
  await prepare?.({ dir: scratch.dir, aux });
  await gitText(scratch.dir, ["add", "-A"]);
  await gitText(scratch.dir, ["commit", "-m", "candidate"]);
  return {
    dir: scratch.dir,
    baseSha: scratch.baseSha,
    revision: await gitText(scratch.dir, ["rev-parse", "HEAD"]),
    aux,
  };
}

/** Credential directory holding a synthetic `.credentials.json`. */
export async function credentialDirectory(aux: string): Promise<string> {
  const dir = join(aux, "auth-source");
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    join(dir, ".credentials.json"),
    SYNTHETIC_CLAUDE_CREDENTIALS,
  );
  return dir;
}

/** The `review.independent` assignment a Claude reviewer host would claim. */
export function reviewAssignment(
  repository: CandidateRepository,
  profile: ReviewProfile | Record<string, unknown>,
  overrides: Partial<JobAssignment> = {},
  input: Record<string, unknown> = {},
): JobAssignment {
  const context = "context" in profile ? profile.context : profile;
  return {
    ...localAssignment(),
    action: "review.independent",
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId: crypto.randomUUID(),
      revision: repository.revision,
      evidence: [crypto.randomUUID(), crypto.randomUUID()],
      repositoryProfile: context,
      ...input,
    },
    ...overrides,
  } as JobAssignment;
}

/** The `harness.repair` assignment a coding host would claim. */
export function repairAssignment(
  profile: ReviewProfile | Record<string, unknown>,
  input: Record<string, unknown>,
  overrides: Partial<JobAssignment> = {},
): JobAssignment {
  const context = "context" in profile ? profile.context : profile;
  return {
    ...localAssignment(),
    action: "harness.repair",
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId: crypto.randomUUID(),
      ...input,
      repositoryProfile: context,
    },
    ...overrides,
  } as JobAssignment;
}

/** What a fake `claude` recorded about its one invocation. */
export type FakeClaude = {
  readonly executable: string;
  readonly argsPath: string;
  readonly promptPath: string;
  readonly cwdPath: string;
  readonly headPath: string;
  readonly homePath: string;
  readonly configPath: string;
  readonly configListPath: string;
  /** Symlinks found in the working directory when the CLI started. */
  readonly linksPath: string;
  readonly pidPath: string;
  readonly ranPath: string;
};

export function initLine(): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: REVIEW_SESSION_ID,
    claude_code_version: "2.1.296",
    model: "claude-opus-5-5",
    tools: ["Read", "Glob", "Grep"],
  });
}

export function resultLine(extra: Record<string, unknown>): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: REVIEW_SESSION_ID,
    total_cost_usd: 0.5,
    ...extra,
  });
}

/**
 * Fake `claude`: answers `--version`, records its argv, stdin, working
 * directory, the HEAD of that directory, HOME and pid beside itself (never in
 * the worktree), optionally runs `middle` (a shell snippet that may write under
 * `"$AUX"`, the directory the records live in), then replays a stream.
 */
export async function fakeClaude(
  aux: string,
  stream: readonly string[],
  options: { middle?: string; exitCode?: number } = {},
): Promise<FakeClaude> {
  const files = {
    argsPath: join(aux, "args.txt"),
    promptPath: join(aux, "prompt.txt"),
    cwdPath: join(aux, "cwd.txt"),
    headPath: join(aux, "head.txt"),
    homePath: join(aux, "home.txt"),
    configPath: join(aux, "config.txt"),
    configListPath: join(aux, "config-list.txt"),
    linksPath: join(aux, "links.txt"),
    pidPath: join(aux, "pid.txt"),
    ranPath: join(aux, "ran"),
  };
  await Deno.writeTextFile(join(aux, "stream.jsonl"), stream.join("\n") + "\n");
  const executable = join(aux, "fake-claude");
  await Deno.writeTextFile(
    executable,
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo '2.1.0 (Claude Code)'; exit 0; fi
AUX='${aux}'
touch '${files.ranPath}'
printf '%s\\n' "$@" > '${files.argsPath}'
cat > '${files.promptPath}'
pwd > '${files.cwdPath}'
git rev-parse HEAD > '${files.headPath}'
printf '%s\\n' "$HOME" > '${files.homePath}'
printf '%s\\n' "$CLAUDE_CONFIG_DIR" > '${files.configPath}'
ls -A "$CLAUDE_CONFIG_DIR" > '${files.configListPath}'
find . -type l | sort > '${files.linksPath}'
printf '%s\\n' "$$" > '${files.pidPath}'
${options.middle ?? ""}
cat '${join(aux, "stream.jsonl")}'
exit ${options.exitCode ?? 0}
`,
  );
  await Deno.chmod(executable, 0o755);
  return { executable, ...files };
}

/** Wrapped executor that records the actions it was asked to run. */
export function recordingInner(
  supportedActions: readonly string[] = ["harness.implement"],
): WorkerExecutor & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    supportedActions,
    capturesNativeOutput: true,
    execute(assignment) {
      calls.push(assignment.action);
      return Promise.resolve({
        status: "completed" as const,
        result: { inner: true },
      });
    },
  };
}

export type ReviewerRig = {
  readonly repository: CandidateRepository;
  readonly profile: ReviewProfile;
  readonly stateDir: string;
  readonly registrationPath: string;
  readonly spoolPath: string;
  readonly authDir: string;
};

/** A candidate repository, a profile, a worker state directory and credentials. */
export async function reviewerRig(
  files?: Readonly<Record<string, string>>,
  prepare?: CandidatePrepare,
  baseSha?: string,
): Promise<ReviewerRig> {
  const repository = await candidateRepository(files, prepare);
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-review-state-" });
  await Deno.chmod(stateDir, 0o700);
  const registrationPath = join(stateDir, "registration.json");
  const spoolPath = join(stateDir, "spool.json");
  await Deno.writeTextFile(registrationPath, "{}", { mode: 0o600 });
  await Deno.writeTextFile(spoolPath, "{}", { mode: 0o600 });
  return {
    repository,
    profile: await reviewProfile({ baseSha: baseSha ?? repository.baseSha }),
    stateDir,
    registrationPath,
    spoolPath,
    authDir: await credentialDirectory(repository.aux),
  };
}

/** The reviewer executor over a rig, with a recording inner executor. */
export function reviewerOver(
  rig: ReviewerRig,
  executable: string,
  overrides: Partial<ReviewerExecutorOptions> = {},
): WorkerExecutor & { readonly inner: ReturnType<typeof recordingInner> } {
  const inner = recordingInner();
  const executor = createReviewerExecutor({
    inner,
    repository: rig.repository.dir,
    stateDir: rig.stateDir,
    credentialPaths: [rig.registrationPath, rig.spoolPath],
    claude: {
      authSourceDir: rig.authDir,
      claudeExecutable: executable,
      model: "claude-opus-5-5",
      timeLimitMs: 10_000,
    },
    ...overrides,
  });
  return Object.assign(executor, { inner });
}

/** Entries left under the state directory's `reviews` directory. */
export async function leftoverReviews(stateDir: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(stateDir, "reviews"))) {
      if (entry.name !== "probe") entries.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return entries;
}

/** Removes the temporary directories of a candidate repository. */
export async function disposeRepository(
  repository: CandidateRepository,
): Promise<void> {
  for (const path of [repository.dir, repository.aux]) {
    await unlockTree(path).catch(() => undefined);
    await Deno.remove(path, { recursive: true }).catch(() => undefined);
  }
}

/** Removes the temporary directories of a rig. */
export async function disposeRig(rig: ReviewerRig): Promise<void> {
  for (const path of [rig.stateDir, rig.repository.dir, rig.repository.aux]) {
    await unlockTree(path).catch(() => undefined);
    await Deno.remove(path, { recursive: true }).catch(() => undefined);
  }
}

/** The completed result of an outcome, or a thrown assertion with the outcome. */
export function completed(
  outcome: { status: string },
): Record<string, unknown> {
  if (outcome.status !== "completed") {
    throw new Error(`NOT_COMPLETED:${JSON.stringify(outcome)}`);
  }
  return (outcome as unknown as { result: Record<string, unknown> }).result;
}

/** The fault of a failed outcome, or a thrown assertion with the outcome. */
export function faultOf(outcome: { status: string }): Record<string, unknown> {
  if (outcome.status !== "failed") {
    throw new Error(`NOT_FAILED:${JSON.stringify(outcome)}`);
  }
  return (outcome as unknown as { fault: Record<string, unknown> }).fault;
}
