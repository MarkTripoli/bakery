import { redactDurableCoreText } from "../tests/e2e/helpers/durable-core/evidence.ts";
import {
  assertDurableCoreBoundaryProof,
  DURABLE_CORE_REQUIRED_CASES,
  type DurableCoreBoundaryProof,
} from "../tests/helpers/durable-core/evidence.ts";

type CommandOptions = {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly clearEnv: true;
  readonly stdin?: string;
};

export type DurableCoreCommandResult = {
  readonly success: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type DurableCoreCommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<DurableCoreCommandResult>;

export type DurableCoreLane = "e2e" | "recovery" | "security";

export type DurableCoreAuditRef = Readonly<{
  readonly id: string;
  readonly organizationId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly operation: string;
  readonly outcome: string;
  readonly requestId: string;
  readonly traceId: string;
}>;

export type DurableCoreCaseRecord =
  & Readonly<Record<string, unknown>>
  & {
    readonly name: string;
    readonly outcome: "passed" | "failed";
    readonly requestId: string;
    readonly traceId: string;
    readonly auditRefs: readonly DurableCoreAuditRef[];
    readonly auditReason?: string;
    readonly terminalResults?: number;
    readonly effects?: number;
    readonly artifacts?: number;
  };

export type DurableCoreLaneResult = {
  readonly lane: DurableCoreLane;
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly outputPath: string;
  readonly cases: readonly DurableCoreCaseRecord[];
};

export type DurableCoreProofManifest = {
  readonly schema: "bakery.durable-core-proof/v1";
  readonly revision: string;
  readonly runId: string;
  readonly proofDirectory: string;
  readonly gateProject: string;
  readonly devContainerProject: string;
  readonly lanes: readonly DurableCoreLaneResult[];
  readonly cases: readonly DurableCoreCaseRecord[];
  readonly boundaries: readonly [
    DurableCoreBoundaryProof,
    DurableCoreBoundaryProof,
  ];
  readonly cleanup: "passed";
};

export type DurableCoreProofFile = {
  readonly text: string;
  readonly isFile: boolean;
  readonly isSymlink: boolean;
  readonly mtimeMs: number;
};

export type DurableCoreProofFileSystem = {
  readonly makeTempDir: () => Promise<string>;
  readonly ensureFreshDirectory: (path: string) => Promise<void>;
  readonly writeText: (
    path: string,
    text: string,
    mode?: number,
  ) => Promise<void>;
  readonly readFile: (path: string) => Promise<DurableCoreProofFile>;
  readonly remove: (path: string) => Promise<void>;
};

export type DurableCoreProofRunOptions = {
  readonly root?: string;
  readonly proofDirectory?: string;
  readonly runner?: DurableCoreCommandRunner;
  readonly fileSystem?: DurableCoreProofFileSystem;
  readonly environment?: Readonly<Record<string, string>>;
};

const LANE_PATHS: Readonly<Record<DurableCoreLane, string>> = {
  e2e:
    "tests/e2e/prove-the-complete-durable-core-after-forced-restarts_test.ts",
  recovery:
    "tests/recovery/prove-the-complete-durable-core-after-forced-restarts_test.ts",
  security:
    "tests/security/prove-the-complete-durable-core-after-forced-restarts_test.ts",
};
const LANES: readonly DurableCoreLane[] = ["e2e", "recovery", "security"];
const REQUIRED_CASES_BY_LANE: Readonly<
  Record<DurableCoreLane, readonly string[]>
> = {
  e2e: DURABLE_CORE_REQUIRED_CASES.slice(0, 5),
  recovery: DURABLE_CORE_REQUIRED_CASES.slice(5, 13),
  security: DURABLE_CORE_REQUIRED_CASES.slice(13),
};
const REQUIRED_SERVICES = [
  "server",
  "inngest",
  "postgres",
  "redis",
] as const;
const MAX_LOG_BYTES = 64 * 1024;
const SIGNAL_CLEANUP_TIMEOUT_MS = 30_000;
const PROOF_FILES = ["worker-boundary.json", "engine-boundary.json"] as const;
const MANIFEST_FILE = "manifest.json";
const DEV_CONTAINER_IMAGE_PREFIX = "bakery-b01-02-devcontainer:proof-";
const DEV_CONTAINER_GIT_MOUNT = "/tmp/bakery-durable-core-git/.git";
const DEV_CONTAINER_GIT_OVERRIDE_FILE = "dev-container-git.override.yml";
const DEV_CONTAINER_COMPOSE_OVERRIDE =
  ".devcontainer/docker-compose.override.yml";
const INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "DENO_DIR",
  "DENO_NO_PROMPT",
  "PNPM_HOME",
  "COREPACK_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "TERM",
] as const;
const POSTGRES_INIT_PATHS = [
  "infra",
  "infra/postgres",
  "infra/postgres/init",
  "infra/postgres/init/001-roles.sh",
] as const;
const EXECUTABLE_SOURCE_PATHS = [
  ".devcontainer",
  "apps",
  "packages",
  "tests",
  "scripts",
  "infra",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "deno.json",
  "deno.lock",
  "turbo.json",
] as const;
const DURABLE_CORE_CASE_FIELDS: Record<string, true> = {
  name: true,
  outcome: true,
  requestId: true,
  traceId: true,
  auditRefs: true,
  auditReason: true,
  terminalResults: true,
  effects: true,
  artifacts: true,
};
const MAX_ERROR_BYTES = 4 * 1024;
const SEMVER_CORE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const COREPACK_INTEGRITY_SUFFIX =
  /^\+(?:sha1\.[0-9a-f]{40}|sha256\.[0-9a-f]{64}|sha384\.[0-9a-f]{96}|sha512\.[0-9a-f]{128})$/;
const DEPENDENCY_BOOTSTRAP_LOG_FILE = "dependency-bootstrap.log";
const CHECKOUT_LOCK_TIMEOUT_MS = 30_000;
const CHECKOUT_LOCK_RETRY_MS = 100;
const CHECKOUT_LOCK_DIRECTORY_NAME = "bakery-durable-core-locks";
const CHECKOUT_LOCK_DIRECTORY_MODE = 0o700;
const CHECKOUT_LOCK_FILE_MODE = 0o600;
type OwnedComposeNetwork = {
  readonly name: string;
  readonly subnet: string;
  readonly internal: boolean;
};

function composeNetworks(
  project: string,
  attempt: number,
): OwnedComposeNetwork[] {
  const seed = Number.parseInt(
    project.split("-").at(-1)?.slice(0, 3) ?? "001",
    16,
  );
  const baseBlock = (seed + attempt * 3) % 4093;
  return [
    { name: "app", internal: false },
    { name: "infra", internal: true },
    { name: "test-access", internal: false },
  ].map(({ name, internal }, index) => {
    const block = baseBlock + index;
    return {
      name: `${project}_${name}`,
      subnet: `10.253.${Math.floor(block / 16)}.${(block % 16) * 16}/28`,
      internal,
    };
  });
}

async function removeOwnedComposeNetworks(
  names: Iterable<string>,
  runner: DurableCoreCommandRunner,
  root: string,
  env: Record<string, string>,
): Promise<void> {
  const failures: Error[] = [];
  for (const name of names) {
    const result = await runner(
      "docker",
      ["network", "rm", name],
      commandOptions(root, env),
    );
    const output = `${result.stdout}${result.stderr}`;
    if (
      !result.success &&
      !/no such network|network .* not found/i.test(output)
    ) {
      failures.push(
        new Error(`DURABLE_CORE_NETWORK_REMOVE_FAILED:${name}:${output}`),
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "DURABLE_CORE_NETWORK_CLEANUP_FAILED");
  }
}

async function createOwnedComposeNetworks(
  project: string,
  runner: DurableCoreCommandRunner,
  root: string,
  env: Record<string, string>,
  owned: Set<string>,
): Promise<void> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const created: string[] = [];
    const networks = composeNetworks(project, attempt);
    for (const network of networks) {
      const result = await runner(
        "docker",
        [
          "network",
          "create",
          "--driver",
          "bridge",
          "--subnet",
          network.subnet,
          ...(network.internal ? ["--internal"] : []),
          "--label",
          `com.docker.compose.project=${project}`,
          "--label",
          `com.docker.compose.network=${
            network.name.slice(project.length + 1)
          }`,
          network.name,
        ],
        commandOptions(root, env),
      );
      if (result.success) {
        created.push(network.name);
        owned.add(network.name);
        continue;
      }
      const output = `${result.stdout}${result.stderr}`;
      let cleanupFailure: unknown;
      try {
        await removeOwnedComposeNetworks(created, runner, root, env);
        for (const name of created) owned.delete(name);
      } catch (error) {
        cleanupFailure = error;
      }
      if (cleanupFailure !== undefined) {
        throw new AggregateError(
          [
            new Error(`DURABLE_CORE_NETWORK_CREATE_FAILED:${output}`),
            cleanupFailure,
          ],
          "DURABLE_CORE_NETWORK_CREATE_AND_CLEANUP_FAILED",
        );
      }
      if (output.includes("Pool overlaps")) break;
      throw new Error(`DURABLE_CORE_NETWORK_CREATE_FAILED:${output}`);
    }
    if (created.length === networks.length) return;
  }
  throw new Error("DURABLE_CORE_NETWORK_CAPACITY_EXHAUSTED");
}

type PermissionSnapshot = {
  readonly path: string;
  readonly mode: string;
  readonly acl: string;
  readonly grantCommand: "chmod" | "setfacl";
  readonly grantArgs: readonly string[];
};

function boundedRedacted(
  value: string,
  maxBytes = MAX_LOG_BYTES,
): string {
  const redacted = redactDurableCoreText(value);
  const bytes = new TextEncoder().encode(redacted);
  if (bytes.byteLength <= maxBytes) return redacted;
  return new TextDecoder().decode(
    bytes.slice(bytes.byteLength - maxBytes),
  );
}

function commandOptions(
  cwd: string,
  env: Record<string, string>,
  stdin?: string,
): CommandOptions {
  return stdin === undefined
    ? { cwd, env, clearEnv: true }
    : { cwd, env, clearEnv: true, stdin };
}
function explicitChildEnvironment(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of INHERITED_ENVIRONMENT_KEYS) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export function errorText(error: unknown): string {
  const render = (
    value: unknown,
    seen: Set<object>,
    depth: number,
  ): string => {
    if (depth >= 8) return "DURABLE_CORE_ERROR_NESTING_LIMIT";
    if (value && typeof value === "object") {
      if (seen.has(value)) return "DURABLE_CORE_ERROR_CIRCULAR";
      seen.add(value);
    }
    if (value instanceof AggregateError) {
      const message = value.message || "DURABLE_CORE_ERROR";
      const nested = value.errors.map((entry, index) =>
        `[${index + 1}] ${render(entry, seen, depth + 1)}`
      ).join("\n");
      return nested
        ? `${message} (nested errors: ${value.errors.length})\n${nested}`
        : message;
    }
    if (value instanceof Error) {
      const message = value.message || "DURABLE_CORE_ERROR";
      const cause = (value as Error & { cause?: unknown }).cause;
      return cause === undefined
        ? message
        : `${message}\ncaused by: ${render(cause, seen, depth + 1)}`;
    }
    if (typeof value === "string") return value;
    return "DURABLE_CORE_UNKNOWN_ERROR";
  };
  return boundedRedacted(render(error, new Set(), 0), MAX_ERROR_BYTES);
}

function createDefaultRunner(
  activeChildren: Set<Deno.ChildProcess>,
): DurableCoreCommandRunner {
  return async (
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<DurableCoreCommandResult> => {
    const process = new Deno.Command("setsid", {
      args: [command, ...args],
      cwd: options.cwd,
      clearEnv: options.clearEnv,
      env: options.env,
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    activeChildren.add(process);
    try {
      if (options.stdin !== undefined) {
        const writer = process.stdin.getWriter();
        await writer.write(new TextEncoder().encode(options.stdin));
        await writer.close();
      }
      const result = await process.output();
      return {
        success: result.success,
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    } finally {
      activeChildren.delete(process);
    }
  };
}

function signalProcessTree(
  child: Deno.ChildProcess,
  signal: Deno.Signal,
): readonly unknown[] {
  const failures: unknown[] = [];
  try {
    Deno.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) failures.push(error);
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) failures.push(error);
  }
  return failures;
}

function assertSafeDirectoryText(path: string): void {
  const segments = path.split("/");
  const hasInteriorEmptySegment = segments.some((segment, index) =>
    index > 0 && segment === ""
  );
  if (
    !path.startsWith("/") ||
    path.trim() === "" ||
    path === "/" ||
    path === "." ||
    path === "./" ||
    segments.includes("..") ||
    segments.includes(".") ||
    hasInteriorEmptySegment
  ) {
    throw new Error("DURABLE_CORE_PROOF_DIRECTORY_UNSAFE");
  }
}

async function ensureFreshProofDirectory(path: string): Promise<void> {
  assertSafeDirectoryText(path);
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  let current = path.startsWith("/") ? "/" : "";
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    current = current === "/" || current === ""
      ? `${current}${segment}`
      : `${current}/${segment}`;
    if ((await Deno.lstat(current)).isSymlink) {
      throw new Error("DURABLE_CORE_PROOF_DIRECTORY_UNSAFE");
    }
  }
  const directory = await Deno.lstat(path);
  if (!directory.isDirectory || directory.isSymlink) {
    throw new Error("DURABLE_CORE_PROOF_DIRECTORY_UNSAFE");
  }
  await Deno.chmod(path, 0o700);
  const privateDirectory = await Deno.stat(path);
  if (((privateDirectory.mode ?? 0) & 0o777) !== 0o700) {
    throw new Error("DURABLE_CORE_PROOF_DIRECTORY_NOT_PRIVATE");
  }
  for await (const entry of Deno.readDir(path)) {
    throw new Error(`DURABLE_CORE_PROOF_PREEXISTING:${entry.name}`);
  }
}

async function writeBoundedLog(
  fileSystem: DurableCoreProofFileSystem,
  path: string,
  result: DurableCoreCommandResult,
): Promise<void> {
  const text = boundedRedacted(`${result.stdout}${result.stderr}`);
  await fileSystem.writeText(path, text, 0o600);
}
function dependencyCommandOutput(
  label: string,
  result: DurableCoreCommandResult,
): string {
  return `${label}\nexit_code=${result.code}\n${result.stdout}${result.stderr}`;
}

async function readRequiredPnpmVersion(root: string): Promise<string> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(
      await Deno.readTextFile(`${root}/package.json`),
    );
  } catch {
    throw new Error("DURABLE_CORE_PNPM_PACKAGE_MANAGER_INVALID");
  }
  if (
    packageJson === null ||
    typeof packageJson !== "object" ||
    Array.isArray(packageJson)
  ) {
    throw new Error("DURABLE_CORE_PNPM_PACKAGE_MANAGER_INVALID");
  }
  const packageManager = (packageJson as Record<string, unknown>)
    .packageManager;
  if (
    typeof packageManager !== "string" ||
    !packageManager.startsWith("pnpm@")
  ) {
    throw new Error("DURABLE_CORE_PNPM_PACKAGE_MANAGER_INVALID");
  }
  const versionAndIntegrity = packageManager.slice("pnpm@".length);
  const integritySeparator = versionAndIntegrity.indexOf("+");
  const versionCore = integritySeparator === -1
    ? versionAndIntegrity
    : versionAndIntegrity.slice(0, integritySeparator);
  const integrity = integritySeparator === -1
    ? undefined
    : versionAndIntegrity.slice(integritySeparator);
  if (
    !SEMVER_CORE.test(versionCore) ||
    (integrity !== undefined && !COREPACK_INTEGRITY_SUFFIX.test(integrity))
  ) {
    throw new Error("DURABLE_CORE_PNPM_PACKAGE_MANAGER_INVALID");
  }
  return versionCore;
}

async function bootstrapWorkspaceDependencies(
  fileSystem: DurableCoreProofFileSystem,
  proofDirectory: string,
  root: string,
  runner: DurableCoreCommandRunner,
  env: Record<string, string>,
): Promise<void> {
  const logPath = `${proofDirectory}/${DEPENDENCY_BOOTSTRAP_LOG_FILE}`;
  const output: string[] = [];
  let requiredPnpmVersion: string;
  try {
    requiredPnpmVersion = await readRequiredPnpmVersion(root);
  } catch (error) {
    output.push(`package.json\n${errorText(error)}`);
    await fileSystem.writeText(
      logPath,
      boundedRedacted(output.join("\n")),
      0o600,
    );
    throw error;
  }
  let version: DurableCoreCommandResult;
  try {
    version = await runner(
      "pnpm",
      ["--version"],
      commandOptions(root, env),
    );
  } catch (error) {
    output.push(`pnpm --version\n${errorText(error)}`);
    await fileSystem.writeText(
      logPath,
      boundedRedacted(output.join("\n")),
      0o600,
    );
    throw new Error("DURABLE_CORE_PNPM_UNAVAILABLE");
  }
  output.push(dependencyCommandOutput("pnpm --version", version));
  if (!version.success) {
    await fileSystem.writeText(
      logPath,
      boundedRedacted(output.join("\n")),
      0o600,
    );
    throw new Error("DURABLE_CORE_PNPM_UNAVAILABLE");
  }
  if (version.stdout.trim() !== requiredPnpmVersion) {
    await fileSystem.writeText(
      logPath,
      boundedRedacted(
        `${output.join("\n")}\nexpected_version=${requiredPnpmVersion}`,
      ),
      0o600,
    );
    throw new Error("DURABLE_CORE_PNPM_VERSION_MISMATCH");
  }
  const installArgs = [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-pnpmfile",
  ] as const;
  let install: DurableCoreCommandResult;
  try {
    install = await runner(
      "pnpm",
      installArgs,
      commandOptions(root, env),
    );
  } catch (error) {
    output.push(`pnpm ${installArgs.join(" ")}\n${errorText(error)}`);
    await fileSystem.writeText(
      logPath,
      boundedRedacted(output.join("\n")),
      0o600,
    );
    throw new Error("DURABLE_CORE_DEPENDENCY_BOOTSTRAP_FAILED");
  }
  output.push(
    dependencyCommandOutput(
      `pnpm ${installArgs.join(" ")}`,
      install,
    ),
  );
  await fileSystem.writeText(
    logPath,
    boundedRedacted(output.join("\n")),
    0o600,
  );
  if (!install.success) {
    throw new Error("DURABLE_CORE_DEPENDENCY_BOOTSTRAP_FAILED");
  }
}

async function capturePermissionSnapshot(
  path: string,
  runner: DurableCoreCommandRunner,
  root: string,
  env: Record<string, string>,
  grantCommand: PermissionSnapshot["grantCommand"],
  grantArgs: readonly string[],
  recursive: boolean,
  label: string,
): Promise<PermissionSnapshot> {
  const stat = await runner(
    "stat",
    ["-c", "%a", path],
    commandOptions(root, env),
  );
  const acl = await runner(
    "getfacl",
    ["-p", ...(recursive ? ["-R"] : []), path],
    commandOptions(root, env),
  );
  if (!stat.success || !acl.success) {
    throw new Error(`DURABLE_CORE_PERMISSION_SNAPSHOT_FAILED:${label}`);
  }
  const mode = stat.stdout.trim();
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new Error(`DURABLE_CORE_PERMISSION_MODE_INVALID:${label}`);
  }
  return {
    path,
    mode,
    acl: acl.stdout,
    grantCommand,
    grantArgs,
  };
}

async function capturePermissionSnapshots(
  root: string,
  runner: DurableCoreCommandRunner,
  env: Record<string, string>,
): Promise<readonly PermissionSnapshot[]> {
  const snapshots: PermissionSnapshot[] = [];
  for (const relativePath of POSTGRES_INIT_PATHS) {
    const path = `${root}/${relativePath}`;
    snapshots.push(
      await capturePermissionSnapshot(
        path,
        runner,
        root,
        env,
        "chmod",
        ["o+rx", path],
        false,
        relativePath,
      ),
    );
  }
  return snapshots;
}

type CheckoutGitDirectories = {
  readonly commonGitDir: string;
  readonly worktreeGitRelative: string;
};

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

async function checkoutGitDirectories(
  root: string,
): Promise<CheckoutGitDirectories> {
  const checkoutRoot = await Deno.realPath(root);
  const dotGit = `${checkoutRoot}/.git`;
  const dotGitInfo = await Deno.lstat(dotGit);
  let worktreeGitDir: string;
  if (dotGitInfo.isFile) {
    const pointer = await Deno.readTextFile(dotGit);
    const match = pointer.match(/^gitdir:\s*(.+?)\s*$/m);
    if (match === null) throw new Error("DURABLE_CORE_GITDIR_INVALID");
    const candidate = match[1]!;
    worktreeGitDir = await Deno.realPath(
      candidate.startsWith("/")
        ? candidate
        : `${parentPath(dotGit)}/${candidate}`,
    );
  } else if (dotGitInfo.isDirectory) {
    worktreeGitDir = await Deno.realPath(dotGit);
  } else {
    throw new Error("DURABLE_CORE_GITDIR_INVALID");
  }

  let commonGitDir = worktreeGitDir;
  try {
    const commondir = (await Deno.readTextFile(
      `${worktreeGitDir}/commondir`,
    )).trim();
    if (commondir !== "") {
      commonGitDir = await Deno.realPath(
        commondir.startsWith("/")
          ? commondir
          : `${worktreeGitDir}/${commondir}`,
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const commonPrefix = `${commonGitDir}/`;
  if (
    worktreeGitDir !== commonGitDir &&
    !worktreeGitDir.startsWith(commonPrefix)
  ) {
    throw new Error("DURABLE_CORE_GITDIR_OUTSIDE_COMMON");
  }
  return {
    commonGitDir,
    worktreeGitRelative: worktreeGitDir === commonGitDir
      ? ""
      : worktreeGitDir.slice(commonPrefix.length),
  };
}

function devContainerGitComposeOverride(
  commonGitDir: string,
  image: string,
): string {
  return [
    "services:",
    "  server:",
    `    image: ${JSON.stringify(image)}`,
    "    volumes:",
    "      - type: bind",
    `        source: ${JSON.stringify(commonGitDir)}`,
    `        target: ${DEV_CONTAINER_GIT_MOUNT}`,
    "        read_only: true",
    "",
  ].join("\n");
}

async function captureDevContainerPermissionSnapshots(
  root: string,
  runner: DurableCoreCommandRunner,
  env: Record<string, string>,
  uid: number,
): Promise<readonly PermissionSnapshot[]> {
  const entries: readonly {
    readonly path: string;
    readonly grant: string;
    readonly recursive: boolean;
    readonly label: string;
  }[] = [
    { path: root, grant: "x", recursive: false, label: "checkout-root" },
    {
      path: `${root}/apps`,
      grant: "x",
      recursive: false,
      label: "apps",
    },
    {
      path: `${root}/apps/server`,
      grant: "rX",
      recursive: true,
      label: "apps/server",
    },
    {
      path: `${root}/packages`,
      grant: "x",
      recursive: false,
      label: "packages",
    },
    {
      path: `${root}/packages/config`,
      grant: "rX",
      recursive: true,
      label: "packages/config",
    },
    {
      path: `${root}/packages/contracts`,
      grant: "rX",
      recursive: true,
      label: "packages/contracts",
    },
    {
      path: `${root}/packages/i18n`,
      grant: "rX",
      recursive: true,
      label: "packages/i18n",
    },
    {
      path: `${root}/packages/persistence`,
      grant: "rX",
      recursive: true,
      label: "packages/persistence",
    },
    {
      path: `${root}/docs`,
      grant: "x",
      recursive: false,
      label: "docs",
    },
    {
      path: `${root}/docs/technical-design`,
      grant: "x",
      recursive: false,
      label: "docs/technical-design",
    },
    {
      path: `${root}/docs/technical-design/api-catalog.json`,
      grant: "r",
      recursive: false,
      label: "docs/technical-design/api-catalog.json",
    },
    {
      path: `${root}/deno.json`,
      grant: "r",
      recursive: false,
      label: "deno.json",
    },
    {
      path: `${root}/deno.lock`,
      grant: "r",
      recursive: false,
      label: "deno.lock",
    },
  ];
  return await Promise.all(
    entries.map((entry) =>
      capturePermissionSnapshot(
        entry.path,
        runner,
        root,
        env,
        "setfacl",
        [
          ...(entry.recursive ? ["-R"] : []),
          "-m",
          `u:${uid}:${entry.grant}`,
          entry.path,
        ],
        entry.recursive,
        entry.label,
      )
    ),
  );
}

async function grantPermissionAccess(
  snapshots: readonly PermissionSnapshot[],
  runner: DurableCoreCommandRunner,
  root: string,
  env: Record<string, string>,
): Promise<void> {
  for (const snapshot of snapshots) {
    const result = await runner(
      snapshot.grantCommand,
      snapshot.grantArgs,
      commandOptions(root, env),
    );
    if (!result.success) {
      throw new Error(`DURABLE_CORE_PERMISSION_GRANT_FAILED:${snapshot.path}`);
    }
  }
}

async function restorePermissionSnapshots(
  snapshots: readonly PermissionSnapshot[],
  runner: DurableCoreCommandRunner,
  root: string,
  env: Record<string, string>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      const mode = await runner(
        "chmod",
        [snapshot.mode, snapshot.path],
        commandOptions(root, env),
      );
      const acl = await runner(
        "setfacl",
        ["--restore=-"],
        commandOptions(root, env, snapshot.acl),
      );
      if (!mode.success || !acl.success) {
        throw new Error(
          `DURABLE_CORE_PERMISSION_RESTORE_FAILED:${snapshot.path}`,
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "DURABLE_CORE_PERMISSION_RESTORE_INCOMPLETE",
    );
  }
}

function gitStatusPaths(output: string): readonly string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4 || line.slice(0, 2) === "  ") continue;
    const raw = line.slice(3);
    const candidates = raw.includes(" -> ") ? raw.split(" -> ") : [raw];
    for (const candidate of candidates) {
      if (candidate.startsWith('"') && candidate.endsWith('"')) {
        try {
          paths.push(JSON.parse(candidate) as string);
          continue;
        } catch {
          // Fall through to the bounded literal path.
        }
      }
      paths.push(candidate);
    }
  }
  return paths;
}

function isExecutableSourcePath(path: string): boolean {
  return EXECUTABLE_SOURCE_PATHS.some((prefix) =>
    path === prefix || path.startsWith(`${prefix}/`)
  );
}

type CheckoutLock = {
  readonly file: Deno.FsFile;
};

// Locks are per user: a shared fixed directory owned by another runner uid
// would fail the owner assertion below.
export function selectCheckoutLockDirectory(
  runtimeDirectory: string | undefined,
  uid: number | null,
): string {
  if (
    runtimeDirectory !== undefined &&
    runtimeDirectory.startsWith("/") &&
    runtimeDirectory !== "/" &&
    !runtimeDirectory.includes("\0")
  ) {
    return `${
      runtimeDirectory.replace(/\/+$/, "")
    }/${CHECKOUT_LOCK_DIRECTORY_NAME}`;
  }
  return `/tmp/${CHECKOUT_LOCK_DIRECTORY_NAME}-${uid ?? "user"}`;
}

// An XDG_RUNTIME_DIR that is missing or not ours is unusable (a runner service
// can inherit another user's value), so selection falls back to the uid path.
function usableRuntimeDirectory(): string | undefined {
  const runtimeDirectory = Deno.env.get("XDG_RUNTIME_DIR");
  if (runtimeDirectory === undefined || !runtimeDirectory.startsWith("/")) {
    return undefined;
  }
  try {
    const info = Deno.statSync(runtimeDirectory);
    return info.isDirectory && info.uid === Deno.uid()
      ? runtimeDirectory
      : undefined;
  } catch {
    return undefined;
  }
}

export function checkoutLockDirectory(): string {
  return selectCheckoutLockDirectory(usableRuntimeDirectory(), Deno.uid());
}

export function assertOwnedPrivatePath(
  info: Deno.FileInfo,
  kind: "directory" | "file",
): void {
  const expectedType = kind === "directory" ? info.isDirectory : info.isFile;
  const currentUid = typeof Deno.uid === "function" ? Deno.uid() : undefined;
  if (
    !expectedType ||
    info.isSymlink ||
    (info.mode ?? 0) & 0o077 ||
    (currentUid !== undefined &&
      info.uid !== null &&
      info.uid !== currentUid)
  ) {
    throw new Error("DURABLE_CORE_CHECKOUT_LOCK_PATH_UNSAFE");
  }
}

export async function ensureCheckoutLockDirectory(
  directory: string = checkoutLockDirectory(),
): Promise<void> {
  try {
    await Deno.mkdir(directory, {
      mode: CHECKOUT_LOCK_DIRECTORY_MODE,
    });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  let info = await Deno.lstat(directory);
  assertOwnedPrivatePath(info, "directory");
  await Deno.chmod(directory, CHECKOUT_LOCK_DIRECTORY_MODE);
  info = await Deno.lstat(directory);
  assertOwnedPrivatePath(info, "directory");
}

function digestHex(digest: ArrayBuffer): string {
  let text = "";
  for (const byte of new Uint8Array(digest)) {
    text += byte.toString(16).padStart(2, "0");
  }
  return text;
}

async function checkoutLockPath(commonGitDir: string): Promise<string> {
  let canonicalCommonGitDir: string;
  try {
    canonicalCommonGitDir = await Deno.realPath(commonGitDir);
  } catch {
    throw new Error("DURABLE_CORE_COMMON_GIT_DIR_UNAVAILABLE");
  }
  if (
    !canonicalCommonGitDir.startsWith("/") ||
    canonicalCommonGitDir === "/" ||
    canonicalCommonGitDir.includes("\0")
  ) {
    throw new Error("DURABLE_CORE_COMMON_GIT_DIR_UNSAFE");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalCommonGitDir),
  );
  return `${checkoutLockDirectory()}/common-git-${digestHex(digest)}.lock`;
}

async function acquireCheckoutLock(path: string): Promise<CheckoutLock> {
  await ensureCheckoutLockDirectory();
  let existing: Deno.FileInfo | undefined;
  try {
    existing = await Deno.lstat(path);
    assertOwnedPrivatePath(existing, "file");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const file = await Deno.open(path, {
    create: true,
    mode: CHECKOUT_LOCK_FILE_MODE,
    read: true,
    write: true,
  });
  try {
    const opened = await file.stat();
    assertOwnedPrivatePath(opened, "file");
    const current = await Deno.lstat(path);
    assertOwnedPrivatePath(current, "file");
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("DURABLE_CORE_CHECKOUT_LOCK_PATH_CHANGED");
    }
    if (
      existing !== undefined && (
        existing.dev !== opened.dev || existing.ino !== opened.ino
      )
    ) {
      throw new Error("DURABLE_CORE_CHECKOUT_LOCK_PATH_CHANGED");
    }

    const deadline = Date.now() + CHECKOUT_LOCK_TIMEOUT_MS;
    while (true) {
      if (await file.tryLock(true)) return { file };
      if (Date.now() >= deadline) {
        throw new Error("DURABLE_CORE_CHECKOUT_LOCK_UNAVAILABLE");
      }
      await delay(CHECKOUT_LOCK_RETRY_MS);
    }
  } catch (error) {
    file.close();
    throw error;
  }
}

async function releaseCheckoutLock(lock: CheckoutLock): Promise<void> {
  try {
    await lock.file.unlock();
  } finally {
    lock.file.close();
  }
}

async function checkoutRevision(
  root: string,
  runner: DurableCoreCommandRunner,
  env: Record<string, string>,
): Promise<string> {
  const result = await runner(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    commandOptions(root, env),
  );
  const revision = result.stdout.trim().toLowerCase();
  if (!result.success || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("DURABLE_CORE_REVISION_UNAVAILABLE");
  }
  const status = await runner(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    commandOptions(root, env),
  );
  if (!status.success) {
    throw new Error("DURABLE_CORE_SOURCE_STATUS_UNAVAILABLE");
  }
  const dirtySourcePaths = gitStatusPaths(status.stdout).filter(
    isExecutableSourcePath,
  );
  if (dirtySourcePaths.length > 0) {
    throw new Error("DURABLE_CORE_EXECUTABLE_SOURCE_DIRTY");
  }
  return revision;
}

async function readBoundaryProof(
  fileSystem: DurableCoreProofFileSystem,
  path: string,
  revision: string,
  startedAt: number,
): Promise<DurableCoreBoundaryProof> {
  const info = await fileSystem.readFile(path);
  if (!info.isFile || info.isSymlink) {
    throw new Error(`DURABLE_CORE_PROOF_FILE_UNSAFE:${path}`);
  }
  if (info.mtimeMs < startedAt) {
    throw new Error(`DURABLE_CORE_PROOF_STALE:${path}`);
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(info.text);
  } catch (error) {
    throw new Error(
      `DURABLE_CORE_PROOF_JSON_INVALID:${path}:${errorText(error)}`,
    );
  }
  assertDurableCoreBoundaryProof(candidate, { revision });
  return candidate;
}

function assertNoSecretLeak(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  if (
    typeof serialized !== "string" ||
    redactDurableCoreText(serialized) !== serialized
  ) {
    throw new Error(`DURABLE_CORE_SECRET_LEAK:${label}`);
  }
}

const AUDIT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIT_OBJECT_FIELDS = [
  "id",
  "resourceId",
  "requestId",
  "traceId",
  "organizationId",
  "resourceType",
  "operation",
  "outcome",
] as const;

function nonemptyCaseText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
    throw new Error(`DURABLE_CORE_CASE_${field.toUpperCase()}_INVALID`);
  }
  return value;
}

function normalizeAuditRefs(
  value: unknown,
): readonly DurableCoreAuditRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("DURABLE_CORE_CASE_AUDIT_REFS_INVALID");
  }
  return value.map((ref) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new Error("DURABLE_CORE_CASE_AUDIT_REF_INVALID");
    }
    const source = ref as Record<string, unknown>;
    if (
      Object.keys(source).length !== AUDIT_OBJECT_FIELDS.length ||
      AUDIT_OBJECT_FIELDS.some((field) =>
        !Object.prototype.hasOwnProperty.call(source, field)
      )
    ) {
      throw new Error("DURABLE_CORE_CASE_AUDIT_REF_INVALID");
    }
    const normalized: Record<string, string> = {};
    for (const field of AUDIT_OBJECT_FIELDS) {
      const fieldValue = source[field];
      if (
        typeof fieldValue !== "string" ||
        fieldValue.trim() === "" ||
        fieldValue.length > 512
      ) {
        throw new Error("DURABLE_CORE_CASE_AUDIT_REF_INVALID");
      }
      if (
        (field === "id" || field === "organizationId" ||
          field === "resourceId") &&
        !AUDIT_UUID.test(fieldValue)
      ) {
        throw new Error("DURABLE_CORE_CASE_AUDIT_REF_INVALID");
      }
      normalized[field] = fieldValue;
    }
    return normalized as DurableCoreAuditRef;
  });
}

function normalizeCaseRecord(
  candidate: unknown,
): DurableCoreCaseRecord {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("DURABLE_CORE_CASE_FAILED_OR_INVALID");
  }
  const source = candidate as Record<string, unknown>;
  for (const field of Object.keys(source)) {
    if (DURABLE_CORE_CASE_FIELDS[field] !== true) {
      throw new Error("DURABLE_CORE_CASE_UNKNOWN_FIELD");
    }
  }
  if (
    typeof source.name !== "string" ||
    !DURABLE_CORE_REQUIRED_CASES.includes(
      source.name as typeof DURABLE_CORE_REQUIRED_CASES[number],
    ) ||
    source.outcome !== "passed"
  ) {
    throw new Error("DURABLE_CORE_CASE_FAILED_OR_INVALID");
  }
  const requestId = nonemptyCaseText(source.requestId, "request_id");
  const traceId = nonemptyCaseText(source.traceId, "trace_id");
  const auditRefs = Array.isArray(source.auditRefs)
    ? source.auditRefs
    : (() => {
      throw new Error("DURABLE_CORE_CASE_AUDIT_REFS_INVALID");
    })();
  const isRecovery = REQUIRED_CASES_BY_LANE.recovery.includes(source.name);
  const isSecurity = REQUIRED_CASES_BY_LANE.security.includes(source.name);
  const normalizedAuditRefs = auditRefs.length === 0
    ? []
    : normalizeAuditRefs(auditRefs);
  if (normalizedAuditRefs.length === 0) {
    if (
      !isSecurity ||
      typeof source.auditReason !== "string" ||
      source.auditReason.trim() === ""
    ) {
      throw new Error("DURABLE_CORE_CASE_AUDIT_REFS_REQUIRED");
    }
  } else {
    if (source.auditReason !== undefined) {
      throw new Error("DURABLE_CORE_CASE_AUDIT_REASON_INVALID");
    }
    for (const auditRef of normalizedAuditRefs) {
      if (
        auditRef.requestId !== requestId ||
        auditRef.traceId !== traceId
      ) {
        throw new Error("DURABLE_CORE_CASE_AUDIT_IDENTITY_MISMATCH");
      }
    }
  }
  if (isRecovery && normalizedAuditRefs.length === 0) {
    throw new Error("DURABLE_CORE_RECOVERY_AUDIT_REFS_REQUIRED");
  }
  if (
    source.auditReason !== undefined &&
    (!isSecurity || typeof source.auditReason !== "string" ||
      source.auditReason.trim() === "")
  ) {
    throw new Error("DURABLE_CORE_CASE_AUDIT_REASON_INVALID");
  }
  const record: Record<string, unknown> = {
    name: source.name,
    outcome: "passed",
    requestId,
    traceId,
    auditRefs: normalizedAuditRefs,
    ...(source.auditReason === undefined
      ? {}
      : { auditReason: source.auditReason as string }),
  };
  for (const field of ["terminalResults", "effects", "artifacts"] as const) {
    const value = source[field];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`DURABLE_CORE_CASE_${field.toUpperCase()}_INVALID`);
      }
      record[field] = value as number;
    }
  }
  assertNoSecretLeak(record, `case:${record.name}`);
  return record as DurableCoreCaseRecord;
}

function casesFromOutput(output: string): DurableCoreCaseRecord[] {
  const cases: DurableCoreCaseRecord[] = [];
  const add = (candidate: unknown): void => {
    cases.push(normalizeCaseRecord(candidate));
  };
  for (const line of output.split("\n")) {
    const protocol = line.match(/DURABLE_CORE_PROTOCOL_CASE\s+(\{.*\})/);
    if (protocol) add(JSON.parse(protocol[1]!));
    const evidence = line.match(/DURABLE_CORE_EVIDENCE\s+(\{.*\})/);
    if (evidence) {
      const parsed = JSON.parse(evidence[1]!) as Record<string, unknown>;
      if (!Array.isArray(parsed.cases)) {
        throw new Error("DURABLE_CORE_EVIDENCE_CASES_MISSING");
      }
      for (const item of parsed.cases) add(item);
    }
    const caseLine = line.match(/DURABLE_CORE_CASE\s+(\{.*\})/);
    if (caseLine) add(JSON.parse(caseLine[1]!));
  }
  return cases;
}

function assertRequiredCases(cases: readonly DurableCoreCaseRecord[]): void {
  if (cases.length !== DURABLE_CORE_REQUIRED_CASES.length) {
    throw new Error("DURABLE_CORE_CASES_INCOMPLETE");
  }
  const observed = new Set<string>();
  for (const record of cases) {
    normalizeCaseRecord(record);
    if (observed.has(record.name)) {
      throw new Error(`DURABLE_CORE_CASE_DUPLICATE:${record.name}`);
    }
    observed.add(record.name);
  }
  const missing = DURABLE_CORE_REQUIRED_CASES.filter((name) =>
    !observed.has(name)
  );
  if (missing.length > 0) {
    throw new Error(`DURABLE_CORE_CASES_MISSING:${missing.join(",")}`);
  }
}

function assertLaneCases(
  lane: DurableCoreLane,
  cases: readonly DurableCoreCaseRecord[],
): void {
  const expected = REQUIRED_CASES_BY_LANE[lane];
  if (cases.length !== expected.length) {
    throw new Error(`DURABLE_CORE_LANE_CASES_INCOMPLETE:${lane}`);
  }
  const observed = cases.map((record) => record.name);
  if (
    new Set(observed).size !== observed.length ||
    [...observed].sort().join(",") !== [...expected].sort().join(",")
  ) {
    throw new Error(`DURABLE_CORE_LANE_CASES_MISMATCH:${lane}`);
  }
  for (const record of cases) normalizeCaseRecord(record);
}

function validateManifest(
  manifest: DurableCoreProofManifest,
  revision: string,
  runId: string,
): void {
  if (manifest.schema !== "bakery.durable-core-proof/v1") {
    throw new Error("DURABLE_CORE_MANIFEST_SCHEMA_INVALID");
  }
  if (manifest.revision !== revision || manifest.runId !== runId) {
    throw new Error("DURABLE_CORE_MANIFEST_IDENTITY_MISMATCH");
  }
  if (
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(manifest.gateProject) ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(manifest.devContainerProject) ||
    manifest.gateProject === manifest.devContainerProject
  ) {
    throw new Error("DURABLE_CORE_MANIFEST_PROJECTS_INVALID");
  }
  if (
    manifest.cleanup !== "passed" ||
    manifest.lanes.length !== LANES.length ||
    manifest.lanes.map((lane) => lane.lane).join(",") !== LANES.join(",")
  ) {
    throw new Error("DURABLE_CORE_MANIFEST_INCOMPLETE");
  }
  for (const lane of manifest.lanes) {
    assertLaneCases(lane.lane, lane.cases);
  }
  assertRequiredCases(manifest.cases);
  const laneCases = manifest.lanes.flatMap((lane) => lane.cases);
  if (
    laneCases.length !== manifest.cases.length ||
    laneCases.some((record, index) =>
      JSON.stringify(record) !== JSON.stringify(manifest.cases[index])
    )
  ) {
    throw new Error("DURABLE_CORE_MANIFEST_CASES_MISMATCH");
  }
  const kinds = manifest.boundaries.map((proof) => proof.kind).sort();
  if (kinds.join(",") !== "engine,worker") {
    throw new Error("DURABLE_CORE_MANIFEST_BOUNDARIES_INCOMPLETE");
  }
  const boundaryRunIds = new Set(
    manifest.boundaries.map((proof) => proof.runId),
  );
  if (
    boundaryRunIds.size !== manifest.boundaries.length ||
    boundaryRunIds.has(manifest.runId)
  ) {
    throw new Error("DURABLE_CORE_MANIFEST_BOUNDARY_RUNS_NOT_DISTINCT");
  }
  for (const proof of manifest.boundaries) {
    assertDurableCoreBoundaryProof(proof, { revision });
    assertNoSecretLeak(proof, `boundary:${proof.kind}`);
  }
  assertNoSecretLeak(manifest, "manifest");
}

async function readProofFile(path: string): Promise<DurableCoreProofFile> {
  const info = await Deno.lstat(path);
  return {
    text: await Deno.readTextFile(path),
    isFile: info.isFile,
    isSymlink: info.isSymlink,
    mtimeMs: info.mtime?.getTime() ?? 0,
  };
}

async function removeIfPresent(
  fileSystem: DurableCoreProofFileSystem,
  path: string,
): Promise<void> {
  try {
    await fileSystem.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

const defaultFileSystem: DurableCoreProofFileSystem = {
  makeTempDir: () => Deno.makeTempDir({ prefix: "bakery-durable-core-" }),
  ensureFreshDirectory: ensureFreshProofDirectory,
  writeText: (path, text, mode = 0o600) =>
    Deno.writeTextFile(path, text, { mode }),
  readFile: readProofFile,
  remove: (path) => Deno.remove(path),
};

export async function runDurableCoreProof(
  options: DurableCoreProofRunOptions = {},
): Promise<DurableCoreProofManifest> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const root = options.root ?? Deno.cwd();
  const activeChildren = new Set<Deno.ChildProcess>();
  const runner = options.runner ?? createDefaultRunner(activeChildren);
  const proofDirectory = options.proofDirectory ??
    Deno.env.get("BAKERY_DURABLE_CORE_PROOF_DIR") ??
    await fileSystem.makeTempDir();
  assertSafeDirectoryText(proofDirectory);
  await fileSystem.ensureFreshDirectory(proofDirectory);
  const devContainerGitOverridePath =
    `${proofDirectory}/${DEV_CONTAINER_GIT_OVERRIDE_FILE}`;

  const env = explicitChildEnvironment(
    options.environment ?? Deno.env.toObject(),
  );
  const runId = crypto.randomUUID();
  Object.assign(env, {
    BAKERY_DURABLE_CORE_PROOF_DIR: proofDirectory,
    BAKERY_DURABLE_CORE_RUN_ID: runId,
    BAKERY_SERVER_PORT: "0",
    BAKERY_POSTGRES_PORT: "0",
    BAKERY_INNGEST_PORT: "0",
    BAKERY_LOCAL_BAKERY_PASSWORD: `bakery-${crypto.randomUUID()}`,
    BAKERY_LOCAL_APP_PASSWORD: `app-${crypto.randomUUID()}`,
    BAKERY_LOCAL_INNGEST_PASSWORD: `inngest-${crypto.randomUUID()}`,
    BAKERY_LOCAL_POSTGRES_PASSWORD: `postgres-${crypto.randomUUID()}`,
    BAKERY_LOCAL_REDIS_PASSWORD: `redis-${crypto.randomUUID()}`,
    BETTER_AUTH_SECRET: `durable-core-${crypto.randomUUID()}`,
    BAKERY_INNGEST_EVENT_KEY: `event-${crypto.randomUUID()}`,
    BAKERY_INNGEST_SIGNING_KEY: crypto.randomUUID().replaceAll("-", ""),
  });
  const recoveryEnv = { ...env, TMPDIR: proofDirectory };
  const gitDirectories = await checkoutGitDirectories(root);
  const checkoutLockName = await checkoutLockPath(
    gitDirectories.commonGitDir,
  );
  const devContainerImage = `${DEV_CONTAINER_IMAGE_PREFIX}${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  const startedAt = Date.now();
  const gateProject = `bakery-durable-core-gate-${crypto.randomUUID()}`;
  const devContainerProject = `bakery-durable-core-dev-${crypto.randomUUID()}`;
  const gateCompose = [
    "compose",
    "--project-name",
    gateProject,
    "-f",
    "infra/compose.yaml",
  ] as const;
  const devContainerCompose = [
    "compose",
    "--project-name",
    devContainerProject,
    "-f",
    "infra/compose.yaml",
    "-f",
    DEV_CONTAINER_COMPOSE_OVERRIDE,
    "-f",
    devContainerGitOverridePath,
  ] as const;
  let gateStarted = false;
  let devContainerStarted = false;
  let devContainerImageBuilt = false;
  let devContainerImageId: string | undefined;
  let checkoutLock: CheckoutLock | undefined;
  let permissionSnapshots: readonly PermissionSnapshot[] = [];
  let failure: unknown;
  let manifest: DurableCoreProofManifest | undefined;
  const laneResults: DurableCoreLaneResult[] = [];
  const observedCaseRecords: DurableCoreCaseRecord[] = [];
  const ownedNetworkNames = new Set<string>();
  let cleanupPromise: Promise<void> | undefined;
  let interruptedSignal: Deno.Signal | undefined;

  const cleanupResources = async (): Promise<void> => {
    if (cleanupPromise !== undefined) return await cleanupPromise;
    cleanupPromise = (async () => {
      const failures: unknown[] = [];
      const children = [...activeChildren];
      for (const child of children) {
        failures.push(...signalProcessTree(child, "SIGTERM"));
      }
      if (children.length > 0) {
        await Promise.race([
          Promise.allSettled(children.map((child) => child.status)),
          delay(1_000),
        ]);
      }
      const survivors = children.filter((child) => activeChildren.has(child));
      for (const child of survivors) {
        failures.push(...signalProcessTree(child, "SIGKILL"));
      }
      if (survivors.length > 0) {
        await Promise.race([
          Promise.allSettled(survivors.map((child) => child.status)),
          delay(1_000),
        ]);
      }
      if (survivors.some((child) => activeChildren.has(child))) {
        failures.push(new Error("DURABLE_CORE_CHILD_CLEANUP_TIMEOUT"));
      }

      const composeProjects: readonly {
        readonly started: boolean;
        readonly compose: readonly string[];
        readonly envFile?: string;
      }[] = [
        {
          started: devContainerStarted,
          compose: devContainerCompose,
        },
        {
          started: gateStarted,
          compose: gateCompose,
          envFile: `${root}/.env.${gateProject}`,
        },
      ];
      for (const project of composeProjects) {
        if (!project.started) continue;
        try {
          const cleanup = await runner(
            "docker",
            [...project.compose, "down", "--volumes", "--remove-orphans"],
            commandOptions(root, env),
          );
          if (!cleanup.success) {
            throw new Error("DURABLE_CORE_CLEANUP_FAILED");
          }
        } catch (error) {
          failures.push(error);
        }
        if (project.envFile !== undefined) {
          try {
            await removeIfPresent(fileSystem, project.envFile);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      try {
        await removeIfPresent(fileSystem, devContainerGitOverridePath);
      } catch (error) {
        failures.push(error);
      }
      if (ownedNetworkNames.size > 0) {
        try {
          await removeOwnedComposeNetworks(
            ownedNetworkNames,
            runner,
            root,
            env,
          );
          ownedNetworkNames.clear();
        } catch (error) {
          failures.push(error);
        }
      }
      if (devContainerImageBuilt) {
        try {
          const imageCleanup = await runner(
            "docker",
            ["image", "rm", "--force", devContainerImage],
            commandOptions(root, env),
          );
          if (!imageCleanup.success) {
            throw new Error("DURABLE_CORE_IMAGE_CLEANUP_FAILED");
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (permissionSnapshots.length > 0) {
        try {
          await restorePermissionSnapshots(
            permissionSnapshots,
            runner,
            root,
            env,
          );
        } catch (error) {
          failures.push(error);
        }
      }
      if (checkoutLock !== undefined) {
        try {
          await releaseCheckoutLock(checkoutLock);
        } catch (error) {
          failures.push(error);
        } finally {
          checkoutLock = undefined;
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "DURABLE_CORE_CLEANUP_INCOMPLETE");
      }
    })();
    return await cleanupPromise;
  };

  const handleSignal = (signal: Deno.Signal): void => {
    if (interruptedSignal !== undefined) return;
    interruptedSignal = signal;
    void (async () => {
      try {
        await Promise.race([
          cleanupResources(),
          delay(SIGNAL_CLEANUP_TIMEOUT_MS).then(() => {
            throw new Error("DURABLE_CORE_SIGNAL_CLEANUP_TIMEOUT");
          }),
        ]);
      } catch (error) {
        console.error(boundedRedacted(errorText(error)));
      }
      Deno.exit(signal === "SIGINT" ? 130 : 143);
    })();
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  Deno.addSignalListener("SIGINT", onSigint);
  Deno.addSignalListener("SIGTERM", onSigterm);

  try {
    checkoutLock = await acquireCheckoutLock(checkoutLockName);
    const lockedGitDirectories = await checkoutGitDirectories(root);
    if (
      lockedGitDirectories.commonGitDir !== gitDirectories.commonGitDir ||
      lockedGitDirectories.worktreeGitRelative !==
        gitDirectories.worktreeGitRelative
    ) {
      throw new Error("DURABLE_CORE_GITDIR_CHANGED");
    }
    const revision = await checkoutRevision(root, runner, env);
    await bootstrapWorkspaceDependencies(
      fileSystem,
      proofDirectory,
      root,
      runner,
      env,
    );
    const devContainerGitDir = gitDirectories.worktreeGitRelative === ""
      ? DEV_CONTAINER_GIT_MOUNT
      : `${DEV_CONTAINER_GIT_MOUNT}/${gitDirectories.worktreeGitRelative}`;
    await fileSystem.writeText(
      devContainerGitOverridePath,
      devContainerGitComposeOverride(
        gitDirectories.commonGitDir,
        devContainerImage,
      ),
      0o600,
    );
    const postgresPermissionSnapshots = await capturePermissionSnapshots(
      root,
      runner,
      env,
    );
    permissionSnapshots = postgresPermissionSnapshots;
    await grantPermissionAccess(
      postgresPermissionSnapshots,
      runner,
      root,
      env,
    );
    const docker = await runner(
      "docker",
      ["info"],
      commandOptions(root, env),
    );
    if (!docker.success) throw new Error("DURABLE_CORE_DOCKER_UNAVAILABLE");
    const composeConfig = await runner(
      "docker",
      ["compose", "-f", "infra/compose.yaml", "config", "--quiet"],
      commandOptions(root, env),
    );
    if (!composeConfig.success) throw new Error("DURABLE_CORE_COMPOSE_INVALID");
    const devContainerConfig = await runner(
      "docker",
      [...devContainerCompose, "config", "--quiet"],
      commandOptions(root, env),
    );
    if (!devContainerConfig.success) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_COMPOSE_INVALID");
    }
    const devContainerBuild = await runner(
      "docker",
      [
        "build",
        "--file",
        ".devcontainer/Dockerfile",
        "--tag",
        devContainerImage,
        ".devcontainer",
      ],
      commandOptions(root, env),
    );
    if (!devContainerBuild.success) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_IMAGE_BUILD_FAILED");
    }
    devContainerImageBuilt = true;
    const devContainerImageInspect = await runner(
      "docker",
      [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        devContainerImage,
      ],
      commandOptions(root, env),
    );
    const builtImageId = devContainerImageInspect.stdout.trim().toLowerCase();
    if (
      !devContainerImageInspect.success ||
      !/^sha256:[0-9a-f]{64}$/.test(builtImageId)
    ) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_IMAGE_ID_UNAVAILABLE");
    }
    devContainerImageId = builtImageId;
    const devContainerIdentity = await runner(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "id",
        devContainerImageId,
        "-u",
      ],
      commandOptions(root, env),
    );
    const devContainerUidText = devContainerIdentity.stdout.trim();
    const devContainerUid = Number(devContainerUidText);
    if (
      !devContainerIdentity.success ||
      !/^[0-9]+$/.test(devContainerUidText) ||
      !Number.isSafeInteger(devContainerUid) ||
      devContainerUid < 0
    ) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_UID_UNAVAILABLE");
    }
    const hostUid = Deno.uid();
    if (
      hostUid === null ||
      !Number.isSafeInteger(hostUid) ||
      hostUid < 0
    ) {
      throw new Error("DURABLE_CORE_HOST_UID_UNAVAILABLE");
    }

    await createOwnedComposeNetworks(
      gateProject,
      runner,
      root,
      env,
      ownedNetworkNames,
    );
    gateStarted = true;
    const gate = await runner(
      "bash",
      [
        "scripts/dev/compose-up.sh",
        gateProject,
        "postgres",
        "redis",
        "inngest",
        "server",
      ],
      commandOptions(root, env),
    );
    const gateOutputPath = `${proofDirectory}/compose-gate.log`;
    if (!gate.success) {
      const logs = await runner(
        "docker",
        [...gateCompose, "logs", "--no-color", "--tail", "200"],
        commandOptions(root, env),
      );
      await fileSystem.writeText(
        gateOutputPath,
        boundedRedacted(
          `${gate.stdout}${gate.stderr}\n${logs.stdout}${logs.stderr}`,
        ),
        0o600,
      );
      throw new Error("DURABLE_CORE_COMPOSE_HEALTH_FAILED");
    }
    await fileSystem.writeText(
      gateOutputPath,
      boundedRedacted(`${gate.stdout}${gate.stderr}`),
      0o600,
    );
    const services = await runner(
      "docker",
      [
        ...gateCompose,
        "ps",
        "--status",
        "running",
        "--services",
      ],
      commandOptions(root, env),
    );
    const running = new Set(services.stdout.split(/\s+/).filter(Boolean));
    const missing = REQUIRED_SERVICES.filter((service) =>
      !running.has(service)
    );
    if (!services.success || missing.length > 0) {
      const logs = await runner(
        "docker",
        [...gateCompose, "logs", "--no-color", "--tail", "200"],
        commandOptions(root, env),
      );
      await fileSystem.writeText(
        gateOutputPath,
        boundedRedacted(
          `${gate.stdout}${gate.stderr}\n${logs.stdout}${logs.stderr}`,
        ),
        0o600,
      );
      throw new Error(`DURABLE_CORE_SERVICES_UNHEALTHY:${missing.join(",")}`);
    }
    const devPermissionSnapshots = await captureDevContainerPermissionSnapshots(
      root,
      runner,
      env,
      devContainerUid,
    );
    permissionSnapshots = [
      ...permissionSnapshots,
      ...devPermissionSnapshots,
    ];
    await grantPermissionAccess(
      devPermissionSnapshots,
      runner,
      root,
      env,
    );
    const devContainerOutputPath = `${proofDirectory}/dev-container-gate.log`;
    await createOwnedComposeNetworks(
      devContainerProject,
      runner,
      root,
      env,
      ownedNetworkNames,
    );
    devContainerStarted = true;
    const devGate = await runner(
      "docker",
      [...devContainerCompose, "up", "-d", "--wait", "server"],
      commandOptions(root, env),
    );
    if (!devGate.success) {
      const logs = await runner(
        "docker",
        [...devContainerCompose, "logs", "--no-color", "--tail", "200"],
        commandOptions(root, env),
      );
      await fileSystem.writeText(
        devContainerOutputPath,
        boundedRedacted(
          `${devGate.stdout}${devGate.stderr}\n${logs.stdout}${logs.stderr}`,
        ),
        0o600,
      );
      throw new Error("DURABLE_CORE_DEV_CONTAINER_HEALTH_FAILED");
    }
    const devContainerIdResult = await runner(
      "docker",
      [...devContainerCompose, "ps", "-q", "server"],
      commandOptions(root, env),
    );
    const devContainerId = devContainerIdResult.stdout.trim().toLowerCase();
    if (
      !devContainerIdResult.success ||
      !/^[0-9a-f]{12,64}$/.test(devContainerId)
    ) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_ID_UNAVAILABLE");
    }
    const runningImageResult = await runner(
      "docker",
      ["inspect", "--format", "{{.Image}}", devContainerId],
      commandOptions(root, env),
    );
    const runningImageId = runningImageResult.stdout.trim().toLowerCase();
    if (
      !runningImageResult.success ||
      devContainerImageId === undefined ||
      runningImageId !== devContainerImageId
    ) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_IMAGE_MISMATCH");
    }
    await fileSystem.writeText(
      devContainerOutputPath,
      boundedRedacted(`${devGate.stdout}${devGate.stderr}`),
      0o600,
    );
    const devServices = await runner(
      "docker",
      [
        ...devContainerCompose,
        "ps",
        "--status",
        "running",
        "--services",
      ],
      commandOptions(root, env),
    );
    if (
      !devServices.success ||
      !new Set(devServices.stdout.split(/\s+/).filter(Boolean)).has("server")
    ) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_SERVICE_UNHEALTHY");
    }
    const devContainerHostIdentity = await runner(
      "docker",
      [
        ...devContainerCompose,
        "exec",
        "-T",
        "--user",
        String(hostUid),
        "server",
        "id",
        "-u",
      ],
      commandOptions(root, env),
    );
    const devContainerHostUidText = devContainerHostIdentity.stdout.trim();
    if (
      !devContainerHostIdentity.success ||
      devContainerHostUidText !== String(hostUid)
    ) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_HOST_UID_MISMATCH");
    }
    const devRevision = await runner(
      "docker",
      [
        ...devContainerCompose,
        "exec",
        "-T",
        "--user",
        String(hostUid),
        "server",
        "git",
        "-c",
        "safe.directory=/workspace",
        "--git-dir",
        devContainerGitDir,
        "--work-tree",
        "/workspace",
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ],
      commandOptions(root, env),
    );
    const devRevisionText = devRevision.stdout.trim().toLowerCase();
    if (!devRevision.success || !/^[0-9a-f]{40}$/.test(devRevisionText)) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_REVISION_UNAVAILABLE");
    }
    if (devRevisionText !== revision) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_REVISION_MISMATCH");
    }
    const devContainerCleanup = await runner(
      "docker",
      [
        ...devContainerCompose,
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      commandOptions(root, env),
    );
    if (!devContainerCleanup.success) {
      throw new Error("DURABLE_CORE_DEV_CONTAINER_CLEANUP_FAILED");
    }
    devContainerStarted = false;
    await removeIfPresent(fileSystem, devContainerGitOverridePath);

    for (const lane of LANES) {
      const path = LANE_PATHS[lane];
      const args = [`test:${lane}`, "--", path];
      const laneEnvironment = lane === "recovery" ? recoveryEnv : env;
      const result = await runner(
        "pnpm",
        args,
        commandOptions(root, laneEnvironment),
      );
      const outputPath = `${proofDirectory}/${lane}.log`;
      await writeBoundedLog(fileSystem, outputPath, result);
      const cases = casesFromOutput(`${result.stdout}${result.stderr}`);
      assertLaneCases(lane, cases);
      observedCaseRecords.push(...cases);
      laneResults.push({
        lane,
        command: "pnpm",
        args,
        exitCode: result.code,
        outputPath,
        cases,
      });
      if (!result.success) {
        throw new Error(`DURABLE_CORE_LANE_FAILED:${lane}:${result.code}`);
      }
    }
    assertRequiredCases(observedCaseRecords);

    const boundaryPaths = PROOF_FILES.map((file) =>
      `${proofDirectory}/${file}`
    );
    const worker = await readBoundaryProof(
      fileSystem,
      boundaryPaths[0]!,
      revision,
      startedAt,
    );
    const engine = await readBoundaryProof(
      fileSystem,
      boundaryPaths[1]!,
      revision,
      startedAt,
    );
    assertDurableCoreBoundaryProof(worker, { revision });
    assertDurableCoreBoundaryProof(engine, { revision });
    const finalRevision = await checkoutRevision(root, runner, env);
    if (finalRevision !== revision) {
      throw new Error("DURABLE_CORE_REVISION_CHANGED");
    }
    const manifestCases = [...observedCaseRecords].sort((left, right) =>
      DURABLE_CORE_REQUIRED_CASES.indexOf(
        left.name as typeof DURABLE_CORE_REQUIRED_CASES[number],
      ) -
      DURABLE_CORE_REQUIRED_CASES.indexOf(
        right.name as typeof DURABLE_CORE_REQUIRED_CASES[number],
      )
    );
    manifest = {
      schema: "bakery.durable-core-proof/v1",
      revision,
      runId,
      proofDirectory,
      gateProject,
      devContainerProject,
      lanes: laneResults,
      cases: manifestCases,
      boundaries: worker.kind === "worker" && engine.kind === "engine"
        ? [worker, engine]
        : (() => {
          throw new Error("DURABLE_CORE_BOUNDARY_KIND_MISMATCH");
        })(),
      cleanup: "passed",
    };
    validateManifest(manifest, revision, runId);
  } catch (error) {
    failure = error;
  }

  let cleanupFailure: unknown;
  try {
    await cleanupResources();
  } catch (error) {
    cleanupFailure = error;
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.removeSignalListener("SIGTERM", onSigterm);
  }
  if (failure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [failure, cleanupFailure],
      "DURABLE_CORE_PROOF_FAILED",
    );
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (!manifest) throw new Error("DURABLE_CORE_MANIFEST_MISSING");
  await fileSystem.writeText(
    `${proofDirectory}/${MANIFEST_FILE}`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600,
  );
  return manifest;
}

if (import.meta.main) {
  if (Deno.args.length !== 0) {
    console.error("durable-core proving command accepts no flags");
    Deno.exit(2);
  }
  try {
    const manifest = await runDurableCoreProof();
    console.log(
      `DURABLE_CORE_PROOF_PASSED revision=${manifest.revision} ` +
        `${manifest.proofDirectory}/${MANIFEST_FILE}`,
    );
  } catch (error) {
    console.error(errorText(error));
    Deno.exit(1);
  }
}
