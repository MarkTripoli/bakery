import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { GIT_EXECUTABLE } from "./git-executable.ts";
import type {
  JobAssignment,
  JsonValue,
  PreparedSkillContext,
  PreparedSkillRoot,
  UsageReceipt,
  WorkerExecutionIdentity,
  WorkerInventoryCheck,
} from "./types.ts";
import {
  ensurePrivateDirectory,
  readJsonIfExists,
  writeJsonAtomically,
} from "./storage.ts";
import { REPOSITORY_INSPECTION_LIMITS as INSPECTION_LIMITS } from "../../../packages/config/src/env.ts";
import { CHECK_REVISION_PATTERN } from "../../../packages/contracts/src/check-evidence.ts";
import {
  RepositoryExecutionContextSchema,
  RepositoryInspectionReportSchema,
} from "../../../packages/contracts/src/repository-inspection.ts";
import { REPOSITORY_FIXED_POLICY_ACTION_EFFECTS } from "../../../packages/contracts/src/repository-profile-config.ts";
import { verifyPinnedRepositoryRules } from "../../../packages/contracts/src/repository-rules.ts";
import { REPOSITORY_INSPECTION_CHILD } from "./repository-inspection-child.ts";
import {
  inspectionCanonicalJson,
  type LoadedRepositoryInspection,
  removeRepositoryInspectionDirectory,
} from "./repository-inspection-source.ts";
import type { NativeOutputChannel, NativeOutputSink } from "./native-output.ts";
import {
  executeTaskBrief,
  type PublishArtifact,
  unconfirmedCanceledOutcome,
} from "./task-brief.ts";

export type ExecutionOutcome =
  | { status: "completed"; result: JsonValue; usage?: UsageReceipt }
  | { status: "failed"; fault: JsonValue; usage?: UsageReceipt }
  | { status: "canceled"; cancellation: JsonValue; usage?: UsageReceipt };

export type WorkerExecutor = {
  readonly supportedActions?: readonly string[];
  readonly capturesNativeOutput?: boolean;
  initialize?(): Promise<void>;
  /**
   * Current local readiness checks (for example `capability:<capability>`).
   * The supervisor reports them to the server and will not claim work whose
   * capability check is failing. Must not throw for ordinary host faults.
   */
  readinessChecks?(): Promise<WorkerInventoryCheck[]>;
  /** Delivers an in-flight adapter control when the selected harness supports it. */
  control?(
    assignment: JobAssignment,
    action: "steer_message" | "follow_up_message",
    messageId: string,
    body: string,
  ): Promise<"accepted" | "unsupported" | "rejected">;
  /**
   * Per-attempt credential values the output capture and patch scan must
   * redact (for example the OAuth tokens a harness child can read). The
   * result is never logged. A throw fails the attempt closed, before spawn.
   */
  credentialRedactionSecrets?(
    assignment: JobAssignment,
  ): Promise<readonly string[]>;
  execute(
    assignment: JobAssignment,
    signal: AbortSignal,
    output?: NativeOutputSink,
    preparedSkills?: PreparedSkillContext,
  ): Promise<ExecutionOutcome>;
};

export class DeterministicExecutorError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "DeterministicExecutorError";
  }
}

const NATIVE_DIAGNOSTIC_MAX_LENGTH = 400;

/** Single-line, printable, length-capped text safe to log for host triage. */
export function boundedNativeDiagnostic(
  value: Uint8Array | string,
): string {
  const text = typeof value === "string"
    ? value
    : new TextDecoder().decode(value.subarray(0, 4096));
  const flat = text.replace(/[^\x20-\x7e]+/g, " ").trim();
  return flat.length > NATIVE_DIAGNOSTIC_MAX_LENGTH
    ? `${flat.slice(0, NATIVE_DIAGNOSTIC_MAX_LENGTH)}...`
    : flat;
}

export class NativeExecutorError extends Error {
  readonly boundaryFailure: boolean;
  /** Bounded host detail (tool stderr, failing path); never part of `message`. */
  readonly diagnostic: string | undefined;

  constructor(code: string, boundaryFailure = false, diagnostic?: string) {
    super(code);
    this.name = "NativeExecutorError";
    this.boundaryFailure = boundaryFailure;
    this.diagnostic = diagnostic === undefined || diagnostic === ""
      ? undefined
      : boundedNativeDiagnostic(diagnostic);
  }
}

async function canonicalDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(inspectionCanonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enforceWorkerFixedPolicy(
  assignment: JobAssignment,
): Promise<void> {
  if (
    assignment.input === null || typeof assignment.input !== "object" ||
    Array.isArray(assignment.input)
  ) return;
  const rawProfile = (assignment.input as Record<string, unknown>)
    .repositoryProfile;
  if (rawProfile === undefined) return;
  const profile = RepositoryExecutionContextSchema.safeParse(rawProfile);
  if (
    !profile.success ||
    await canonicalDigest(profile.data.config) !== profile.data.digest
  ) {
    throw new NativeExecutorError("FIXED_REPOSITORY_POLICY_REJECTED");
  }
  // The pinned rules travel with the profile; a digest that no longer matches
  // its entries means the frozen rules were altered after admission.
  if (
    profile.data.repositoryRules !== undefined &&
    !(await verifyPinnedRepositoryRules(profile.data.repositoryRules))
  ) {
    throw new NativeExecutorError("FIXED_REPOSITORY_POLICY_REJECTED");
  }
  if (profile.data.config.schemaVersion !== 2) {
    if (profile.data.config.fixedPolicy !== undefined) {
      throw new NativeExecutorError("FIXED_REPOSITORY_POLICY_REJECTED");
    }
    return;
  }
  const policy = profile.data.config.fixedPolicy;
  if (policy === undefined) return;
  if (
    profile.data.fixedPolicyDigest !== await canonicalDigest(policy) ||
    policy.trustedChecker.configDigest !==
      await canonicalDigest(profile.data.config.checkPolicy)
  ) {
    throw new NativeExecutorError("FIXED_REPOSITORY_POLICY_REJECTED");
  }
  const effect = REPOSITORY_FIXED_POLICY_ACTION_EFFECTS[
    assignment.action as keyof typeof REPOSITORY_FIXED_POLICY_ACTION_EFFECTS
  ];
  if (effect === undefined || !policy.allowedEffects.includes(effect)) {
    throw new NativeExecutorError("FIXED_REPOSITORY_POLICY_REJECTED");
  }
  if (assignment.action !== "quality.check") return;
  const checks = (assignment.input as Record<string, unknown>).checks;
  if (
    !Array.isArray(checks) || checks.some((check) => typeof check !== "string")
  ) {
    throw new NativeExecutorError("FIXED_REPOSITORY_POLICY_REJECTED");
  }
  const fixedCommands = new Set(policy.commands.map((command) => command.id));
  const admittedChecks = new Set(checks as string[]);
  const revision = (assignment.input as Record<string, unknown>).revision;
  if (
    (checks as string[]).some((commandId) => !fixedCommands.has(commandId)) ||
    policy.decisions.some((decision) =>
      decision.mode === "require" && !admittedChecks.has(decision.commandId)
    ) ||
    // Mirrors server admission: one exact commit and each command selected
    // once. The policy schema bounds the commands, so no count cap is needed.
    typeof revision !== "string" || !CHECK_REVISION_PATTERN.test(revision) ||
    admittedChecks.size !== (checks as string[]).length
  ) {
    throw new NativeExecutorError("FIXED_REPOSITORY_POLICY_REJECTED");
  }
}

export type NativeExecutorOptions = {
  /** A delegated, worker-exclusive cgroup v2 directory. */
  readonly cgroupRoot?: string;
  /** Durable worker state used for pre-execution boundary identities. */
  readonly stateDir?: string;
  /** Additional supervisor-owned credential/state paths excluded from mounts. */
  readonly supervisorSecretPaths?: readonly string[];
  readonly actions?: readonly NativeActionDefinition[];
  /**
   * Publishes an artifact for one assignment through the worker byte boundary.
   * When present the executor also runs `task.brief` in-process.
   */
  readonly publishArtifactFor?: (
    assignment: JobAssignment,
  ) => PublishArtifact;
  readonly terminationGraceMs?: number;
  readonly probeIntervalMs?: number;
  readonly loadInspectionSource?: (
    assignment: JobAssignment,
    signal: AbortSignal,
    directory: string,
  ) => Promise<LoadedRepositoryInspection>;
  /**
   * Test-only fault and crash-window injection. Production callers omit this.
   */
  readonly testHooks?: {
    readonly beforeCgroupWrite?: (
      operation: "attach" | "kill",
      path: string,
    ) => void | Promise<void>;
    readonly afterCgroupCreated?: (path: string) => void | Promise<void>;
    readonly afterCgroupRemoved?: (path: string) => void | Promise<void>;
    /** Observes the exact completed repository.inspect bytes before parsing. */
    readonly afterInspectionParserInput?: (
      bytes: Uint8Array,
    ) => void | Promise<void>;
    /** Test-only failure injection before the native namespace probe. */
    readonly beforeSandboxProbe?: () => void | Promise<void>;
  };
};

type NativePathIdentity = {
  readonly path: string;
  readonly identity: string;
  readonly directory: boolean;
};

type NativeRuntimeMount = NativePathIdentity & {
  /** Destination path required by the executable or action. */
  readonly target: string;
};

type NativeSecretRoot = {
  readonly path: string;
  readonly identity: string | null;
  readonly directory: boolean;
  readonly isStateDir: boolean;
};

type NativeRuntimeClosure = {
  readonly mounts: readonly NativeRuntimeMount[];
  readonly probeExecutable: string;
  readonly denoExecutable: string;
  readonly actions: readonly NativeActionDefinition[];
  readonly secretRoots: readonly NativeSecretRoot[];
};

type NativeTestHooks = NonNullable<NativeExecutorOptions["testHooks"]>;

function canceledOutcome(): ExecutionOutcome {
  return unconfirmedCanceledOutcome();
}

export const DETERMINISTIC_SUPPORTED_ACTIONS = ["harness.implement"] as const;

function deterministicFailure(assignment: JobAssignment): JsonValue {
  return {
    type: "about:blank",
    title: "Deterministic executor cannot produce action evidence",
    status: 501,
    detail:
      `No durable artifact, check run, session, or snapshot exists for ${assignment.action}.`,
    code: "DETERMINISTIC_EVIDENCE_UNAVAILABLE",
    requestId: crypto.randomUUID(),
    retryable: false,
  };
}

export function createDeterministicExecutor(): WorkerExecutor {
  return {
    supportedActions: DETERMINISTIC_SUPPORTED_ACTIONS,
    execute(
      assignment,
      signal,
      _output,
      preparedSkills,
    ): Promise<ExecutionOutcome> {
      if (
        assignment.skillRefs.length > 0 ||
        (preparedSkills?.roots.length ?? 0) > 0
      ) {
        throw new DeterministicExecutorError(
          "PREPARED_SKILL_ROOTS_UNSUPPORTED",
        );
      }
      if (signal.aborted) return Promise.resolve(canceledOutcome());
      if (
        !DETERMINISTIC_SUPPORTED_ACTIONS.includes(
          assignment.action as typeof DETERMINISTIC_SUPPORTED_ACTIONS[number],
        )
      ) {
        throw new DeterministicExecutorError(
          `WORKER_ACTION_UNSUPPORTED:${assignment.action}`,
        );
      }
      if (signal.aborted) return Promise.resolve(canceledOutcome());
      return Promise.resolve({
        status: "failed",
        fault: deterministicFailure(assignment),
      });
    },
  };
}

/**
 * Native actions are code-owned. Assignment data selects a definition by its
 * literal action name, but never contributes an executable, argument, cwd, or
 * environment value.
 */
export type NativeActionDefinition = {
  readonly action: string;
  readonly executable: string;
  readonly args: readonly string[];
  /**
   * Exact code-owned files or directories the action may read. Assignment
   * arguments never add mounts.
   */
  readonly readOnlyPaths?: readonly string[];
};

type NativeSandboxSpec = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly runtimePaths: readonly NativeRuntimeMount[];
  readonly readOnlyPaths: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly forwardStdin: boolean;
};

type NativeTiming = {
  readonly terminationGraceMs: number;
  readonly probeIntervalMs: number;
};

const NATIVE_SANDBOX_EXECUTABLE = "/usr/bin/bwrap";
const NATIVE_RUNTIME_DEPENDENCY_TOOL = "/usr/bin/ldd";
const NATIVE_RUNTIME_TOOL_EXECUTABLES = [
  "/bin/sh",
  GIT_EXECUTABLE,
  "/usr/bin/node",
  "/usr/bin/true",
] as const;
const NATIVE_SANDBOX_BASE_ARGS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--die-with-parent",
  "--new-session",
  "--symlink",
  "usr/bin",
  "/bin",
  "--symlink",
  "usr/lib",
  "/lib",
  "--symlink",
  "usr/lib64",
  "/lib64",
  // Symlink targets must exist: hosts whose /usr/lib64 is a real directory
  // report the loader as /lib64/ld-linux-*, which bwrap mounts through it.
  "--dir",
  "/usr/bin",
  "--dir",
  "/usr/lib",
  "--dir",
  "/usr/lib64",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
] as const;

const NATIVE_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  DENO_DIR: "/tmp/deno-cache",
});
export const NATIVE_SKILL_ROOTS_ENV = "BAKERY_WORKER_SKILL_ROOTS";
const NATIVE_SKILL_ROOTS_MAX_BYTES = 32_000;
const SKILL_CACHE_DIRECTORY = "skill-materialization-v1";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODES = new Set([0o600, 0o700]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMMUTABLE_VERSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const NATIVE_ACTION_SCRIPT = "Deno.exit(0);";
const NATIVE_PROBE_SCRIPT = [
  "const ownerPid = Deno.ppid;",
  "const ownerWatch = setInterval(() => {",
  "  if (Deno.ppid !== ownerPid) Deno.exit(125);",
  "}, 25);",
  "await new Promise(() => undefined);",
].join("\n");
const NATIVE_BOUNDARY_PREFIX = "bakery-native-";
const NATIVE_BOUNDARY_FILE = "boundary.json";
const NATIVE_ACTIONS = [
  "harness.implement",
  "harness.repair",
  "repository.inspect",
] as const;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const BOUNDARY_DIRECTORY = new RegExp(
  `^${NATIVE_BOUNDARY_PREFIX}(${UUID_PATTERN})$`,
  "i",
);
const PROBE_DIRECTORY = new RegExp(
  `^${NATIVE_BOUNDARY_PREFIX}probe-(${UUID_PATTERN})$`,
  "i",
);
const BOUNDARY_SIDECAR = new RegExp(
  `^${NATIVE_BOUNDARY_PREFIX}(${UUID_PATTERN})-${NATIVE_BOUNDARY_FILE}$`,
  "i",
);
const BOUNDARY_SIDECAR_TEMP = new RegExp(
  `^${NATIVE_BOUNDARY_PREFIX}(${UUID_PATTERN})-${NATIVE_BOUNDARY_FILE}\\.tmp-${UUID_PATTERN}$`,
  "i",
);

// A worker without a coding harness advertises `harness.repair` beside
// `harness.implement`; both end in the same honest 501 fault, so a repair step
// is claimed and refused instead of waiting for a host that can never run it.
// `repository.inspect` has its own in-process path, so it has no definition.
const DEFAULT_NATIVE_ACTIONS: readonly NativeActionDefinition[] = Object.freeze(
  NATIVE_ACTIONS.filter((action) => action !== "repository.inspect").map(
    (action) => ({
      action,
      executable: Deno.execPath(),
      args: ["eval", NATIVE_ACTION_SCRIPT],
    }),
  ),
);

function positiveBound(
  value: number | undefined,
  fallback: number,
  code: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 120_000) {
    throw new NativeExecutorError(code);
  }
  return resolved;
}

function absolutePath(value: string | undefined, code: string): string {
  const path = value?.trim().replace(/\/+$/, "") || "";
  if (
    !path.startsWith("/") || path.includes("\0") ||
    path.split("/").includes("..")
  ) throw new NativeExecutorError(code);
  return path || "/";
}

function validateSandboxPath(path: string): string {
  const normalized = path.trim().replace(/\/+$/, "") || "/";
  if (
    normalized === "/" ||
    !normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  ) throw new NativeExecutorError("NATIVE_ACTION_ALLOWLIST_INVALID");
  return normalized;
}

function validateActionDefinitions(
  actions: readonly NativeActionDefinition[],
): readonly NativeActionDefinition[] {
  const names = new Set<string>();
  const validated: NativeActionDefinition[] = [];
  for (const definition of actions) {
    if (
      !/^[a-z][a-z0-9._-]{0,99}$/.test(definition.action) ||
      names.has(definition.action) ||
      !definition.executable.startsWith("/") ||
      definition.executable.includes("\0") ||
      definition.args.some((argument) => argument.includes("\0"))
    ) {
      throw new NativeExecutorError("NATIVE_ACTION_ALLOWLIST_INVALID");
    }
    const executable = validateSandboxPath(definition.executable);
    const readOnlyPaths = Object.freeze(
      (definition.readOnlyPaths ?? []).map(validateSandboxPath),
    );
    names.add(definition.action);
    validated.push(Object.freeze({
      action: definition.action,
      executable,
      args: Object.freeze([...definition.args]),
      readOnlyPaths,
    }));
  }
  return Object.freeze(validated);
}
function nativeSandboxParentDirectories(path: string): string[] {
  const parents: string[] = [];
  let current = dirname(path);
  while (current !== "/") {
    parents.push(current);
    current = dirname(current);
  }
  return parents.reverse();
}

function nativePathIsBelow(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) &&
    !isAbsolute(path);
}

function nativePathsOverlap(left: string, right: string): boolean {
  return left === right || nativePathIsBelow(left, right) ||
    nativePathIsBelow(right, left);
}

async function canonicalNativePath(
  path: string,
  code: string,
): Promise<NativePathIdentity> {
  try {
    const realPath = await Deno.realPath(path);
    const info = await Deno.lstat(realPath);
    if (
      info.isSymlink || (!info.isFile && !info.isDirectory) ||
      info.dev === null || info.ino === null
    ) throw new Error("invalid native mount");
    return {
      path: realPath,
      identity: `${String(info.dev)}:${String(info.ino)}`,
      directory: info.isDirectory,
    };
  } catch (error) {
    throw new NativeExecutorError(
      code,
      false,
      `${path}: ${error instanceof Error ? error.message : "invalid"}`,
    );
  }
}

async function canonicalNativeSecretRoot(
  path: string,
  isStateDir: boolean,
): Promise<NativeSecretRoot> {
  const normalized = absolutePath(path, "NATIVE_SECRET_ROOT_INVALID");
  try {
    const realPath = await Deno.realPath(normalized);
    const info = await Deno.lstat(realPath);
    if (
      info.isSymlink || (!info.isFile && !info.isDirectory) ||
      info.dev === null || info.ino === null
    ) throw new Error("invalid native secret root");
    return {
      path: realPath,
      identity: `${String(info.dev)}:${String(info.ino)}`,
      directory: info.isDirectory,
      isStateDir,
    };
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw new NativeExecutorError("NATIVE_SECRET_ROOT_INVALID");
    }
  }

  const suffix: string[] = [];
  let current = normalized;
  while (true) {
    const parent = dirname(current);
    if (parent === current) {
      throw new NativeExecutorError("NATIVE_SECRET_ROOT_INVALID");
    }
    suffix.unshift(basename(current));
    current = parent;
    try {
      const realParent = await Deno.realPath(current);
      return {
        path: join(realParent, ...suffix),
        identity: null,
        directory: false,
        isStateDir,
      };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new NativeExecutorError("NATIVE_SECRET_ROOT_INVALID");
      }
    }
  }
}

function assertNativeMountsDoNotOverlapSecrets(
  mounts: readonly NativePathIdentity[],
  secrets: readonly NativeSecretRoot[],
  allowStateDirDescendants: boolean,
): void {
  for (const mount of mounts) {
    for (const secret of secrets) {
      const allowedStateSource = allowStateDirDescendants &&
        secret.isStateDir && nativePathIsBelow(secret.path, mount.path);
      if (
        (nativePathsOverlap(mount.path, secret.path) && !allowedStateSource) ||
        (mount.identity === secret.identity && secret.identity !== null)
      ) {
        throw new NativeExecutorError("NATIVE_SECRET_MOUNT_OVERLAP");
      }
    }
  }
}

async function nativeRuntimeDependencies(
  executable: string,
): Promise<string[]> {
  let result: Deno.CommandOutput;
  try {
    const dependencyTool = await canonicalNativePath(
      NATIVE_RUNTIME_DEPENDENCY_TOOL,
      "NATIVE_RUNTIME_CLOSURE_UNAVAILABLE",
    );
    result = await new Deno.Command(dependencyTool.path, {
      args: [executable],
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    if (error instanceof NativeExecutorError) throw error;
    throw new NativeExecutorError(
      "NATIVE_RUNTIME_CLOSURE_UNAVAILABLE",
      false,
      `ldd ${executable}: ${error instanceof Error ? error.message : "failed"}`,
    );
  }
  if (!result.success) {
    throw new NativeExecutorError(
      "NATIVE_RUNTIME_CLOSURE_UNAVAILABLE",
      false,
      `ldd ${executable} exit=${result.code}: ${
        boundedNativeDiagnostic(result.stderr)
      }`,
    );
  }
  const output = new TextDecoder().decode(result.stdout);
  const dependencies: string[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("linux-vdso")) continue;
    if (line.includes("statically linked")) continue;
    const mapped = /=>\s+(\S+)\s+\(/.exec(line);
    const direct = /^(\S+)\s+\(/.exec(line);
    const path = mapped?.[1] ?? direct?.[1];
    if (!path || !path.startsWith("/")) {
      throw new NativeExecutorError(
        "NATIVE_RUNTIME_CLOSURE_UNAVAILABLE",
        false,
        `ldd ${executable} unrecognized line: ${line}`,
      );
    }
    dependencies.push(path);
  }
  return dependencies;
}

async function prepareNativeRuntime(
  actions: readonly NativeActionDefinition[],
  stateDir: string | undefined,
  supervisorSecretPaths: readonly string[],
): Promise<NativeRuntimeClosure> {
  const secretRoots: NativeSecretRoot[] = [];
  if (stateDir !== undefined) {
    secretRoots.push(await canonicalNativeSecretRoot(stateDir, true));
  }
  for (const path of supervisorSecretPaths) {
    secretRoots.push(await canonicalNativeSecretRoot(path, false));
  }
  const uniqueSecrets = new Map<string, NativeSecretRoot>();
  for (const secret of secretRoots) {
    uniqueSecrets.set(
      `${secret.path}:${secret.identity ?? "missing"}`,
      secret,
    );
  }

  const mounts = new Map<string, NativeRuntimeMount>();
  const actionExecutables = new Map<string, string>();
  const addRuntimeMount = (
    source: NativePathIdentity,
    target: string,
  ): void => {
    const key = `${source.identity}:${target}`;
    if (!mounts.has(key)) {
      mounts.set(key, { ...source, target });
    }
  };
  const addExecutable = async (path: string): Promise<string> => {
    const executable = await canonicalNativePath(
      path,
      "NATIVE_RUNTIME_CLOSURE_UNAVAILABLE",
    );
    if (!executable.directory) {
      actionExecutables.set(path, executable.path);
    } else {
      throw new NativeExecutorError("NATIVE_RUNTIME_CLOSURE_UNAVAILABLE");
    }
    addRuntimeMount(executable, executable.path);
    if (path !== executable.path) addRuntimeMount(executable, path);
    for (
      const dependency of await nativeRuntimeDependencies(
        executable.path,
      )
    ) {
      const library = await canonicalNativePath(
        dependency,
        "NATIVE_RUNTIME_CLOSURE_UNAVAILABLE",
      );
      if (library.directory) {
        throw new NativeExecutorError("NATIVE_RUNTIME_CLOSURE_UNAVAILABLE");
      }
      addRuntimeMount(library, dependency);
    }
    return executable.path;
  };

  const executablePaths = [
    Deno.execPath(),
    ...NATIVE_RUNTIME_TOOL_EXECUTABLES,
    ...actions.map((definition) => definition.executable),
  ];
  const uniqueExecutablePaths = [...new Set(executablePaths)];
  for (const path of uniqueExecutablePaths) await addExecutable(path);

  const resolvedActions = [];
  const sourceMounts: NativePathIdentity[] = [];
  for (const definition of actions) {
    const readOnlyPaths = [];
    for (const path of definition.readOnlyPaths ?? []) {
      const source = await canonicalNativePath(
        path,
        "NATIVE_ACTION_ALLOWLIST_INVALID",
      );
      sourceMounts.push(source);
      readOnlyPaths.push(source.path);
    }
    resolvedActions.push(Object.freeze({
      ...definition,
      executable: actionExecutables.get(definition.executable) ??
        await addExecutable(definition.executable),
      readOnlyPaths: Object.freeze(readOnlyPaths),
    }));
  }
  const runtimeMounts = [...mounts.values()];
  assertNativeMountsDoNotOverlapSecrets(
    runtimeMounts,
    [...uniqueSecrets.values()],
    false,
  );
  assertNativeMountsDoNotOverlapSecrets(
    sourceMounts,
    [...uniqueSecrets.values()],
    false,
  );
  const probeExecutable = actionExecutables.get("/usr/bin/true") ??
    await addExecutable("/usr/bin/true");
  const denoExecutable = actionExecutables.get(Deno.execPath()) ??
    await addExecutable(Deno.execPath());
  return {
    mounts: runtimeMounts,
    probeExecutable,
    denoExecutable,
    actions: Object.freeze(resolvedActions),
    secretRoots: Object.freeze([...uniqueSecrets.values()]),
  };
}

export function nativeSandboxArguments(spec: NativeSandboxSpec): string[] {
  const mountMap = new Map<string, NativeRuntimeMount>();
  for (const mount of spec.runtimePaths) {
    mountMap.set(mount.target, mount);
  }
  for (const path of [spec.executable, ...spec.readOnlyPaths]) {
    mountMap.set(path, {
      path,
      target: path,
      identity: "",
      directory: false,
    });
  }
  const parentDirectories = new Set<string>();
  for (const mount of mountMap.values()) {
    for (const parent of nativeSandboxParentDirectories(mount.target)) {
      parentDirectories.add(parent);
    }
  }
  const mounts = [...mountMap.values()].sort((left, right) =>
    left.target.length - right.target.length ||
    left.target.localeCompare(right.target)
  );
  const args: string[] = [...NATIVE_SANDBOX_BASE_ARGS];
  for (const parent of [...parentDirectories].sort()) {
    args.push("--dir", parent);
  }
  for (const mount of mounts) {
    args.push("--ro-bind", mount.path, mount.target);
  }
  args.push("--chdir", spec.cwd ?? "/tmp", "--", spec.executable, ...spec.args);
  return args;
}

function actionSandboxSpec(
  definition: NativeActionDefinition,
  serializedSkillRoots: string | undefined,
  runtimePaths: readonly NativeRuntimeMount[],
): NativeSandboxSpec {
  const skillRoots = serializedSkillRoots === undefined
    ? []
    : JSON.parse(serializedSkillRoots) as string[];
  const environment = skillRoots.length === 0
    ? NATIVE_ENVIRONMENT
    : Object.freeze({
      ...NATIVE_ENVIRONMENT,
      [NATIVE_SKILL_ROOTS_ENV]: serializedSkillRoots,
    });
  return {
    executable: definition.executable,
    args: [...definition.args],
    runtimePaths,
    readOnlyPaths: [...(definition.readOnlyPaths ?? []), ...skillRoots],
    environment,
    forwardStdin: false,
  };
}

function nativeBootstrapArgs(spec: NativeSandboxSpec): string[] {
  return [
    "eval",
    NATIVE_BOOTSTRAP,
    JSON.stringify({
      ...spec,
      sandboxArgs: nativeSandboxArguments(spec),
    }),
  ];
}

async function probeNativeSandbox(
  runtime: NativeRuntimeClosure,
  hooks: NativeTestHooks | undefined,
): Promise<void> {
  try {
    await hooks?.beforeSandboxProbe?.();
    const bubblewrap = await canonicalNativePath(
      NATIVE_SANDBOX_EXECUTABLE,
      "NATIVE_SANDBOX_UNAVAILABLE",
    );
    if (bubblewrap.directory) {
      throw new NativeExecutorError("NATIVE_SANDBOX_UNAVAILABLE");
    }
    const result = await new Deno.Command(bubblewrap.path, {
      args: nativeSandboxArguments({
        executable: runtime.probeExecutable,
        args: [],
        runtimePaths: runtime.mounts,
        readOnlyPaths: [],
        environment: NATIVE_ENVIRONMENT,
        forwardStdin: false,
      }),
      clearEnv: true,
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new NativeExecutorError(
        "NATIVE_SANDBOX_UNAVAILABLE",
        false,
        `bwrap exit=${result.code}: ${boundedNativeDiagnostic(result.stderr)}`,
      );
    }
  } catch (error) {
    if (error instanceof NativeExecutorError) throw error;
    throw new NativeExecutorError(
      "NATIVE_SANDBOX_UNAVAILABLE",
      false,
      error instanceof Error ? error.message : "probe failed",
    );
  }
}

export async function probeNativeSandboxCapability(): Promise<void> {
  try {
    const runtime = await prepareNativeRuntime([], undefined, []);
    await probeNativeSandbox(runtime, undefined);
  } catch (error) {
    if (error instanceof NativeExecutorError && error.diagnostic) {
      console.error(`native diagnostic: ${error.diagnostic}`);
    }
    throw error;
  }
}

function nativeFailure(
  code: string,
  detail: string,
): JsonValue {
  return {
    type: "about:blank",
    title: "Native worker action failed",
    status: 500,
    detail,
    code,
    requestId: crypto.randomUUID(),
    retryable: false,
  };
}

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function pumpNativeOutput(
  source: ReadableStream<Uint8Array>,
  channel: NativeOutputChannel,
  output?: NativeOutputSink,
): Promise<void> {
  try {
    for await (const chunk of source) {
      if (output) await output.write(channel, chunk.slice());
    }
  } catch (error) {
    if (output) {
      await output.sourceLost(
        channel,
        error instanceof Error ? error.message : "NATIVE_OUTPUT_PUMP_FAILED",
      );
    }
  }
}

async function drainNativeOutput(
  pumps: Promise<void>,
  output?: NativeOutputSink,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 5_000);
  });
  const result = await Promise.race([
    pumps.then(() => "drained" as const),
    bounded,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result === "timeout" && output) {
    await Promise.all([
      output.sourceLost("stdout", "NATIVE_OUTPUT_DRAIN_TIMEOUT"),
      output.sourceLost("stderr", "NATIVE_OUTPUT_DRAIN_TIMEOUT"),
    ]);
  }
}

type StatLike = {
  readonly dev?: number | bigint;
  readonly ino?: number | bigint;
  readonly isDirectory?: boolean;
  readonly isSymlink?: boolean;
};

function statFingerprint(info: StatLike): string {
  if (info.dev === undefined || info.ino === undefined) {
    throw new NativeExecutorError("NATIVE_CGROUP_IDENTITY_UNAVAILABLE");
  }
  return `${String(info.dev)}:${String(info.ino)}`;
}

async function lstatDirectoryOrMissing(
  path: string,
): Promise<StatLike | null> {
  let info: StatLike;
  try {
    info = await Deno.lstat(path) as unknown as StatLike;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw new NativeExecutorError("NATIVE_CGROUP_UNAVAILABLE");
  }
  if (info.isDirectory !== true || info.isSymlink === true) {
    throw new NativeExecutorError("NATIVE_CGROUP_UNAVAILABLE");
  }
  return info;
}

async function lstatDirectory(path: string): Promise<StatLike> {
  const info = await lstatDirectoryOrMissing(path);
  if (!info) throw new NativeExecutorError("NATIVE_CGROUP_UNAVAILABLE");
  return info;
}

async function readRequired(path: string, code: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    throw new NativeExecutorError(code);
  }
}

async function requireFile(path: string, code: string): Promise<void> {
  try {
    const info = await Deno.lstat(path);
    if (info.isFile !== true || info.isSymlink === true) throw new Error();
  } catch {
    throw new NativeExecutorError(code);
  }
}

async function writeCgroupFile(
  path: string,
  value: string,
  operation: "attach" | "kill",
  hooks: NativeTestHooks | undefined,
  failureCode: string,
): Promise<void> {
  try {
    await hooks?.beforeCgroupWrite?.(operation, path);
    await Deno.writeTextFile(path, value);
  } catch {
    throw new NativeExecutorError(failureCode, true);
  }
}

function parsePopulated(events: string): boolean {
  const value = events.split("\n").find((line) => line.startsWith("populated "))
    ?.slice("populated ".length).trim();
  if (value !== "0" && value !== "1") {
    throw new NativeExecutorError("NATIVE_CGROUP_PROOF_UNAVAILABLE");
  }
  return value === "1";
}

async function waitForEmpty(
  path: string,
  timing: NativeTiming,
  failureCode: string,
): Promise<void> {
  const deadline = Date.now() + timing.terminationGraceMs;
  while (Date.now() <= deadline) {
    let populated: boolean;
    try {
      populated = parsePopulated(
        await Deno.readTextFile(`${path}/cgroup.events`),
      );
    } catch {
      throw new NativeExecutorError(failureCode, true);
    }
    if (!populated) return;
    await sleep(
      Math.min(timing.probeIntervalMs, Math.max(1, deadline - Date.now())),
    );
  }
  throw new NativeExecutorError(failureCode, true);
}

async function probeCgroupRoot(
  root: string,
  hooks: NativeTestHooks | undefined,
  probeIntervalMs: number,
): Promise<void> {
  await lstatDirectory(root);
  const controllers = await readRequired(
    `${root}/cgroup.controllers`,
    "NATIVE_CGROUP_UNAVAILABLE",
  );
  if (!controllers.split(/\s+/).includes("pids")) {
    throw new NativeExecutorError("NATIVE_CGROUP_UNAVAILABLE");
  }
  const probe = `${root}/${NATIVE_BOUNDARY_PREFIX}probe-${crypto.randomUUID()}`;
  let child: Deno.ChildProcess | undefined;
  let statusPromise: Promise<Deno.CommandStatus> | undefined;
  let failure: unknown = null;
  try {
    await Deno.mkdir(probe);
    await readRequired(`${probe}/cgroup.events`, "NATIVE_CGROUP_UNAVAILABLE");
    await readRequired(`${probe}/cgroup.procs`, "NATIVE_CGROUP_UNAVAILABLE");
    await requireFile(`${probe}/cgroup.kill`, "NATIVE_CGROUP_UNAVAILABLE");
    child = new Deno.Command(Deno.execPath(), {
      args: ["eval", NATIVE_PROBE_SCRIPT],
      clearEnv: true,
      env: NATIVE_ENVIRONMENT,
      stdout: "null",
      stderr: "null",
    }).spawn();
    statusPromise = child.status;
    await writeCgroupFile(
      `${probe}/cgroup.procs`,
      `${child.pid}\n`,
      "attach",
      hooks,
      "NATIVE_CGROUP_UNAVAILABLE",
    );
    await writeCgroupFile(
      `${probe}/cgroup.kill`,
      "1\n",
      "kill",
      hooks,
      "NATIVE_CGROUP_UNAVAILABLE",
    );
    await waitForEmpty(
      probe,
      { terminationGraceMs: 1_000, probeIntervalMs },
      "NATIVE_CGROUP_UNAVAILABLE",
    );
    await statusPromise;
  } catch (error) {
    failure = error instanceof NativeExecutorError
      ? error
      : new NativeExecutorError("NATIVE_CGROUP_UNAVAILABLE");
  } finally {
    if (child && statusPromise) {
      const exited = await Promise.race([
        statusPromise.then(() => true).catch(() => true),
        sleep(100).then(() => false),
      ]);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The probe may have exited between the race and the kill.
        }
        await statusPromise.catch(() => undefined);
      }
    }
    try {
      await Deno.remove(probe);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) && !failure) {
        failure = new NativeExecutorError("NATIVE_CGROUP_UNAVAILABLE");
      }
    }
  }
  if (failure) throw failure;
}

function identityPath(
  root: string,
  boundaryId: string,
): string {
  return `${root}/${NATIVE_BOUNDARY_PREFIX}${boundaryId}`;
}

function boundaryFilePath(stateDir: string, boundaryId: string): string {
  return `${stateDir}/${NATIVE_BOUNDARY_PREFIX}${boundaryId}-${NATIVE_BOUNDARY_FILE}`;
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function validateIdentity(
  identity: WorkerExecutionIdentity,
  root: string,
  stateDir: string,
): void {
  const phase = identity.phase ?? "active";
  const hasDevice = identity.cgroupDevice !== undefined;
  const hasInode = identity.cgroupInode !== undefined;
  if (
    identity.type !== "cgroup-v2" || !UUID.test(identity.boundaryId) ||
    !identity.attemptId || !identity.assignmentFence ||
    identity.cgroupRoot !== root ||
    identity.cgroupPath !== identityPath(root, identity.boundaryId) ||
    identity.sidecarPath !== boundaryFilePath(stateDir, identity.boundaryId) ||
    !["provisioning", "active", "terminating"].includes(phase) ||
    hasDevice !== hasInode ||
    (phase !== "provisioning" && (!hasDevice || !identity.cgroupDevice ||
      !identity.cgroupInode))
  ) throw new NativeExecutorError("NATIVE_CGROUP_IDENTITY_INVALID");
}

async function validateBoundary(
  identity: WorkerExecutionIdentity,
): Promise<StatLike> {
  const info = await lstatDirectory(identity.cgroupPath);
  if (
    identity.cgroupDevice !== undefined &&
    statFingerprint(info) !==
      `${identity.cgroupDevice}:${identity.cgroupInode}`
  ) {
    throw new NativeExecutorError("NATIVE_CGROUP_IDENTITY_MISMATCH");
  }
  await readRequired(
    `${identity.cgroupPath}/cgroup.events`,
    "NATIVE_CGROUP_PROOF_UNAVAILABLE",
  );
  await readRequired(
    `${identity.cgroupPath}/cgroup.procs`,
    "NATIVE_CGROUP_PROOF_UNAVAILABLE",
  );
  await requireFile(
    `${identity.cgroupPath}/cgroup.kill`,
    "NATIVE_CGROUP_PROOF_UNAVAILABLE",
  );
  return info;
}

type CleanupResult = {
  readonly processExited: boolean;
  readonly exitedAt: string | null;
  readonly cleanupStatus: "complete";
  readonly terminationStatus: "confirmed";
};

async function cleanBoundary(
  identity: WorkerExecutionIdentity,
  timing: NativeTiming,
  processStatus: Promise<{ settled: boolean; exitedAt: string | null }>,
  hooks?: NativeTestHooks,
  persistPhase = true,
): Promise<CleanupResult> {
  const legacy = identity.phase === undefined;
  const phase = identity.phase ?? "active";
  let current = identity;
  const info = await lstatDirectoryOrMissing(identity.cgroupPath);
  if (!info) {
    if (phase === "terminating" || legacy) {
      const settled = await processStatus;
      if (!settled.settled) {
        throw new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true);
      }
      return {
        processExited: true,
        exitedAt: settled.exitedAt,
        cleanupStatus: "complete",
        terminationStatus: "confirmed",
      };
    }
    throw new NativeExecutorError("NATIVE_CGROUP_UNAVAILABLE", true);
  }
  await validateBoundary(identity);
  if (phase !== "terminating") {
    current = {
      ...identity,
      phase: "terminating",
      cgroupDevice: String(info.dev),
      cgroupInode: String(info.ino),
    };
    if (persistPhase) {
      try {
        await writeJsonAtomically(current.sidecarPath, current);
      } catch {
        throw new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true);
      }
    }
  }
  await validateBoundary(current);
  await writeCgroupFile(
    `${current.cgroupPath}/cgroup.kill`,
    "1\n",
    "kill",
    hooks,
    "NATIVE_CGROUP_CLEANUP_FAILED",
  );
  await waitForEmpty(
    current.cgroupPath,
    timing,
    "NATIVE_CGROUP_CLEANUP_FAILED",
  );
  const settled = await Promise.race([
    processStatus,
    sleep(timing.terminationGraceMs).then(() => ({
      settled: false,
      exitedAt: null,
    })),
  ]);
  if (!settled.settled) {
    throw new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true);
  }
  try {
    await Deno.remove(current.cgroupPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true);
    }
  }
  if (await lstatDirectoryOrMissing(current.cgroupPath)) {
    throw new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true);
  }
  return {
    processExited: true,
    exitedAt: settled.exitedAt,
    cleanupStatus: "complete",
    terminationStatus: "confirmed",
  };
}
async function cleanUnownedCgroup(
  path: string,
  timing: NativeTiming,
): Promise<void> {
  await lstatDirectory(path);
  await readRequired(
    `${path}/cgroup.events`,
    "NATIVE_CGROUP_PROOF_UNAVAILABLE",
  );
  await readRequired(
    `${path}/cgroup.procs`,
    "NATIVE_CGROUP_PROOF_UNAVAILABLE",
  );
  await requireFile(
    `${path}/cgroup.kill`,
    "NATIVE_CGROUP_PROOF_UNAVAILABLE",
  );
  await writeCgroupFile(
    `${path}/cgroup.kill`,
    "1\n",
    "kill",
    undefined,
    "NATIVE_CGROUP_CLEANUP_FAILED",
  );
  await waitForEmpty(path, timing, "NATIVE_CGROUP_CLEANUP_FAILED");
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true);
    }
  }
  if (await lstatDirectoryOrMissing(path)) {
    throw new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true);
  }
}

function nativeMode(info: Deno.FileInfo): number {
  if (info.mode === null) {
    throw new NativeExecutorError("PREPARED_SKILL_ROOT_OS_UNSUPPORTED");
  }
  return info.mode & 0o777;
}

function isBelow(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) &&
    !isAbsolute(path);
}

function exactPreparedOwner(
  value: unknown,
  root: PreparedSkillRoot,
  copyId: string,
  cacheRoot: Deno.FileInfo,
  uid: number,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const owner = value as Record<string, unknown>;
  const keys = Object.keys(owner).sort().join(",");
  if (
    keys !==
      "attemptId,copyId,dev,digest,fence,ino,jobId,organizationId,uid,versionId,workerHostId,workerSessionGeneration,workerSessionId"
  ) return false;
  return owner.dev === String(cacheRoot.dev) &&
    owner.ino === String(cacheRoot.ino) && owner.uid === uid &&
    owner.organizationId === root.organizationId &&
    owner.versionId === root.versionId && owner.digest === root.digest &&
    owner.workerHostId === root.workerHostId &&
    owner.workerSessionId === root.workerSessionId &&
    owner.workerSessionGeneration === root.workerSessionGeneration &&
    owner.jobId === root.jobId && owner.attemptId === root.attemptId &&
    owner.fence === root.fence && owner.copyId === copyId;
}

async function validatePrivateSkillTree(
  path: string,
  uid: number,
): Promise<{ dev: string; ino: string }> {
  const root = await Deno.lstat(path);
  if (
    !root.isDirectory || root.isSymlink || root.uid !== uid ||
    nativeMode(root) !== PRIVATE_DIRECTORY_MODE
  ) throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
  const visit = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const child = join(directory, entry.name);
      const info = await Deno.lstat(child);
      if (info.isSymlink || info.uid !== uid) {
        throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
      }
      if (info.isDirectory) {
        if (nativeMode(info) !== PRIVATE_DIRECTORY_MODE) {
          throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
        }
        await visit(child);
      } else if (
        !info.isFile || !PRIVATE_FILE_MODES.has(nativeMode(info)) ||
        info.nlink !== 1
      ) {
        throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
      }
    }
  };
  await visit(path);
  return { dev: String(root.dev), ino: String(root.ino) };
}

/**
 * Revalidates exact attempt-private roots and serializes only their paths for
 * the trusted same-UID native child. This is not an operating-system sandbox.
 */
export async function serializePreparedSkillRoots(
  stateDir: string,
  assignment: JobAssignment,
  preparedSkills: PreparedSkillContext | undefined,
): Promise<string | undefined> {
  if (assignment.skillRefs.length === 0) {
    if ((preparedSkills?.roots.length ?? 0) !== 0) {
      throw new NativeExecutorError("PREPARED_SKILL_ROOT_IDENTITY_MISMATCH");
    }
    return undefined;
  }
  if (
    !preparedSkills ||
    preparedSkills.roots.length !== assignment.skillRefs.length
  ) {
    throw new NativeExecutorError("PREPARED_SKILL_ROOTS_REQUIRED");
  }
  const { owner } = preparedSkills;
  if (
    owner.workerHostId !== assignment.workerHostId ||
    owner.workerSessionId !== assignment.workerSessionId ||
    owner.workerSessionGeneration !== assignment.workerSessionGeneration ||
    owner.jobId !== assignment.jobId ||
    owner.attemptId !== assignment.attemptId ||
    owner.fence !== String(assignment.fence)
  ) throw new NativeExecutorError("PREPARED_SKILL_ROOT_IDENTITY_MISMATCH");

  const uid = Deno.uid();
  if (uid === null) {
    throw new NativeExecutorError("PREPARED_SKILL_ROOT_OS_UNSUPPORTED");
  }
  const configuredCacheRoot = join(stateDir, SKILL_CACHE_DIRECTORY);
  const configuredRootInfo = await Deno.lstat(configuredCacheRoot);
  if (configuredRootInfo.isSymlink) {
    throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
  }
  const cacheRootPath = await Deno.realPath(configuredCacheRoot);
  const cacheRoot = await Deno.lstat(cacheRootPath);
  if (
    !cacheRoot.isDirectory || cacheRoot.isSymlink || cacheRoot.uid !== uid ||
    nativeMode(cacheRoot) !== PRIVATE_DIRECTORY_MODE
  ) throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");

  const expectedParent = join(
    cacheRootPath,
    "attempts",
    owner.workerHostId,
    owner.workerSessionId,
    owner.workerSessionGeneration,
    owner.attemptId,
    owner.fence,
  );
  const pins = new Set(
    assignment.skillRefs.map((ref) => `${ref.versionId}:${ref.digest}`),
  );
  const roots = new Set<string>();
  const treeIdentities = new Set<string>();
  for (const root of preparedSkills.roots) {
    if (
      root.workerHostId !== owner.workerHostId ||
      root.workerSessionId !== owner.workerSessionId ||
      root.workerSessionGeneration !== owner.workerSessionGeneration ||
      root.jobId !== owner.jobId || root.attemptId !== owner.attemptId ||
      root.fence !== owner.fence ||
      !IMMUTABLE_VERSION_UUID.test(root.versionId) ||
      !SHA256.test(root.digest) ||
      !pins.delete(`${root.versionId}:${root.digest}`) ||
      !isAbsolute(root.rootPath) || basename(root.rootPath) !== "tree"
    ) throw new NativeExecutorError("PREPARED_SKILL_ROOT_IDENTITY_MISMATCH");
    const copyPath = dirname(root.rootPath);
    const copyId = basename(copyPath);
    if (
      !UUID.test(copyId) || dirname(copyPath) !== expectedParent ||
      !isBelow(expectedParent, root.rootPath) || roots.has(root.rootPath) ||
      await Deno.realPath(root.rootPath) !== root.rootPath
    ) throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");

    const ownerPath = join(copyPath, "owner.json");
    const ownerInfo = await Deno.lstat(ownerPath);
    if (
      !ownerInfo.isFile || ownerInfo.isSymlink || ownerInfo.uid !== uid ||
      nativeMode(ownerInfo) !== 0o600 || ownerInfo.nlink !== 1
    ) throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
    let ownerRecord: unknown;
    try {
      ownerRecord = JSON.parse(await Deno.readTextFile(ownerPath));
    } catch {
      throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
    }
    if (!exactPreparedOwner(ownerRecord, root, copyId, cacheRoot, uid)) {
      throw new NativeExecutorError("PREPARED_SKILL_ROOT_IDENTITY_MISMATCH");
    }

    const treeIdentity = await validatePrivateSkillTree(root.rootPath, uid);
    const identityKey = `${treeIdentity.dev}:${treeIdentity.ino}`;
    if (treeIdentities.has(identityKey)) {
      throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
    }
    treeIdentities.add(identityKey);
    if (
      isAbsolute(root.entryPath) || root.entryPath.includes("\\") ||
      root.entryPath.includes("\0") ||
      root.entryPath.split("/").some((part) =>
        part === "" || part === "." || part === ".."
      )
    ) throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
    const entryPath = join(root.rootPath, ...root.entryPath.split("/"));
    if (!isBelow(root.rootPath, entryPath)) {
      throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
    }
    const entry = await Deno.lstat(entryPath);
    if (
      !entry.isFile || entry.isSymlink || entry.uid !== uid ||
      !PRIVATE_FILE_MODES.has(nativeMode(entry)) || entry.nlink !== 1
    ) throw new NativeExecutorError("PREPARED_SKILL_ROOT_INVALID");
    roots.add(root.rootPath);
  }
  if (pins.size !== 0) {
    throw new NativeExecutorError("PREPARED_SKILL_ROOT_IDENTITY_MISMATCH");
  }
  const serialized = JSON.stringify([...roots]);
  if (
    new TextEncoder().encode(serialized).byteLength >
      NATIVE_SKILL_ROOTS_MAX_BYTES
  ) {
    throw new NativeExecutorError("PREPARED_SKILL_ROOTS_TOO_LARGE");
  }
  return serialized;
}

const NATIVE_BOOTSTRAP = `
const sandbox = JSON.parse(Deno.args[0]);
const ownerPid = Deno.ppid;
const ownerWatch = setInterval(() => {
  if (Deno.ppid !== ownerPid) Deno.exit(125);
}, 25);
const gate = new Uint8Array(1);
const read = await Deno.stdin.read(gate);
if (read === null) {
  clearInterval(ownerWatch);
  Deno.exit(125);
}
const child = new Deno.Command("${NATIVE_SANDBOX_EXECUTABLE}", {
  args: sandbox.sandboxArgs,
  clearEnv: true,
  env: sandbox.environment,
  stdin: sandbox.forwardStdin ? "piped" : "null",
  stdout: "piped",
  stderr: "piped",
}).spawn();
async function forward(source, target) {
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      offset += await target.write(chunk.subarray(offset));
    }
  }
}
async function forwardInput() {
  const writer = child.stdin.getWriter();
  const buffer = new Uint8Array(64 * 1024);
  try {
    while (true) {
      const read = await Deno.stdin.read(buffer);
      if (read === null) break;
      let offset = 0;
      while (offset < read) {
        offset += await writer.write(buffer.subarray(offset, read));
      }
    }
  } finally {
    await writer.close();
  }
}
const [status] = await Promise.all([
  child.status,
  forward(child.stdout, Deno.stdout),
  forward(child.stderr, Deno.stderr),
  sandbox.forwardStdin ? forwardInput() : Promise.resolve(),
]);
clearInterval(ownerWatch);
Deno.exit(status.success ? 0 : (status.code ?? 1));
`;

export const NATIVE_SUPPORTED_ACTIONS = NATIVE_ACTIONS;

function boundaryFailure(error: unknown): NativeExecutorError {
  if (error instanceof NativeExecutorError && error.boundaryFailure) {
    return error;
  }
  return new NativeExecutorError("NATIVE_CGROUP_BOUNDARY_FAILED", true);
}

export function createNativeExecutor(
  options: NativeExecutorOptions = {},
): WorkerExecutor {
  const root = absolutePath(options.cgroupRoot, "NATIVE_CGROUP_ROOT_REQUIRED");
  const stateDir = absolutePath(options.stateDir, "NATIVE_STATE_DIR_REQUIRED");
  const actions = validateActionDefinitions(
    options.actions ?? DEFAULT_NATIVE_ACTIONS,
  );
  const timing: NativeTiming = {
    terminationGraceMs: positiveBound(
      options.terminationGraceMs,
      1_000,
      "NATIVE_TERMINATION_GRACE_INVALID",
    ),
    probeIntervalMs: positiveBound(
      options.probeIntervalMs,
      25,
      "NATIVE_PROBE_INTERVAL_INVALID",
    ),
  };
  const hooks = options.testHooks;
  let runtime: NativeRuntimeClosure | undefined;
  let definitions = Object.create(null) as Record<
    string,
    NativeActionDefinition
  >;
  for (const definition of actions) definitions[definition.action] = definition;
  const sidecarDirectory = `${stateDir}/native-executions`;
  const inspectionDirectory = (boundaryId: string) =>
    `${sidecarDirectory}/${NATIVE_BOUNDARY_PREFIX}${boundaryId}-source`;

  const executeInspection = async (
    assignment: JobAssignment,
    signal: AbortSignal,
    output?: NativeOutputSink,
  ): Promise<ExecutionOutcome> => {
    if (!options.loadInspectionSource) {
      throw new NativeExecutorError("INSPECTION_SOURCE_LOADER_REQUIRED");
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal.addEventListener("abort", forwardAbort, { once: true });
    if (signal.aborted) controller.abort();
    let timer = setTimeout(forwardAbort, INSPECTION_LIMITS.durationMs);
    const startedAt = new Date().toISOString();
    const boundaryId = crypto.randomUUID();
    const directory = inspectionDirectory(boundaryId);
    let identity: WorkerExecutionIdentity = {
      type: "cgroup-v2",
      phase: "provisioning",
      boundaryId,
      attemptId: assignment.attemptId,
      assignmentFence: String(assignment.fence),
      cgroupRoot: root,
      cgroupPath: identityPath(root, boundaryId),
      sidecarPath: boundaryFilePath(sidecarDirectory, boundaryId),
    };
    let child: Deno.ChildProcess | undefined;
    let attached = false;
    let created = false;
    let persisted = false;
    let processStatus: Promise<{ settled: boolean; exitedAt: string | null }> =
      Promise.resolve({ settled: true, exitedAt: new Date().toISOString() });
    let cleanupPromise: Promise<CleanupResult> | undefined;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        if (child && !attached) {
          try {
            child.kill("SIGKILL");
          } catch { /* Already exited. */ }
          await processStatus;
        }
        const result = created
          ? await cleanBoundary(identity, timing, processStatus, hooks)
          : {
            processExited: true,
            exitedAt: new Date().toISOString(),
            cleanupStatus: "complete" as const,
            terminationStatus: "confirmed" as const,
          };
        await removeRepositoryInspectionDirectory(directory);
        if (persisted) await removeSidecar(identity.sidecarPath);
        return result;
      })();
      return cleanupPromise;
    };
    const abort = () => {
      void cleanup().catch(() => undefined);
    };
    try {
      validateIdentity(identity, root, sidecarDirectory);
      await writeJsonAtomically(identity.sidecarPath, identity);
      persisted = true;
      await Deno.mkdir(identity.cgroupPath);
      created = true;
      const info = await lstatDirectory(identity.cgroupPath);
      identity = {
        ...identity,
        phase: "active",
        cgroupDevice: String(info.dev),
        cgroupInode: String(info.ino),
      };
      await writeJsonAtomically(identity.sidecarPath, identity);
      for (
        const [file, value] of [["memory.max", INSPECTION_LIMITS.memoryBytes], [
          "memory.swap.max",
          0,
        ], ["pids.max", INSPECTION_LIMITS.processes]] as const
      ) {
        await requireFile(
          `${identity.cgroupPath}/${file}`,
          "NATIVE_CGROUP_LIMIT_UNAVAILABLE",
        );
        await Deno.writeTextFile(
          `${identity.cgroupPath}/${file}`,
          `${value}\n`,
        );
        if (
          (await Deno.readTextFile(`${identity.cgroupPath}/${file}`)).trim() !==
            String(value)
        ) throw new NativeExecutorError("NATIVE_CGROUP_LIMIT_UNAVAILABLE");
      }
      const loaded = await options.loadInspectionSource(
        assignment,
        controller.signal,
        directory,
      );
      controller.signal.throwIfAborted();
      if (loaded.sourceDirectory !== `${directory}/source`) {
        throw new NativeExecutorError("INSPECTION_SOURCE_DIRECTORY_INVALID");
      }
      clearTimeout(timer);
      const remainingMs = Math.min(
        Date.parse(loaded.receipt.expiresAt),
        Date.parse(startedAt) + INSPECTION_LIMITS.durationMs,
      ) - Date.now();
      if (remainingMs <= 0) {
        throw new NativeExecutorError("INSPECTION_RECEIPT_EXPIRED");
      }
      timer = setTimeout(forwardAbort, remainingMs);
      const payload = new TextEncoder().encode(
        inspectionCanonicalJson({ ...loaded, startedAt }),
      );
      if (payload.length > 100000) {
        throw new NativeExecutorError("INSPECTION_INPUT_LIMIT");
      }
      const currentRuntime = runtime;
      if (!currentRuntime) {
        throw new NativeExecutorError("NATIVE_RUNTIME_CLOSURE_UNAVAILABLE");
      }
      const sourceMount = await canonicalNativePath(
        directory,
        "NATIVE_SOURCE_MOUNT_INVALID",
      );
      assertNativeMountsDoNotOverlapSecrets(
        [sourceMount],
        currentRuntime.secretRoots,
        true,
      );
      const inspectionSourceDirectory = join(sourceMount.path, "source");
      if (loaded.sourceDirectory !== `${directory}/source`) {
        throw new NativeExecutorError("INSPECTION_SOURCE_DIRECTORY_INVALID");
      }
      if (
        await Deno.realPath(loaded.sourceDirectory) !==
          inspectionSourceDirectory
      ) {
        throw new NativeExecutorError("INSPECTION_SOURCE_DIRECTORY_INVALID");
      }
      const inspectionSandbox: NativeSandboxSpec = {
        executable: currentRuntime.denoExecutable,
        args: [
          "run",
          "--no-prompt",
          "--no-config",
          "--no-lock",
          "--no-remote",
          "--no-npm",
          `--allow-read=${sourceMount.path}`,
          `--allow-run=${GIT_EXECUTABLE},/usr/bin/node,${currentRuntime.denoExecutable}`,
          `data:application/typescript,${
            encodeURIComponent(REPOSITORY_INSPECTION_CHILD)
          }`,
        ],
        cwd: inspectionSourceDirectory,
        runtimePaths: currentRuntime.mounts,
        readOnlyPaths: [sourceMount.path],
        environment: Object.freeze({ DENO_DIR: "/tmp/deno-cache" }),
        forwardStdin: true,
      };
      child = new Deno.Command(Deno.execPath(), {
        args: nativeBootstrapArgs(inspectionSandbox),
        clearEnv: true,
        env: NATIVE_ENVIRONMENT,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      processStatus = child.status.then(
        () => ({ settled: true, exitedAt: new Date().toISOString() }),
        () => ({ settled: false, exitedAt: null }),
      );
      await writeCgroupFile(
        `${identity.cgroupPath}/cgroup.procs`,
        `${child.pid}\n`,
        "attach",
        hooks,
        "NATIVE_CGROUP_BOUNDARY_FAILED",
      );
      attached = true;
      controller.signal.addEventListener("abort", abort, { once: true });
      controller.signal.throwIfAborted();
      const reportOutput = (async () => {
        const bytes = new Uint8Array(INSPECTION_LIMITS.reportBytes);
        let length = 0;
        for await (const originalChunk of child!.stdout) {
          if (length + originalChunk.length > bytes.length) {
            void cleanup().catch(() => undefined);
            throw new NativeExecutorError("INSPECTION_REPORT_LIMIT");
          }
          bytes.set(originalChunk, length);
          length += originalChunk.length;
          await output?.write("stdout", originalChunk.slice());
        }
        return bytes.subarray(0, length);
      })();
      const stderrOutput = pumpNativeOutput(child.stderr, "stderr", output);
      const writer = child.stdin.getWriter();
      await writer.write(new Uint8Array([1]));
      await writer.write(payload);
      await writer.close();
      const [bytes, status] = await Promise.all([
        reportOutput,
        child.status,
        stderrOutput,
      ]);
      const result = await cleanup();
      if (signal.aborted) {
        return {
          status: "canceled",
          cancellation: {
            ...result,
            executionIdentity: identity as unknown as JsonValue,
          },
        };
      }
      if (controller.signal.aborted || !status.success) {
        return {
          status: "failed",
          fault: nativeFailure(
            "INSPECTION_BOUNDED_FAILURE",
            "Inspection exceeded its boundary or could not produce evidence.",
          ),
        };
      }
      await hooks?.afterInspectionParserInput?.(bytes.slice());
      const report = RepositoryInspectionReportSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (
        inspectionCanonicalJson(report.input) !==
          inspectionCanonicalJson(loaded.input) ||
        inspectionCanonicalJson(report.receipt) !==
          inspectionCanonicalJson(loaded.receipt) ||
        report.host.workerHostId !== loaded.receipt.workerHostId ||
        Date.parse(report.completedAt) > Date.parse(report.receipt.expiresAt)
      ) throw new NativeExecutorError("INSPECTION_REPORT_IDENTITY_INVALID");
      return { status: "completed", result: report as unknown as JsonValue };
    } catch (error) {
      let result: CleanupResult;
      try {
        result = await cleanup();
      } catch (cleanupError) {
        throw boundaryFailure(cleanupError);
      }
      if (signal.aborted) {
        return {
          status: "canceled",
          cancellation: {
            ...result,
            executionIdentity: identity as unknown as JsonValue,
          },
        };
      }
      if (error instanceof NativeExecutorError && error.boundaryFailure) {
        throw error;
      }
      return {
        status: "failed",
        fault: nativeFailure(
          "INSPECTION_EXECUTION_FAILED",
          "Bounded source or inspection evidence was unavailable.",
        ),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", abort);
    }
  };

  const removeSidecar = async (path: string): Promise<void> => {
    try {
      await removeIfPresent(path);
    } catch {
      throw new NativeExecutorError("NATIVE_CGROUP_CLEANUP_FAILED", true);
    }
  };

  const initialize = async (): Promise<void> => {
    await ensurePrivateDirectory(sidecarDirectory);
    await probeCgroupRoot(root, hooks, timing.probeIntervalMs);
    const claimedBoundaries = new Set<string>();
    for await (const entry of Deno.readDir(sidecarDirectory)) {
      if (entry.isFile && BOUNDARY_SIDECAR_TEMP.test(entry.name)) {
        await removeIfPresent(`${sidecarDirectory}/${entry.name}`);
        continue;
      }
      if (!entry.isFile) continue;
      const match = BOUNDARY_SIDECAR.exec(entry.name);
      if (!match) continue;
      const sidecarPath = `${sidecarDirectory}/${entry.name}`;
      let identity: WorkerExecutionIdentity | null;
      try {
        identity = await readJsonIfExists<WorkerExecutionIdentity>(
          sidecarPath,
        );
      } catch {
        throw new NativeExecutorError("NATIVE_CGROUP_IDENTITY_INVALID");
      }
      if (!identity) {
        throw new NativeExecutorError("NATIVE_CGROUP_IDENTITY_INVALID");
      }
      validateIdentity(identity, root, sidecarDirectory);
      claimedBoundaries.add(identity.boundaryId);
      const phase = identity.phase;
      const pathInfo = await lstatDirectoryOrMissing(identity.cgroupPath);
      if (
        !pathInfo &&
        (phase === undefined || phase === "provisioning" ||
          phase === "terminating")
      ) {
        await removeSidecar(sidecarPath);
        await removeRepositoryInspectionDirectory(
          inspectionDirectory(identity.boundaryId),
        );
        continue;
      }
      if (!pathInfo) {
        throw new NativeExecutorError("NATIVE_CGROUP_RECOVERY_UNAVAILABLE");
      }
      const cleanup = await cleanBoundary(
        identity,
        timing,
        Promise.resolve({ settled: true, exitedAt: new Date().toISOString() }),
      );
      await removeSidecar(sidecarPath);
      await removeRepositoryInspectionDirectory(
        inspectionDirectory(identity.boundaryId),
      );
      if (
        cleanup.cleanupStatus !== "complete" ||
        cleanup.terminationStatus !== "confirmed"
      ) {
        throw new NativeExecutorError("NATIVE_CGROUP_RECOVERY_UNAVAILABLE");
      }
    }

    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory || entry.isSymlink) continue;
      const probeMatch = PROBE_DIRECTORY.exec(entry.name);
      if (probeMatch) {
        await cleanUnownedCgroup(`${root}/${entry.name}`, timing);
        continue;
      }
      const match = BOUNDARY_DIRECTORY.exec(entry.name);
      if (!match || claimedBoundaries.has(match[1])) continue;
      const boundaryId = match[1];
      const cgroupPath = identityPath(root, boundaryId);
      const info = await lstatDirectory(cgroupPath);
      const identity: WorkerExecutionIdentity = {
        type: "cgroup-v2",
        phase: "terminating",
        boundaryId,
        attemptId: "orphan-recovery",
        assignmentFence: "0",
        cgroupRoot: root,
        cgroupPath,
        cgroupDevice: String(info.dev),
        cgroupInode: String(info.ino),
        sidecarPath: boundaryFilePath(sidecarDirectory, boundaryId),
      };
      await cleanBoundary(
        identity,
        timing,
        Promise.resolve({ settled: true, exitedAt: new Date().toISOString() }),
        undefined,
        false,
      );
    }
    for await (const entry of Deno.readDir(sidecarDirectory)) {
      if (
        entry.isDirectory && !entry.isSymlink &&
        /^bakery-native-[0-9a-f-]{36}-source$/i.test(entry.name)
      ) {
        await removeRepositoryInspectionDirectory(
          `${sidecarDirectory}/${entry.name}`,
        );
      }
    }
    runtime = await prepareNativeRuntime(
      actions,
      stateDir,
      options.supervisorSecretPaths ?? [],
    );
    definitions = Object.create(null) as Record<
      string,
      NativeActionDefinition
    >;
    for (const definition of runtime.actions) {
      definitions[definition.action] = definition;
    }
    await probeNativeSandbox(runtime, hooks);
  };
  const ready = initialize();

  return {
    capturesNativeOutput: true,
    supportedActions: Object.freeze([
      ...actions.map((definition) => definition.action),
      "repository.inspect",
      ...(options.publishArtifactFor ? ["task.brief"] : []),
    ]),
    initialize: () => ready,
    async execute(
      assignment,
      signal,
      output,
      preparedSkills,
    ): Promise<ExecutionOutcome> {
      await ready;
      const currentRuntime = runtime;
      if (!currentRuntime) {
        throw new NativeExecutorError("NATIVE_RUNTIME_CLOSURE_UNAVAILABLE");
      }
      await enforceWorkerFixedPolicy(assignment);
      if (assignment.action === "repository.inspect") {
        if (
          assignment.skillRefs.length > 0 ||
          (preparedSkills?.roots.length ?? 0) > 0
        ) {
          throw new NativeExecutorError(
            "PREPARED_SKILL_ROOTS_UNSUPPORTED:repository.inspect",
          );
        }
        return await executeInspection(assignment, signal, output);
      }
      if (assignment.action === "task.brief") {
        // It renders server-frozen text and runs no untrusted code, so it
        // needs no sandbox, skills or secrets.
        if (
          !options.publishArtifactFor ||
          assignment.skillRefs.length > 0 ||
          (preparedSkills?.roots.length ?? 0) > 0
        ) {
          throw new NativeExecutorError(
            "PREPARED_SKILL_ROOTS_UNSUPPORTED:task.brief",
          );
        }
        return await executeTaskBrief(
          assignment,
          signal,
          options.publishArtifactFor(assignment),
        );
      }
      let serializedSkillRoots = await serializePreparedSkillRoots(
        stateDir,
        assignment,
        preparedSkills,
      );
      if (serializedSkillRoots !== undefined) {
        const skillMounts: NativePathIdentity[] = [];
        for (
          const path of JSON.parse(serializedSkillRoots) as string[]
        ) {
          skillMounts.push(
            await canonicalNativePath(path, "PREPARED_SKILL_ROOT_INVALID"),
          );
        }
        assertNativeMountsDoNotOverlapSecrets(
          skillMounts,
          currentRuntime.secretRoots,
          true,
        );
      }
      const definition = definitions[assignment.action];
      if (!definition) {
        throw new NativeExecutorError(
          `WORKER_ACTION_UNSUPPORTED:${assignment.action}`,
        );
      }
      if (signal.aborted) return canceledOutcome();

      const boundaryId = crypto.randomUUID();
      const cgroupPath = identityPath(root, boundaryId);
      const sidecarPath = boundaryFilePath(sidecarDirectory, boundaryId);
      let identity: WorkerExecutionIdentity = {
        type: "cgroup-v2",
        phase: "provisioning",
        boundaryId,
        attemptId: assignment.attemptId,
        assignmentFence: String(assignment.fence),
        cgroupRoot: root,
        cgroupPath,
        sidecarPath,
      };
      try {
        validateIdentity(identity, root, sidecarDirectory);
        await writeJsonAtomically(sidecarPath, identity);
      } catch (error) {
        throw error instanceof NativeExecutorError
          ? error
          : new NativeExecutorError("NATIVE_CGROUP_IDENTITY_PERSIST_FAILED");
      }

      let boundaryCreated = false;
      try {
        await Deno.mkdir(cgroupPath);
        boundaryCreated = true;
        await hooks?.afterCgroupCreated?.(cgroupPath);
        const stat = await lstatDirectory(cgroupPath);
        identity = {
          ...identity,
          phase: "active",
          cgroupDevice: String(stat.dev),
          cgroupInode: String(stat.ino),
        };
        validateIdentity(identity, root, sidecarDirectory);
        await writeJsonAtomically(sidecarPath, identity);
      } catch (error) {
        if (!boundaryCreated) {
          await removeSidecar(sidecarPath).catch(() => undefined);
        } else {
          try {
            await cleanBoundary(
              identity,
              timing,
              Promise.resolve({
                settled: true,
                exitedAt: new Date().toISOString(),
              }),
              hooks,
            );
            await removeSidecar(sidecarPath);
          } catch (cleanupError) {
            throw boundaryFailure(cleanupError);
          }
        }
        if (error instanceof NativeExecutorError) throw error;
        throw new NativeExecutorError("NATIVE_CGROUP_IDENTITY_PERSIST_FAILED");
      }

      let child: Deno.ChildProcess;
      try {
        const currentSkillRoots = await serializePreparedSkillRoots(
          stateDir,
          assignment,
          preparedSkills,
        );
        if (currentSkillRoots !== serializedSkillRoots) {
          throw new NativeExecutorError(
            "PREPARED_SKILL_ROOT_IDENTITY_MISMATCH",
          );
        }
        serializedSkillRoots = currentSkillRoots;
        if (signal.aborted) {
          await cleanBoundary(
            identity,
            timing,
            Promise.resolve({
              settled: true,
              exitedAt: new Date().toISOString(),
            }),
            hooks,
          );
          await removeSidecar(sidecarPath);
          return canceledOutcome();
        }
        const sandbox = actionSandboxSpec(
          definition,
          serializedSkillRoots,
          currentRuntime.mounts,
        );
        child = new Deno.Command(Deno.execPath(), {
          args: nativeBootstrapArgs(sandbox),
          clearEnv: true,
          env: NATIVE_ENVIRONMENT,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
      } catch (error) {
        try {
          await cleanBoundary(
            identity,
            timing,
            Promise.resolve({
              settled: true,
              exitedAt: new Date().toISOString(),
            }),
            hooks,
          );
          await removeSidecar(sidecarPath);
        } catch (cleanupError) {
          throw boundaryFailure(cleanupError);
        }
        if (error instanceof NativeExecutorError) throw error;
        return {
          status: "failed",
          fault: nativeFailure(
            "NATIVE_ACTION_START_FAILED",
            error instanceof Error
              ? error.message
              : "The native action failed.",
          ),
        };
      }
      let attached = false;
      const outputPumps = Promise.all([
        pumpNativeOutput(child.stdout, "stdout", output),
        pumpNativeOutput(child.stderr, "stderr", output),
      ]).then(() => undefined);

      let exitedAt: string | null = null;
      const processStatus = child.status.then(
        () => {
          exitedAt = new Date().toISOString();
          return { settled: true, exitedAt };
        },
        () => ({ settled: false, exitedAt: null }),
      );
      let cleanupPromise: Promise<CleanupResult> | undefined;
      const cleanup = () => {
        cleanupPromise ??= cleanBoundary(
          identity,
          timing,
          processStatus,
          hooks,
        );
        return cleanupPromise;
      };
      const finishCleanup = async (): Promise<CleanupResult> => {
        const result = await cleanup();
        await hooks?.afterCgroupRemoved?.(cgroupPath);
        await removeSidecar(sidecarPath);
        return result;
      };
      const abort = () => {
        void cleanup().catch(() => undefined);
      };
      try {
        await writeCgroupFile(
          `${cgroupPath}/cgroup.procs`,
          `${child.pid}\n`,
          "attach",
          hooks,
          "NATIVE_CGROUP_BOUNDARY_FAILED",
        );
        attached = true;

        const writer = child.stdin.getWriter();
        await writer.write(new Uint8Array([1]));
        await writer.close();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) void cleanup();
        const completion = await Promise.race([
          processStatus,
          signal.aborted
            ? Promise.resolve({ settled: false, exitedAt: null })
            : new Promise<{ settled: false; exitedAt: null }>(() => undefined),
        ]);
        const result = await finishCleanup();
        await drainNativeOutput(outputPumps, output);
        const cancellation = {
          ...result,
          executionIdentity: identity as unknown as JsonValue,
        };
        if (signal.aborted || !completion.settled) {
          return { status: "canceled", cancellation };
        }
        return {
          status: "failed",
          fault: deterministicFailure(assignment),
        };
      } catch (error) {
        if (!attached) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The wrapper may have exited between attach failure and cleanup.
          }
          await processStatus;
        }
        try {
          await finishCleanup();
          await drainNativeOutput(outputPumps, output);
        } catch (cleanupError) {
          throw boundaryFailure(cleanupError);
        }
        throw boundaryFailure(error);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
