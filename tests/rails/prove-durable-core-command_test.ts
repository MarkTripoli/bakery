import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { redactDurableCoreText } from "../../tests/e2e/helpers/durable-core/evidence.ts";
import {
  assertDurableCoreBoundaryProof,
  DURABLE_CORE_REQUIRED_CASES,
} from "../../tests/helpers/durable-core/evidence.ts";
import {
  assertOwnedPrivatePath,
  checkoutLockDirectory,
  type DurableCoreCommandResult,
  type DurableCoreProofFile,
  type DurableCoreProofFileSystem,
  type DurableCoreProofManifest,
  type DurableCoreProofRunOptions,
  ensureCheckoutLockDirectory,
  errorText,
  runDurableCoreProof,
  selectCheckoutLockDirectory,
} from "../../scripts/prove-durable-core.ts";

const DURABLE_CORE_CHILD_ENV = "BAKERY_ISSUE_43_DURABLE_CORE_CHILD";
const IS_DURABLE_CORE_CHILD = Deno.env.get(DURABLE_CORE_CHILD_ENV) === "1";
const DURABLE_CORE_TEMP_DIRECTORY = Deno.env.get("TMPDIR") ??
  Deno.env.get("TMP") ??
  Deno.env.get("TEMP") ??
  "/tmp";

function registerDurableCoreTest(
  name: string,
  test: () => void | Promise<void>,
): void {
  if (IS_DURABLE_CORE_CHILD) Deno.test(name, test);
}

function spawnDurableCoreChild(): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--allow-read",
      "--allow-env",
      "--allow-run",
      // Checkout locks must keep one stable path across different TMPDIRs.
      `--allow-write=${DURABLE_CORE_TEMP_DIRECTORY},${checkoutLockDirectory()}`,
      "--allow-sys=uid",
      new URL(import.meta.url).pathname,
    ],
    env: {
      ...Deno.env.toObject(),
      TMPDIR: DURABLE_CORE_TEMP_DIRECTORY,
      [DURABLE_CORE_CHILD_ENV]: "1",
    },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
}

if (!IS_DURABLE_CORE_CHILD) {
  Deno.test("durable-core Rails behavior runs in an isolated child", async () => {
    const child = spawnDurableCoreChild();
    const status = await child.status;
    if (!status.success) {
      throw new Error(`durable-core child exited with code ${status.code}`);
    }
  });
}

registerDurableCoreTest(
  "durable-core checkout lock directory is per user",
  () => {
    assertEquals(
      selectCheckoutLockDirectory("/run/user/1000", 1000),
      "/run/user/1000/bakery-durable-core-locks",
    );
    assertEquals(
      selectCheckoutLockDirectory("/run/user/1000/", 1000),
      "/run/user/1000/bakery-durable-core-locks",
    );
    for (const unusable of [undefined, "", "relative/run", "/"]) {
      assertEquals(
        selectCheckoutLockDirectory(unusable, 1234),
        "/tmp/bakery-durable-core-locks-1234",
      );
    }
    assert(
      selectCheckoutLockDirectory(undefined, 1) !==
        selectCheckoutLockDirectory(undefined, 2),
    );
  },
);

registerDurableCoreTest(
  "durable-core checkout lock directory stays strictly private",
  async () => {
    const uid = Deno.uid() ?? 0;
    const base = {
      isDirectory: true,
      isFile: false,
      isSymlink: false,
      mode: 0o700,
      uid,
    } as Deno.FileInfo;
    assertOwnedPrivatePath(base, "directory");
    for (
      const unsafe of [
        { uid: uid + 1 },
        { mode: 0o770 },
        { mode: 0o707 },
        { isSymlink: true },
        { isDirectory: false, isFile: true },
      ]
    ) {
      assertThrows(
        () => assertOwnedPrivatePath({ ...base, ...unsafe }, "directory"),
        Error,
        "DURABLE_CORE_CHECKOUT_LOCK_PATH_UNSAFE",
      );
    }

    const root = await Deno.makeTempDir({ dir: DURABLE_CORE_TEMP_DIRECTORY });
    try {
      const open = `${root}/open`;
      await Deno.mkdir(open, { mode: 0o755 });
      await Deno.chmod(open, 0o770);
      await assertRejects(
        () => ensureCheckoutLockDirectory(open),
        Error,
        "DURABLE_CORE_CHECKOUT_LOCK_PATH_UNSAFE",
      );
      assertEquals((await Deno.stat(open)).mode! & 0o777, 0o770);

      const fresh = `${root}/fresh`;
      await ensureCheckoutLockDirectory(fresh);
      assertEquals((await Deno.stat(fresh)).mode! & 0o777, 0o700);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

registerDurableCoreTest(
  "durable-core child scopes scratch writes to its selected temporary directory",
  async () => {
    assertEquals(Deno.env.get("TMPDIR"), DURABLE_CORE_TEMP_DIRECTORY);
    assert(
      (await Deno.permissions.query({ name: "write" })).state !== "granted",
    );
    assert(
      (await Deno.permissions.query({
        name: "write",
        path: `${DURABLE_CORE_TEMP_DIRECTORY}/../durable-core-unscoped`,
      })).state !== "granted",
    );
    const directory = await Deno.makeTempDir({ prefix: "durable-core-scope-" });
    try {
      const root = await Deno.realPath(DURABLE_CORE_TEMP_DIRECTORY);
      assert((await Deno.realPath(directory)).startsWith(`${root}/`));
      await Deno.writeTextFile(`${directory}/allowed.txt`, "scoped");
      assertEquals(
        await Deno.readTextFile(`${directory}/allowed.txt`),
        "scoped",
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
);

const REVISION = "a".repeat(40);
const FIXTURE_PNPM_VERSION = "10.33.0";
const COREPACK_SHA512_PNPM_10_33_0 =
  "10568bb4a6afb58c9eb3630da90cc9516417abebd3fabbe6739f0ae795728da1491e9db5a544c76ad8eb7570f5c4bb3d6c637b2cb41bfdcdb47fa823c8649319";
const COREPACK_SHA1_PNPM_10_33_0 = "46a0bef28aad690765997ab6da6d5475bdd4148e";
const DIGEST = "b".repeat(64);
const UUIDS = {
  artifact: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  attemptOld: "33333333-3333-4333-8333-333333333333",
  attemptNew: "44444444-4444-4444-8444-444444444444",
  sessionOld: "55555555-5555-4555-8555-555555555555",
  sessionNew: "66666666-6666-4666-8666-666666666666",
  checkpoint: "77777777-7777-4777-8777-777777777777",
  replacementCheckpoint: "88888888-8888-4888-8888-888888888888",
  terminal: "99999999-9999-4999-8999-999999999999",
  workerRun: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  engineRun: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  task: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  runStep: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  job: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  functionDefinition: "12121212-1212-4121-8121-121212121212",
  recoveryTriggerFunctionDefinition: "13131313-1313-4131-8131-131313131313",
  recoveryTriggerFunctionRun: "abababab-abab-4aba-8bab-abababababab",
  audit: "14141414-1414-4141-8141-141414141414",
} as const;
const ARTIFACT = {
  artifactId: UUIDS.artifact,
  versionId: UUIDS.version,
  sha256: DIGEST,
};
const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function journalObservation(
  attemptId: string,
  eventId: string,
  ackedLocalSeq: string,
  nextLocalSeq: string,
) {
  return {
    kind: "journal" as const,
    checkpointAttemptId: attemptId,
    checkpointEventId: eventId,
    checkpointLocalSeq: "3" as const,
    checkpointAckedLocalSeq: ackedLocalSeq,
    nextLocalSeq,
  };
}

function spoolObservation(
  attemptId: string,
  eventId: string,
  fence: string,
  ackedLocalSeq: string,
  nextLocalSeq: string,
  absent = false,
) {
  return {
    kind: "spool" as const,
    spoolState: absent ? "absent" as const : "present" as const,
    ...(absent ? {} : {
      checkpointAttemptId: attemptId,
      checkpointEventId: eventId,
      checkpointLocalSeq: "3" as const,
    }),
    checkpointAckedLocalSeq: absent ? null : ackedLocalSeq,
    nextLocalSeq: absent ? null : nextLocalSeq,
    version: 1,
    recordCount: absent ? 0 : 1,
    records: absent ? [] : [{
      attemptId,
      eventId,
      localSeq: "3",
      fence,
      kind: "event",
      type: "job.checkpoint",
    }],
  };
}
function engineObservation(
  runId: string,
  processId: string,
  functionRunId: string,
  functionEventId: string,
  functionEventInternalId: string,
  ownerGeneration: string,
  recoveryMode?: "natural" | "reconciliation",
) {
  return {
    processId,
    runId,
    organizationId: ORGANIZATION_ID,
    outboxStatus: "delivered" as const,
    engineEventId: "outbox-event-1",
    functionRunId,
    functionEventId,
    functionEventInternalId,
    functionDefinitionId: UUIDS.functionDefinition,
    runStatus: "running",
    engineOwnerPresent: true as const,
    engineOwnerGeneration: ownerGeneration,
    jobStatus: "running",
    checkpointEventId: UUIDS.checkpoint,
    checkpointAttemptId: UUIDS.attemptNew,
    checkpointLocalSeq: "3" as const,
    checkpointAckedLocalSeq: "3" as const,
    observedAt: recoveryMode === undefined
      ? "2026-09-26T00:00:00.000Z"
      : "2026-09-26T00:00:01.000Z",
    ...(recoveryMode === undefined ? {} : {
      recoveryMode,
      recoveryFunctionRunId: functionRunId,
      recoveryFunctionEventId: functionEventId,
      recoveryFunctionDefinitionId: UUIDS.functionDefinition,
      recoveryFunctionRunStartedAt: "2026-09-26T00:00:00.500Z",
      recoveryInvocationCount: 1,
      ...(recoveryMode === "reconciliation"
        ? {
          recoveryEventId: "recovery-event-1",
          recoveryEventInternalId: "abc123",
          recoveryTriggerFunctionId: "bakery-server-bakery-workflow-recovery",
          recoveryTriggerFunctionDefinitionId:
            UUIDS.recoveryTriggerFunctionDefinition,
          recoveryTriggerFunctionRunId: UUIDS.recoveryTriggerFunctionRun,
          recoveryTriggerFunctionEventId: "recovery-event-1",
        }
        : {}),
    }),
  };
}

function boundary(
  kind: "worker" | "engine",
  runId: string,
  recoveryMode: "natural" | "reconciliation" = "reconciliation",
) {
  const checkpointAttemptId = kind === "worker"
    ? UUIDS.attemptOld
    : UUIDS.attemptNew;
  const terminalAttemptId = kind === "worker"
    ? UUIDS.attemptNew
    : UUIDS.attemptNew;
  return {
    kind,
    revision: REVISION,
    configuration: {
      project: kind === "worker" ? "proof-worker" : "proof-engine",
      ports: { server: 31001, postgres: 31002, inngest: 31003 },
    },
    runId,
    effectKey: "effect-1",
    checkpoint: {
      jobId: UUIDS.job,
      runId,
      runStepId: UUIDS.runStep,
      attemptId: checkpointAttemptId,
      fence: "7",
      workerSessionId: UUIDS.sessionOld,
      workerSessionGeneration: "2",
      eventId: UUIDS.checkpoint,
      localSeq: "3" as const,
      ackedLocalSeq: "3" as const,
      artifactRef: ARTIFACT,
    },
    ...(kind === "worker"
      ? {
        replacementAttempt: {
          attemptId: UUIDS.attemptNew,
          fence: "8",
          workerSessionId: UUIDS.sessionNew,
          workerSessionGeneration: "3",
          checkpointEventId: UUIDS.replacementCheckpoint,
          checkpointLocalSeq: "3" as const,
        },
        secondCheckpoint: {
          attemptId: UUIDS.attemptNew,
          eventId: UUIDS.replacementCheckpoint,
          localSeq: "3" as const,
          ackedLocalSeq: "3" as const,
          artifactRef: ARTIFACT,
        },
      }
      : {}),
    restart: {
      service: kind === "worker" ? "worker" as const : "inngest" as const,
      beforeProcessId: "100",
      afterProcessId: "200",
    },
    terminal: {
      jobId: UUIDS.job,
      attemptId: terminalAttemptId,
      eventId: UUIDS.terminal,
      taskId: UUIDS.task,
      runId,
      runStepId: UUIDS.runStep,
      taskStatus: "completed",
      runStatus: "completed",
      runStepStatus: "completed",
      terminalTaskCount: 1 as const,
      terminalRunCount: 1 as const,
      terminalStepCount: 1 as const,
      acceptedCount: 1 as const,
      effectCount: 1 as const,
      artifactCount: 1 as const,
    },
    artifact: {
      ref: ARTIFACT,
      sha256: DIGEST,
      verifiedSha256: DIGEST,
    },
    observations: {
      journalBefore: journalObservation(
        checkpointAttemptId,
        UUIDS.checkpoint,
        kind === "engine" ? "3" : "2",
        kind === "engine" ? "4" : "3",
      ),
      journalAfter: journalObservation(
        UUIDS.attemptNew,
        kind === "worker" ? UUIDS.replacementCheckpoint : UUIDS.checkpoint,
        "3",
        "4",
      ),
      spoolBefore: spoolObservation(
        checkpointAttemptId,
        UUIDS.checkpoint,
        "7",
        "3",
        "4",
      ),
      spoolAfter: spoolObservation(
        UUIDS.attemptNew,
        kind === "worker" ? UUIDS.replacementCheckpoint : UUIDS.checkpoint,
        kind === "worker" ? "8" : "7",
        "3",
        "4",
        true,
      ),
      ...(kind === "engine"
        ? {
          engineBefore: engineObservation(
            runId,
            "100",
            "run-a",
            "function-event-before",
            "100",
            "2",
          ),
          engineAfter: engineObservation(
            runId,
            "200",
            "run-b",
            "function-event-after",
            "200",
            "3",
            recoveryMode,
          ),
        }
        : {}),
    },
  };
}

function inMemoryFileSystem(): {
  readonly fileSystem: DurableCoreProofFileSystem;
  readonly files: Map<string, DurableCoreProofFile>;
  readonly modes: Map<string, number>;
  readonly directoryModes: Map<string, number>;
} {
  const files = new Map<string, DurableCoreProofFile>();
  const directories = new Set<string>();
  const modes = new Map<string, number>();
  const directoryModes = new Map<string, number>();
  const fileSystem: DurableCoreProofFileSystem = {
    makeTempDir: () => Promise.resolve("/tmp/durable-core-rails"),
    ensureFreshDirectory: (path) => {
      if (directories.has(path) && files.size > 0) {
        throw new Error("DURABLE_CORE_PROOF_PREEXISTING");
      }
      directories.add(path);
      directoryModes.set(path, 0o700);
      return Promise.resolve();
    },
    writeText: (path, text, mode = 0o600) => {
      modes.set(path, mode);
      files.set(path, {
        text,
        isFile: true,
        isSymlink: false,
        mtimeMs: Date.now() + 100,
      });
      return Promise.resolve();
    },
    readFile: (path) => {
      const file = files.get(path);
      if (!file) throw new Error(`NOT_FOUND:${path}`);
      return Promise.resolve(file);
    },
    remove: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
  };
  return { fileSystem, files, modes, directoryModes };
}

type AuditVariant =
  | "missing-id"
  | "extra-field"
  | "mismatched-request"
  | "empty-recovery"
  | "legacy-string";

function outputCases(
  names: readonly string[],
  options: {
    readonly includeExtraCaseField?: boolean;
    readonly auditVariant?: AuditVariant;
  } = {},
): string {
  return names.map((name) => {
    const requestId = `request-${name}`;
    const traceId = `trace-${name}`;
    const isSecurity = names.includes("foreign-run-reference") &&
      DURABLE_CORE_REQUIRED_CASES.slice(13).some((caseName) =>
        caseName === name
      );
    const auditRef: Record<string, string> = {
      id: UUIDS.audit,
      organizationId: ORGANIZATION_ID,
      resourceType: "job_attempt",
      resourceId: UUIDS.attemptNew,
      operation: "durable_core.case",
      outcome: "succeeded",
      requestId,
      traceId,
    };
    if (
      options.auditVariant === "missing-id" &&
      name === "persisted-checkpoint"
    ) {
      delete auditRef.id;
    }
    if (
      options.auditVariant === "extra-field" &&
      name === "persisted-checkpoint"
    ) {
      auditRef.unexpected = "reject this field";
    }
    if (
      options.auditVariant === "mismatched-request" &&
      name === "persisted-checkpoint"
    ) {
      auditRef.requestId = "request-does-not-match-case";
    }
    const emptyRecovery = options.auditVariant === "empty-recovery" &&
      name === "persisted-checkpoint";
    const legacyString = options.auditVariant === "legacy-string" &&
      name === "persisted-checkpoint";
    return `DURABLE_CORE_CASE ${
      JSON.stringify({
        name,
        outcome: "passed",
        requestId,
        traceId,
        ...(isSecurity
          ? {
            auditRefs: [],
            auditReason:
              "security denial has no database audit row by contract",
          }
          : {
            auditRefs: emptyRecovery
              ? []
              : legacyString
              ? [UUIDS.audit]
              : [auditRef],
          }),
        ...(name === "duplicate"
          ? { terminalResults: 1, effects: 1, artifacts: 1 }
          : {}),
        ...(options.includeExtraCaseField && name === "duplicate"
          ? { unexpected: "reject this field" }
          : {}),
      })
    }`;
  }).join("\n");
}
async function readFixturePnpmVersion(root: string): Promise<string> {
  const packageJson = JSON.parse(
    await Deno.readTextFile(`${root}/package.json`),
  ) as { readonly packageManager?: unknown };
  assert(
    typeof packageJson.packageManager === "string" &&
      packageJson.packageManager.startsWith("pnpm@"),
  );
  const version = packageJson.packageManager.slice("pnpm@".length);
  return version.split("+", 1)[0]!;
}

function fakeRunner(
  fileSystem: DurableCoreProofFileSystem,
  options: {
    readonly writeBoundaries: boolean;
    readonly failLane?: string;
    readonly expectedPath?: string;
    readonly gitRevisions?: readonly string[];
    readonly gitStatus?: string;
    readonly events?: string[];
    readonly failDevContainerBuild?: boolean;
    readonly failPnpmVersion?: boolean;
    readonly pnpmVersion?: string;
    readonly failDependencyBootstrap?: boolean;
    readonly dependencyBootstrapOutput?: string;
    readonly assertFreshNodeModules?: boolean;
    readonly missingBaseService?: string;
    readonly missingDevContainerServer?: boolean;
    readonly devComposeInvalid?: boolean;
    readonly devImageMismatch?: boolean;
    readonly devHostUidMismatch?: boolean;
    readonly devRevision?: string;
    readonly devRevisionUnavailable?: boolean;
    readonly extraCaseField?: boolean;
    readonly auditVariant?: AuditVariant;
  },
  calls: string[],
): (
  command: string,
  args: readonly string[],
  commandOptions: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly clearEnv: true;
  },
) => Promise<DurableCoreCommandResult> {
  let gitRevisionIndex = 0;
  return async (command, args, commandOptions) => {
    options.events?.push(`${command}:${args.join(" ")}`);
    assertEquals(commandOptions.clearEnv, true);
    assertEquals(commandOptions.env.DURABLE_CORE_NONSECRET_CANARY, undefined);
    assertEquals(commandOptions.env.OPENAI_API_KEY, undefined);
    assertEquals(commandOptions.env.ANTHROPIC_API_KEY, undefined);
    assertEquals(commandOptions.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert(commandOptions.env.BAKERY_LOCAL_BAKERY_PASSWORD !== "caller-secret");
    if (options.expectedPath !== undefined) {
      assertEquals(commandOptions.env.PATH, options.expectedPath);
    }
    if (command === "git") {
      if (args[0] === "status") {
        return {
          success: true,
          code: 0,
          stdout: options.gitStatus ?? "",
          stderr: "",
        };
      }
      const revision = options.gitRevisions?.[gitRevisionIndex++] ??
        REVISION;
      return { success: true, code: 0, stdout: `${revision}\n`, stderr: "" };
    }
    if (["stat", "getfacl", "chmod", "setfacl"].includes(command)) {
      return {
        success: true,
        code: 0,
        stdout: command === "stat" ? "700\n" : "acl\n",
        stderr: "",
      };
    }
    if (command === "docker") {
      if (args[0] === "build" && options.failDevContainerBuild) {
        return {
          success: false,
          code: 1,
          stdout: "",
          stderr: "image build failed",
        };
      }
      if (
        args[0] === "image" &&
        args[1] === "inspect"
      ) {
        return {
          success: true,
          code: 0,
          stdout: `sha256:${"d".repeat(64)}\n`,
          stderr: "",
        };
      }
      if (args[0] === "run" && args.includes("id")) {
        return {
          success: true,
          code: 0,
          stdout: "1993\n",
          stderr: "",
        };
      }
      if (args[0] === "inspect") {
        return {
          success: true,
          code: 0,
          stdout: `sha256:${
            options.devImageMismatch ? "e".repeat(64) : "d".repeat(64)
          }\n`,
          stderr: "",
        };
      }
      if (
        options.devComposeInvalid &&
        args.includes(".devcontainer/docker-compose.override.yml") &&
        args.includes("config")
      ) {
        return {
          success: false,
          code: 1,
          stdout: "",
          stderr: "dev compose invalid",
        };
      }
      if (args.includes("id") && args.includes("-u")) {
        const uid = Deno.uid() ?? 0;
        return {
          success: true,
          code: 0,
          stdout: `${options.devHostUidMismatch ? (uid ?? -1) + 1 : uid}\n`,
          stderr: "",
        };
      }
      if (args.includes("exec")) {
        return {
          success: !options.devRevisionUnavailable,
          code: options.devRevisionUnavailable ? 1 : 0,
          stdout: options.devRevisionUnavailable
            ? ""
            : `${options.devRevision ?? REVISION}\n`,
          stderr: options.devRevisionUnavailable ? "revision unavailable" : "",
        };
      }
      if (args.includes("ps") && args.includes("-q")) {
        return {
          success: true,
          code: 0,
          stdout: "abcdef123456\n",
          stderr: "",
        };
      }
      if (args.includes("ps")) {
        const projectIndex = args.indexOf("--project-name");
        const project = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
        const services = [
          "server",
          "inngest",
          "postgres",
          "redis",
        ].filter((service) =>
          !(
            (project?.startsWith("bakery-durable-core-gate-") &&
              service === options.missingBaseService) ||
            (project?.startsWith("bakery-durable-core-dev-") &&
              options.missingDevContainerServer &&
              service === "server")
          )
        );
        return {
          success: true,
          code: 0,
          stdout: `${services.join("\n")}\n`,
          stderr: "",
        };
      }
      return { success: true, code: 0, stdout: "", stderr: "" };
    }
    if (command === "pnpm" && args[0] === "--version") {
      const success = !options.failPnpmVersion;
      return {
        success,
        code: success ? 0 : 1,
        stdout: success
          ? `${
            options.pnpmVersion ??
              await readFixturePnpmVersion(commandOptions.cwd)
          }\n`
          : "",
        stderr: success ? "" : "pnpm unavailable",
      };
    }
    if (command === "pnpm" && args[0] === "install") {
      if (options.assertFreshNodeModules) {
        let alreadyExists = false;
        try {
          await Deno.lstat(`${commandOptions.cwd}/node_modules`);
          alreadyExists = true;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        assert(!alreadyExists);
        await Deno.mkdir(`${commandOptions.cwd}/node_modules`);
      }
      const success = !options.failDependencyBootstrap;
      return {
        success,
        code: success ? 0 : 1,
        stdout: success ? "dependencies installed\n" : "",
        stderr: success
          ? ""
          : options.dependencyBootstrapOutput ?? "dependency bootstrap failed",
      };
    }

    if (command === "bash") {
      return {
        success: true,
        code: 0,
        stdout:
          "gate ready postgresql://bakery:canary-db-secret@db:5432/bakery\n",
        stderr: "",
      };
    }
    assertEquals(command, "pnpm");
    const lane = args[0]!.replace("test:", "");
    calls.push(lane);
    const gateRunId = commandOptions.env.BAKERY_DURABLE_CORE_RUN_ID!;
    if (lane === "recovery" && options.writeBoundaries) {
      await fileSystem.writeText(
        `${commandOptions.env.BAKERY_DURABLE_CORE_PROOF_DIR}/worker-boundary.json`,
        JSON.stringify(boundary("worker", UUIDS.workerRun)),
      );
      await fileSystem.writeText(
        `${commandOptions.env.BAKERY_DURABLE_CORE_PROOF_DIR}/engine-boundary.json`,
        JSON.stringify(boundary("engine", UUIDS.engineRun)),
      );
      assert(gateRunId !== UUIDS.workerRun && gateRunId !== UUIDS.engineRun);
    }
    const names = lane === "e2e"
      ? DURABLE_CORE_REQUIRED_CASES.slice(0, 5)
      : lane === "recovery"
      ? DURABLE_CORE_REQUIRED_CASES.slice(5, 13)
      : DURABLE_CORE_REQUIRED_CASES.slice(13);
    const success = options.failLane !== lane;
    return {
      success,
      code: success ? 0 : 1,
      stdout: `${
        outputCases(names, {
          includeExtraCaseField: options.extraCaseField,
          auditVariant: options.auditVariant,
        })
      }\npostgresql://bakery:canary-db-secret@db:5432/bakery`,
      stderr: success ? "" : "lane failed",
    };
  };
}

type LockSmokeObservation = {
  readonly ready: Promise<void>;
  readonly output: () => string;
};

function spawnLockSmokeChild(
  root: string,
  proofDirectory: string,
  revision: string,
): Deno.ChildProcess {
  const moduleUrl = new URL(
    "../../scripts/prove-durable-core.ts",
    import.meta.url,
  ).href;
  const source = [
    `import { runDurableCoreProof } from ${JSON.stringify(moduleUrl)};`,
    `const root = ${JSON.stringify(root)};`,
    `const proofDirectory = ${JSON.stringify(proofDirectory)};`,
    `const revision = ${JSON.stringify(revision)};`,
    "const runner = async (command, args) => {",
    '  if (command === "git") {',
    '    if (args[0] === "status") {',
    '      console.log("REVISION_STATUS_CHECKED");',
    '      return { success: true, code: 0, stdout: "", stderr: "" };',
    "    }",
    '    return { success: true, code: 0, stdout: `${revision}\\n`, stderr: "" };',
    "  }",
    '  if (command === "pnpm" && args[0] === "--version") {',
    "    const packageJson = JSON.parse(await Deno.readTextFile(`${root}/package.json`));",
    '    return { success: true, code: 0, stdout: `${packageJson.packageManager.slice("pnpm@".length)}\\n`, stderr: "" };',
    "  }",
    '  if (command === "pnpm" && args[0] === "install") {',
    '    return { success: true, code: 0, stdout: "dependencies installed\\n", stderr: "" };',
    "  }",
    '  if (command === "stat") {',
    '    console.log("LOCK_READY");',
    "    setInterval(() => {}, 60_000);",
    "    await Promise.withResolvers().promise;",
    "  }",
    '  if (command === "getfacl") {',
    '    return { success: true, code: 0, stdout: "acl\\n", stderr: "" };',
    "  }",
    '  if (command === "chmod" || command === "setfacl") {',
    '    return { success: true, code: 0, stdout: "", stderr: "" };',
    "  }",
    '  console.log("UNEXPECTED_COMPOSE");',
    '  return { success: false, code: 1, stdout: "", stderr: "unexpected" };',
    "};",
    "await runDurableCoreProof({ root, proofDirectory, runner });",
  ].join("\n");
  return new Deno.Command(Deno.execPath(), {
    args: ["eval", source],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

function observeLockSmokeChild(child: Deno.ChildProcess): LockSmokeObservation {
  if (child.stdout === null) throw new Error("LOCK_SMOKE_STDOUT_UNAVAILABLE");
  let output = "";
  const readyResolver = Promise.withResolvers<void>();
  const ready = readyResolver.promise;
  let readySeen = false;
  void (async () => {
    const reader = child.stdout!.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        output += decoder.decode(result.value, { stream: true });
        if (!readySeen && output.includes("LOCK_READY")) {
          readySeen = true;
          readyResolver.resolve();
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return { ready, output: () => output };
}

async function readyWithin(
  observation: LockSmokeObservation,
  milliseconds: number,
): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>();
  setTimeout(() => timeout.resolve(false), milliseconds);
  return await Promise.race([
    observation.ready.then(() => true),
    timeout.promise,
  ]);
}

async function stopLockSmokeChild(
  child: Deno.ChildProcess | undefined,
): Promise<Deno.CommandStatus | undefined> {
  if (child === undefined) return undefined;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return await child.status;
}
async function runExternalCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string>;
    readonly stdin?: string;
  },
): Promise<DurableCoreCommandResult> {
  const child = new Deno.Command(command, {
    args: [...args],
    cwd: options.cwd,
    clearEnv: options.env !== undefined,
    env: options.env,
    stdin: options.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  const output = await child.output();
  return {
    success: output.success,
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

async function removeProbePath(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function assertScopedRecoveryTempDirectory(
  proofDirectory: string,
): Promise<void> {
  const outsidePath =
    `${DURABLE_CORE_TEMP_DIRECTORY}/bakery-durable-core-rails-unscoped-${crypto.randomUUID()}`;
  const probePath = `${proofDirectory}/recovery-temp-probe.ts`;
  const code = [
    `const proofDirectory = ${JSON.stringify(`${proofDirectory}/`)};`,
    "const temp = await Deno.makeTempDir();",
    "if (!temp.startsWith(proofDirectory)) {",
    '  throw new Error("DURABLE_CORE_RECOVERY_TMPDIR_NOT_USED");',
    "}",
    'await Deno.writeTextFile(`${temp}/helper.txt`, "ok");',
    "let denied = false;",
    "try {",
    `  await Deno.writeTextFile(${JSON.stringify(outsidePath)}, "forbidden");`,
    "} catch (error) {",
    "  denied = error instanceof Deno.errors.NotCapable;",
    "}",
    'if (!denied) throw new Error("DURABLE_CORE_RECOVERY_WRITE_SCOPE_BYPASSED");',
  ].join("\n");
  try {
    await Deno.writeTextFile(probePath, code);
    const result = await runExternalCommand(
      Deno.execPath(),
      [
        "run",
        "--no-config",
        `--allow-read=${probePath}`,
        "--allow-env=TMPDIR",
        `--allow-write=${proofDirectory}`,
        probePath,
      ],
      {
        cwd: proofDirectory,
        env: { TMPDIR: proofDirectory },
      },
    );
    assert(result.success, result.stderr || result.stdout);
  } finally {
    for (const path of [probePath, outsidePath]) {
      await removeProbePath(path);
    }
  }
}

async function createIsolatedCheckoutFixture(
  pnpmVersion = FIXTURE_PNPM_VERSION,
): Promise<string> {
  const root = await Deno.makeTempDir({
    prefix: "bakery-durable-core-rails-checkout-",
  });
  const result = await runExternalCommand(
    "git",
    ["init", "--quiet", "--initial-branch=main"],
    { cwd: root },
  );
  if (!result.success) {
    await Deno.remove(root, { recursive: true });
    throw new Error(`git init failed: ${result.stderr}`);
  }
  await Deno.writeTextFile(
    `${root}/package.json`,
    `${
      JSON.stringify({
        name: "durable-core-rails-fixture",
        private: true,
        packageManager: `pnpm@${pnpmVersion}`,
      })
    }\n`,
  );
  return root;
}

async function runDurableCoreProofInFixture(
  options: Omit<DurableCoreProofRunOptions, "root">,
  pnpmVersion = FIXTURE_PNPM_VERSION,
): Promise<DurableCoreProofManifest> {
  const root = await createIsolatedCheckoutFixture(pnpmVersion);
  try {
    return await runDurableCoreProof({ ...options, root });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function snapshotActualAcl(path: string): Promise<string> {
  const result = await runExternalCommand("getfacl", ["-p", "-R", path], {
    cwd: "/tmp",
  });
  if (!result.success) {
    throw new Error(`getfacl failed: ${result.stderr}`);
  }
  return result.stdout;
}

registerDurableCoreTest(
  "ordinary and linked worktrees serialize the common Git lock and restore source ACLs",
  async () => {
    const fixtureDirectory = await Deno.makeTempDir({
      prefix: "bakery-durable-core-linked-worktrees-",
    });
    const sourceDirectory = `${fixtureDirectory}/source`;
    const firstRoot = `${fixtureDirectory}/worktree-a`;
    const secondRoot = `${fixtureDirectory}/worktree-b`;
    const files = [
      ".devcontainer/Dockerfile",
      "apps/server/src/main.ts",
      "packages/config/src/index.ts",
      "packages/contracts/src/index.ts",
      "packages/i18n/src/index.ts",
      "packages/persistence/src/index.ts",
      "docs/technical-design/api-catalog.json",
      "deno.json",
      "deno.lock",
      "infra/postgres/init/001-roles.sh",
      "package.json",
    ] as const;
    let firstProof: Promise<unknown> | undefined;
    let secondProof: Promise<unknown> | undefined;
    const enteredFirstLane = Promise.withResolvers<void>();
    const releaseFirstLane = Promise.withResolvers<void>();
    const eventsByRoot = new Map<string, string[]>();
    try {
      await Deno.mkdir(sourceDirectory, { recursive: true });
      for (const path of files) {
        const fullPath = `${sourceDirectory}/${path}`;
        await Deno.mkdir(fullPath.slice(0, fullPath.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(
          fullPath,
          path === "package.json"
            ? `${
              JSON.stringify({
                name: "durable-core-linked-worktree-fixture",
                private: true,
                packageManager: `pnpm@${FIXTURE_PNPM_VERSION}`,
              })
            }\n`
            : path.endsWith("api-catalog.json")
            ? "{}\n"
            : "fixture\n",
        );
      }
      for (
        const args of [
          ["init", "--quiet", "--initial-branch=main"],
          ["config", "user.email", "durable-core-test@example.invalid"],
          ["config", "user.name", "durable-core-test"],
          ["add", "."],
          ["commit", "--quiet", "-m", "fixture"],
        ] as const
      ) {
        const result = await runExternalCommand("git", args, {
          cwd: sourceDirectory,
        });
        assert(result.success, result.stderr);
      }
      for (const root of [firstRoot, secondRoot]) {
        const result = await runExternalCommand(
          "git",
          ["worktree", "add", "--quiet", "--detach", root, "HEAD"],
          { cwd: sourceDirectory },
        );
        assert(result.success, result.stderr);
      }
      const commonGitDirectory = await Deno.realPath(`${sourceDirectory}/.git`);
      for (const root of [firstRoot, secondRoot]) {
        await Deno.chmod(`${root}/.git`, 0o600);
        await Deno.chmod(`${root}/docs`, 0o700);
        await Deno.chmod(
          `${root}/docs/technical-design/api-catalog.json`,
          0o600,
        );
      }
      await Deno.chmod(commonGitDirectory, 0o700);
      const aclBefore = await snapshotActualAcl(commonGitDirectory);

      const runner = async (
        command: string,
        args: readonly string[],
        commandOptions: {
          readonly cwd: string;
          readonly env: Record<string, string>;
          readonly clearEnv: true;
          readonly stdin?: string;
        },
      ): Promise<DurableCoreCommandResult> => {
        const events = eventsByRoot.get(commandOptions.cwd) ?? [];
        events.push(`${command}:${args.join(" ")}`);
        eventsByRoot.set(commandOptions.cwd, events);
        if (["stat", "getfacl", "chmod", "setfacl"].includes(command)) {
          return await runExternalCommand(command, args, {
            cwd: commandOptions.cwd,
            env: commandOptions.env,
            stdin: commandOptions.stdin,
          });
        }
        if (command === "git") {
          return args[0] === "status"
            ? { success: true, code: 0, stdout: "", stderr: "" }
            : { success: true, code: 0, stdout: `${REVISION}\n`, stderr: "" };
        }
        if (command === "docker") {
          if (args[0] === "image" && args[1] === "inspect") {
            return {
              success: true,
              code: 0,
              stdout: `sha256:${"d".repeat(64)}\n`,
              stderr: "",
            };
          }
          if (args[0] === "run") {
            return { success: true, code: 0, stdout: "65534\n", stderr: "" };
          }
          if (args[0] === "inspect") {
            return {
              success: true,
              code: 0,
              stdout: `sha256:${"d".repeat(64)}\n`,
              stderr: "",
            };
          }
          if (args.includes("ps") && args.includes("-q")) {
            return {
              success: true,
              code: 0,
              stdout: "abcdef123456\n",
              stderr: "",
            };
          }
          if (args.includes("ps")) {
            return {
              success: true,
              code: 0,
              stdout: "server\ninngest\npostgres\nredis\n",
              stderr: "",
            };
          }
          if (args.includes("id") && args.includes("-u")) {
            return {
              success: true,
              code: 0,
              stdout: `${Deno.uid()}\n`,
              stderr: "",
            };
          }
          if (args.includes("exec")) {
            return {
              success: true,
              code: 0,
              stdout: `${REVISION}\n`,
              stderr: "",
            };
          }
          return { success: true, code: 0, stdout: "", stderr: "" };
        }
        if (command === "pnpm" && args[0] === "--version") {
          return {
            success: true,
            code: 0,
            stdout: `${await readFixturePnpmVersion(commandOptions.cwd)}\n`,
            stderr: "",
          };
        }
        if (command === "pnpm" && args[0] === "install") {
          return {
            success: true,
            code: 0,
            stdout: "dependencies installed\n",
            stderr: "",
          };
        }

        if (command === "bash") {
          return {
            success: true,
            code: 0,
            stdout: "gate ready\n",
            stderr: "",
          };
        }
        assertEquals(command, "pnpm");
        const lane = args[0]!.replace("test:", "");
        if (commandOptions.cwd === firstRoot && lane === "e2e") {
          enteredFirstLane.resolve();
          await releaseFirstLane.promise;
        }
        if (lane === "recovery") {
          await Deno.writeTextFile(
            `${commandOptions.env.BAKERY_DURABLE_CORE_PROOF_DIR}/worker-boundary.json`,
            JSON.stringify(boundary("worker", UUIDS.workerRun)),
          );
          await Deno.writeTextFile(
            `${commandOptions.env.BAKERY_DURABLE_CORE_PROOF_DIR}/engine-boundary.json`,
            JSON.stringify(boundary("engine", UUIDS.engineRun)),
          );
        }
        const names = lane === "e2e"
          ? DURABLE_CORE_REQUIRED_CASES.slice(0, 5)
          : lane === "recovery"
          ? DURABLE_CORE_REQUIRED_CASES.slice(5, 13)
          : DURABLE_CORE_REQUIRED_CASES.slice(13);
        return {
          success: true,
          code: 0,
          stdout: `${outputCases(names)}\n`,
          stderr: "",
        };
      };

      const run = (root: string, proofDirectory: string) =>
        runDurableCoreProof({
          root,
          proofDirectory,
          runner,
        });
      const firstProofDirectory = `${fixtureDirectory}/proof-a`;
      const secondProofDirectory = `${fixtureDirectory}/proof-b`;
      firstProof = run(firstRoot, firstProofDirectory);
      const firstLaneTimeout = Promise.withResolvers<boolean>();
      const firstLaneTimer = setTimeout(
        () => firstLaneTimeout.resolve(false),
        5_000,
      );
      const firstLaneReady = await Promise.race([
        enteredFirstLane.promise.then(() => true),
        firstLaneTimeout.promise,
      ]);
      clearTimeout(firstLaneTimer);
      assert(firstLaneReady);
      secondProof = run(secondRoot, secondProofDirectory);
      const contenderPause = Promise.withResolvers<void>();
      setTimeout(contenderPause.resolve, 250);
      await contenderPause.promise;
      const secondAclEvents = (eventsByRoot.get(secondRoot) ?? []).filter(
        (event) => /^(stat|getfacl|chmod|setfacl):/.test(event),
      );
      assertEquals(secondAclEvents, []);
      releaseFirstLane.resolve();
      await Promise.all([firstProof, secondProof]);
      const hostUid = Deno.uid();
      assert(hostUid !== null);
      for (const root of [firstRoot, secondRoot]) {
        const events = eventsByRoot.get(root) ?? [];
        assert(
          events.some((event) =>
            event.includes(`exec -T --user ${hostUid} server id -u`)
          ),
        );
        assert(
          events.some((event) =>
            event.includes(
              `exec -T --user ${hostUid} server git -c safe.directory=/workspace`,
            )
          ),
        );
      }
      const commonGitGrant = `setfacl:-R -m u:65534:rX ${commonGitDirectory}`;
      assert(!(eventsByRoot.get(firstRoot) ?? []).includes(commonGitGrant));
      assert(!(eventsByRoot.get(secondRoot) ?? []).includes(commonGitGrant));
      await run(sourceDirectory, `${fixtureDirectory}/proof-source`);
      const sourceGitEvents = eventsByRoot.get(sourceDirectory) ?? [];
      assert(!sourceGitEvents.includes(commonGitGrant));
      const aclAfter = await snapshotActualAcl(commonGitDirectory);
      assertEquals(aclAfter, aclBefore);
    } finally {
      releaseFirstLane.resolve();
      await Promise.allSettled(
        [firstProof, secondProof].filter(
          (proof): proof is Promise<unknown> => proof !== undefined,
        ),
      );
      await Deno.remove(fixtureDirectory, { recursive: true });
    }
  },
);

registerDurableCoreTest(
  "checkout lock serializes revisions and releases after SIGKILL",
  async () => {
    const holderProofDirectory = await Deno.makeTempDir({
      prefix: "bakery-durable-core-lock-holder-",
    });
    const contenderProofDirectory = await Deno.makeTempDir({
      prefix: "bakery-durable-core-lock-contender-",
    });
    let holder: Deno.ChildProcess | undefined;
    let contender: Deno.ChildProcess | undefined;
    const root = await createIsolatedCheckoutFixture();
    try {
      holder = spawnLockSmokeChild(root, holderProofDirectory, REVISION);
      const holderObservation = observeLockSmokeChild(holder);
      assert(await readyWithin(holderObservation, 5_000));
      assert(holderObservation.output().includes("REVISION_STATUS_CHECKED"));

      contender = spawnLockSmokeChild(
        root,
        contenderProofDirectory,
        "c".repeat(40),
      );
      const contenderObservation = observeLockSmokeChild(contender);
      assert(!(await readyWithin(contenderObservation, 300)));
      assert(
        !contenderObservation.output().includes("REVISION_STATUS_CHECKED"),
      );

      const holderStatus = await stopLockSmokeChild(holder);
      assertEquals(holderStatus?.signal, "SIGKILL");
      holder = undefined;
      assert(await readyWithin(contenderObservation, 5_000));
      assert(contenderObservation.output().includes("REVISION_STATUS_CHECKED"));
      assert(!contenderObservation.output().includes("UNEXPECTED_COMPOSE"));
    } finally {
      await stopLockSmokeChild(contender);
      await stopLockSmokeChild(holder);
      await Deno.remove(holderProofDirectory, { recursive: true });
      await Deno.remove(contenderProofDirectory, { recursive: true });
      await Deno.remove(root, { recursive: true });
    }
  },
);

registerDurableCoreTest(
  "boundary validation rejects non-real or mismatched proof identities",
  () => {
    const valid = boundary("worker", UUIDS.workerRun);
    assertDurableCoreBoundaryProof(valid, {
      revision: REVISION,
      runId: UUIDS.workerRun,
    });
    assertThrows(() =>
      assertDurableCoreBoundaryProof({
        ...valid,
        restart: {
          ...valid.restart,
          afterProcessId: valid.restart.beforeProcessId,
        },
      })
    );
    assertThrows(() =>
      assertDurableCoreBoundaryProof({
        ...valid,
        artifact: { ...valid.artifact, verifiedSha256: "c".repeat(64) },
      })
    );
    assertThrows(() =>
      assertDurableCoreBoundaryProof(valid, {
        revision: REVISION,
        runId: UUIDS.engineRun,
      })
    );
  },
);

registerDurableCoreTest(
  "engine evidence accepts natural and reconciliation recovery interleavings",
  () => {
    const natural = boundary("engine", UUIDS.engineRun, "natural");
    const naturalAfter = natural.observations.engineAfter!;
    assertDurableCoreBoundaryProof(natural, {
      revision: REVISION,
      runId: UUIDS.engineRun,
    });
    assertThrows(() =>
      assertDurableCoreBoundaryProof({
        ...natural,
        observations: {
          ...natural.observations,
          engineAfter: { ...naturalAfter, unexpected: "unknown" },
        },
      })
    );
    assertThrows(() =>
      assertDurableCoreBoundaryProof({
        ...natural,
        observations: {
          ...natural.observations,
          engineAfter: {
            ...naturalAfter,
            recoveryEventId: "forged-reconciliation-cause",
          },
        },
      })
    );

    const reconciliation = boundary(
      "engine",
      UUIDS.engineRun,
      "reconciliation",
    );
    const reconciliationAfter = reconciliation.observations.engineAfter!;
    assertDurableCoreBoundaryProof(reconciliation, {
      revision: REVISION,
      runId: UUIDS.engineRun,
    });
    assertThrows(() =>
      assertDurableCoreBoundaryProof({
        ...reconciliation,
        observations: {
          ...reconciliation.observations,
          engineAfter: {
            ...reconciliationAfter,
            recoveryTriggerFunctionEventId: "forged-post-event",
          },
        },
      })
    );
  },
);

registerDurableCoreTest(
  "boundary validation rejects empty and unlinked observations",
  () => {
    const valid = boundary("worker", crypto.randomUUID());
    assertThrows(() =>
      assertDurableCoreBoundaryProof({
        ...valid,
        observations: { ...valid.observations, journalBefore: "" },
      })
    );
    assertThrows(() =>
      assertDurableCoreBoundaryProof({
        ...valid,
        observations: { ...valid.observations, spoolBefore: {} },
      })
    );
    assertThrows(() =>
      assertDurableCoreBoundaryProof({
        ...valid,
        observations: {
          ...valid.observations,
          spoolBefore: {
            ...valid.observations.spoolBefore,
            spoolState: "compacted",
            checkpointAckedLocalSeq: null,
            nextLocalSeq: null,
            recordCount: 0,
            records: [],
          },
        },
      })
    );
  },
);
registerDurableCoreTest(
  "fresh checkout bootstraps frozen workspace dependencies before Compose",
  async () => {
    const { fileSystem, files } = inMemoryFileSystem();
    const calls: string[] = [];
    const events: string[] = [];
    await runDurableCoreProofInFixture({
      proofDirectory: "/tmp/durable-core-rails-bootstrap",
      fileSystem,
      runner: fakeRunner(fileSystem, {
        writeBoundaries: true,
        events,
        assertFreshNodeModules: true,
        gitStatus: "?? node_modules/.pnpm/fixture\n",
      }, calls),
    });
    const version = events.indexOf("pnpm:--version");
    const install = events.indexOf(
      "pnpm:install --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
    );
    const compose = events.findIndex((event) =>
      event.startsWith("bash:scripts/dev/compose-up.sh")
    );
    assert(version >= 0);
    assert(install > version);
    assert(compose > install);
    assert(
      files.get("/tmp/durable-core-rails-bootstrap/dependency-bootstrap.log")
        ?.text.includes("pnpm install --frozen-lockfile"),
    );
  },
);
registerDurableCoreTest(
  "recovery lane scopes temp helpers to the proof directory",
  async () => {
    const { fileSystem } = inMemoryFileSystem();
    const proofDirectory = await Deno.makeTempDir({
      prefix: "bakery-durable-core-rails-recovery-tmpdir-",
    });
    let recoveryEnvironmentChecked = false;
    const baseRunner = fakeRunner(fileSystem, {
      writeBoundaries: true,
    }, []);
    const runner: NonNullable<DurableCoreProofRunOptions["runner"]> = async (
      command,
      args,
      commandOptions,
    ) => {
      if (command === "pnpm" && args[0]?.startsWith("test:")) {
        if (args[0] === "test:recovery") {
          recoveryEnvironmentChecked = true;
          assertEquals(commandOptions.env.TMPDIR, proofDirectory);
          await assertScopedRecoveryTempDirectory(proofDirectory);
        } else {
          assertEquals(commandOptions.env.TMPDIR, "/tmp");
        }
      }
      return await baseRunner(command, args, commandOptions);
    };
    try {
      await runDurableCoreProofInFixture({
        proofDirectory,
        fileSystem,
        environment: { TMPDIR: "/tmp" },
        runner,
      });
    } finally {
      await Deno.remove(proofDirectory, { recursive: true });
    }
    assert(recoveryEnvironmentChecked);
  },
);

registerDurableCoreTest(
  "dependency bootstrap failure is bounded, redacted, and stops before Compose",
  async () => {
    const { fileSystem, files } = inMemoryFileSystem();
    const calls: string[] = [];
    const events: string[] = [];
    const secret = "bootstrap-secret";
    await assertRejects(
      () =>
        runDurableCoreProofInFixture({
          proofDirectory: "/tmp/durable-core-rails-bootstrap-failure",
          fileSystem,
          runner: fakeRunner(fileSystem, {
            writeBoundaries: false,
            events,
            failDependencyBootstrap: true,
            dependencyBootstrapOutput:
              `Authorization: Bearer ${secret}\ninstall failed`,
          }, calls),
        }),
      Error,
      "DURABLE_CORE_DEPENDENCY_BOOTSTRAP_FAILED",
    );
    const install = events.indexOf(
      "pnpm:install --frozen-lockfile --ignore-scripts --ignore-pnpmfile",
    );
    const log = files.get(
      "/tmp/durable-core-rails-bootstrap-failure/dependency-bootstrap.log",
    )?.text;
    assert(install >= 0);
    assert(!events.some((event) => event.startsWith("bash:")));
    assert(!events.some((event) => event.startsWith("docker:")));
    assert(
      !files.has(
        "/tmp/durable-core-rails-bootstrap-failure/manifest.json",
      ),
    );
    assert(log !== undefined);
    assert(log.length <= 64 * 1024);
    assert(!log.includes(secret));
    assert(log.includes("[redacted]"));
  },
);

registerDurableCoreTest(
  "pnpm executable and version are checked before dependency bootstrap",
  async () => {
    const cases = [
      {
        name: "unavailable",
        expected: "DURABLE_CORE_PNPM_UNAVAILABLE",
        fixturePnpmVersion: undefined,
        options: { failPnpmVersion: true },
      },
      {
        name: "mismatch",
        expected: "DURABLE_CORE_PNPM_VERSION_MISMATCH",
        fixturePnpmVersion: `10.33.0+sha512.${COREPACK_SHA512_PNPM_10_33_0}`,
        options: { pnpmVersion: "10.34.0" },
      },
    ] as const;
    for (const testCase of cases) {
      const { fileSystem, files } = inMemoryFileSystem();
      const calls: string[] = [];
      const events: string[] = [];
      await assertRejects(
        () =>
          runDurableCoreProofInFixture({
            proofDirectory: `/tmp/durable-core-rails-pnpm-${testCase.name}`,
            fileSystem,
            runner: fakeRunner(fileSystem, {
              writeBoundaries: false,
              events,
              ...testCase.options,
            }, calls),
          }, testCase.fixturePnpmVersion),
        Error,
        testCase.expected,
      );
      assertEquals(events, [
        "git:rev-parse --verify HEAD^{commit}",
        "git:status --porcelain=v1 --untracked-files=all",
        "pnpm:--version",
      ]);
      assert(
        !files.has(
          `/tmp/durable-core-rails-pnpm-${testCase.name}/manifest.json`,
        ),
      );
    }
  },
);
registerDurableCoreTest(
  "pnpm version gate follows the isolated checkout packageManager pin",
  async () => {
    const cases = [
      {
        name: "bare",
        packageManager: "10.34.0",
        pnpmVersion: "10.34.0",
      },
      {
        name: "corepack-real-hex",
        packageManager: `10.33.0+sha512.${COREPACK_SHA512_PNPM_10_33_0}`,
        pnpmVersion: "10.33.0",
      },
      {
        name: "corepack-real-sha1",
        packageManager: `10.33.0+sha1.${COREPACK_SHA1_PNPM_10_33_0}`,
        pnpmVersion: "10.33.0",
      },
      {
        name: "corepack-prerelease",
        packageManager: `10.33.0-rc.1+sha512.${COREPACK_SHA512_PNPM_10_33_0}`,
        pnpmVersion: "10.33.0-rc.1",
      },
    ] as const;
    for (const testCase of cases) {
      const { fileSystem } = inMemoryFileSystem();
      const calls: string[] = [];
      await runDurableCoreProofInFixture(
        {
          proofDirectory: `/tmp/durable-core-rails-pnpm-pin-${testCase.name}`,
          fileSystem,
          runner: fakeRunner(
            fileSystem,
            {
              writeBoundaries: true,
              pnpmVersion: testCase.pnpmVersion,
            },
            calls,
          ),
        },
        testCase.packageManager,
      );
      assertEquals(calls, ["e2e", "recovery", "security"]);
    }

    const malformedCases = [
      {
        name: "nonhex",
        suffix: `sha512.${COREPACK_SHA512_PNPM_10_33_0.slice(0, -1)}g`,
      },
      {
        name: "wrong-length",
        suffix: `sha512.${COREPACK_SHA512_PNPM_10_33_0.slice(0, -1)}`,
      },
      {
        name: "algorithm-length-mismatch",
        suffix: `sha256.${COREPACK_SHA1_PNPM_10_33_0}`,
      },
    ] as const;
    for (const testCase of malformedCases) {
      const { fileSystem } = inMemoryFileSystem();
      const calls: string[] = [];
      const events: string[] = [];
      await assertRejects(
        () =>
          runDurableCoreProofInFixture(
            {
              proofDirectory:
                `/tmp/durable-core-rails-pnpm-pin-${testCase.name}`,
              fileSystem,
              runner: fakeRunner(fileSystem, {
                writeBoundaries: false,
                events,
              }, calls),
            },
            `10.33.0+${testCase.suffix}`,
          ),
        Error,
        "DURABLE_CORE_PNPM_PACKAGE_MANAGER_INVALID",
      );
      assertEquals(events, [
        "git:rev-parse --verify HEAD^{commit}",
        "git:status --porcelain=v1 --untracked-files=all",
      ]);
    }
  },
);

registerDurableCoreTest(
  "proof directory traversal is rejected before Docker starts",
  async () => {
    const { fileSystem } = inMemoryFileSystem();
    const calls: string[] = [];
    await assertRejects(() =>
      runDurableCoreProofInFixture({
        proofDirectory: "../unsafe",
        fileSystem,
        runner: fakeRunner(fileSystem, { writeBoundaries: false }, calls),
      })
    );
    assertEquals(calls, []);
  },
);

registerDurableCoreTest(
  "proving command executes lanes sequentially and writes only a validated manifest",
  async () => {
    const { fileSystem, files, modes, directoryModes } = inMemoryFileSystem();
    const calls: string[] = [];
    const options: Omit<DurableCoreProofRunOptions, "root"> = {
      proofDirectory: "/tmp/durable-core-rails",
      environment: {
        PATH: "/usr/bin",
        DURABLE_CORE_NONSECRET_CANARY: "must-be-excluded",
        OPENAI_API_KEY: "must-be-removed",
        BAKERY_LOCAL_BAKERY_PASSWORD: "caller-secret",
      },
      fileSystem,
      runner: fakeRunner(
        fileSystem,
        { writeBoundaries: true, expectedPath: "/usr/bin" },
        calls,
      ),
    };
    const manifest = await runDurableCoreProofInFixture(options);
    assertEquals(calls, ["e2e", "recovery", "security"]);
    assertEquals(manifest.lanes.map((lane) => lane.exitCode), [0, 0, 0]);
    assertEquals(manifest.boundaries.map((proof) => proof.kind), [
      "worker",
      "engine",
    ]);
    assertEquals(manifest.boundaries.map((proof) => proof.runId), [
      UUIDS.workerRun,
      UUIDS.engineRun,
    ]);
    assert(
      manifest.runId !== UUIDS.workerRun && manifest.runId !== UUIDS.engineRun,
    );
    assert(manifest.gateProject !== manifest.devContainerProject);
    assertEquals(manifest.lanes.map((lane) => lane.cases.length), [5, 8, 5]);
    assertEquals(
      manifest.cases.map((record) => record.name),
      [...DURABLE_CORE_REQUIRED_CASES],
    );
    assertEquals(manifest.revision, REVISION);
    assertEquals(manifest.lanes[0]?.cases[0], {
      name: "duplicate",
      outcome: "passed",
      requestId: "request-duplicate",
      traceId: "trace-duplicate",
      auditRefs: [{
        id: UUIDS.audit,
        organizationId: ORGANIZATION_ID,
        resourceType: "job_attempt",
        resourceId: UUIDS.attemptNew,
        operation: "durable_core.case",
        outcome: "succeeded",
        requestId: "request-duplicate",
        traceId: "trace-duplicate",
      }],
      terminalResults: 1,
      effects: 1,
      artifacts: 1,
    });
    assert(files.has("/tmp/durable-core-rails/manifest.json"));
    assertEquals(directoryModes.get("/tmp/durable-core-rails"), 0o700);
    for (
      const name of [
        "compose-gate.log",
        "e2e.log",
        "recovery.log",
        "security.log",
        "dev-container-gate.log",
        "worker-boundary.json",
        "engine-boundary.json",
        "manifest.json",
      ]
    ) {
      const path = `/tmp/durable-core-rails/${name}`;
      assertEquals(modes.get(path), 0o600);
      assert(!files.get(path)?.text.includes("canary-db-secret"));
    }
  },
);

registerDurableCoreTest(
  "proving command fails closed when a boundary is absent",
  async () => {
    const { fileSystem, files } = inMemoryFileSystem();
    const calls: string[] = [];
    await assertRejects(() =>
      runDurableCoreProofInFixture({
        proofDirectory: "/tmp/durable-core-rails",
        fileSystem,
        runner: fakeRunner(fileSystem, { writeBoundaries: false }, calls),
      })
    );
    assertEquals(calls, ["e2e", "recovery", "security"]);
    assert(!files.has("/tmp/durable-core-rails/manifest.json"));
  },
);

registerDurableCoreTest(
  "proving command stops at the first failed lane and restores ACLs",
  async () => {
    const { fileSystem, files } = inMemoryFileSystem();
    const calls: string[] = [];
    const events: string[] = [];
    await assertRejects(() =>
      runDurableCoreProofInFixture({
        proofDirectory: "/tmp/durable-core-rails",
        fileSystem,
        runner: fakeRunner(fileSystem, {
          writeBoundaries: true,
          failLane: "recovery",
          events,
        }, calls),
      })
    );
    assertEquals(calls, ["e2e", "recovery"]);
    assert(!files.has("/tmp/durable-core-rails/manifest.json"));
    assert(
      events.findLast((event) => event.startsWith("setfacl:--restore=-")) !==
        undefined,
    );
    assert(events.at(-1)?.startsWith("setfacl:--restore=-"));
  },
);

registerDurableCoreTest(
  "durable-core sanitizer redacts credentials in every output form",
  () => {
    const input = [
      "Authorization: Bearer bearer-secret",
      "Cookie: session=cookie-secret; csrf=csrf-secret",
      '{"password":"json-secret","token":"json-token"}',
      "deno test --password cli-secret --token=cli-token",
      "curl --authorization 'Bearer cli-bearer-secret' --cookie cli-cookie-secret",
      "postgresql://user:uri-secret@db:5432/bakery?password=query-secret&x=1",
    ].join("\n");
    const redacted = redactDurableCoreText(input);
    for (
      const secret of [
        "bearer-secret",
        "cookie-secret",
        "csrf-secret",
        "json-secret",
        "json-token",
        "cli-secret",
        "cli-token",
        "cli-bearer-secret",
        "cli-cookie-secret",
        "uri-secret",
        "query-secret",
      ]
    ) {
      assert(!redacted.includes(secret), secret);
    }
    assert(redacted.includes("password=[redacted]"));
    assert(redacted.includes("x=[redacted]"));
  },
);

registerDurableCoreTest(
  "revision binding rejects dirty executable source but ignores user hooks and task files",
  async () => {
    const ignored = inMemoryFileSystem();
    const ignoredCalls: string[] = [];
    const ignoredManifest = await runDurableCoreProofInFixture({
      proofDirectory: "/tmp/durable-core-rails-ignored",
      fileSystem: ignored.fileSystem,
      runner: fakeRunner(ignored.fileSystem, {
        writeBoundaries: true,
        gitStatus:
          " M .claude/helpers/graft-hooks.cjs\n?? .cursor/hooks.json\n?? .agents/tasks/prove.md\n",
      }, ignoredCalls),
    });
    assertEquals(ignoredManifest.revision, REVISION);
    assertEquals(ignoredCalls, ["e2e", "recovery", "security"]);

    const dirty = inMemoryFileSystem();
    const dirtyCalls: string[] = [];
    await assertRejects(() =>
      runDurableCoreProofInFixture({
        proofDirectory: "/tmp/durable-core-rails-dirty",
        fileSystem: dirty.fileSystem,
        runner: fakeRunner(dirty.fileSystem, {
          writeBoundaries: true,
          gitStatus:
            " M apps/server/src/main.ts\n M .devcontainer/Dockerfile\n",
        }, dirtyCalls),
      })
    );
    assertEquals(dirtyCalls, []);
  },
);

registerDurableCoreTest(
  "revision binding rechecks the immutable checkout before manifest",
  async () => {
    const { fileSystem, files } = inMemoryFileSystem();
    const calls: string[] = [];
    const changedRevision = "c".repeat(40);
    await assertRejects(
      () =>
        runDurableCoreProofInFixture({
          proofDirectory: "/tmp/durable-core-rails-revision-race",
          fileSystem,
          runner: fakeRunner(fileSystem, {
            writeBoundaries: true,
            gitRevisions: [REVISION, changedRevision],
          }, calls),
        }),
      Error,
      "DURABLE_CORE_REVISION_CHANGED",
    );
    assertEquals(calls, ["e2e", "recovery", "security"]);
    assert(!files.has("/tmp/durable-core-rails-revision-race/manifest.json"));
  },
);

registerDurableCoreTest(
  "permission mutations and dev image build are restored after the complete run",
  async () => {
    const { fileSystem } = inMemoryFileSystem();
    const calls: string[] = [];
    const events: string[] = [];
    await runDurableCoreProofInFixture({
      proofDirectory: "/tmp/durable-core-rails-lock",
      fileSystem,
      runner: fakeRunner(fileSystem, {
        writeBoundaries: true,
        events,
      }, calls),
    });
    const snapshot = events.findIndex((event) => event.startsWith("stat:"));
    const imageBuild = events.findIndex((event) =>
      event.startsWith(
        "docker:build --file .devcontainer/Dockerfile --tag bakery-b01-02-devcontainer:proof-",
      )
    );
    const imageInspect = events.findIndex((event) =>
      event.startsWith(
        "docker:image inspect --format {{.Id}} bakery-b01-02-devcontainer:proof-",
      )
    );
    const imageRun = events.findIndex((event) =>
      event ===
        `docker:run --rm --entrypoint id sha256:${"d".repeat(64)} -u`
    );
    const runningImageInspect = events.findIndex((event) =>
      event ===
        `docker:inspect --format {{.Image}} abcdef123456`
    );
    const devGrant = events.findIndex((event) =>
      event.startsWith("setfacl:-R -m u:1993:rX")
    );
    const devGate = events.findIndex((event) =>
      event.startsWith(
        "docker:compose --project-name bakery-durable-core-dev-",
      ) &&
      event.endsWith("up -d --wait server")
    );
    const firstLane = events.findIndex((event) =>
      event ===
        "pnpm:test:e2e -- tests/e2e/prove-the-complete-durable-core-after-forced-restarts_test.ts"
    );
    const restore = events.findLastIndex((event) =>
      event.startsWith("setfacl:--restore=-")
    );
    assert(snapshot >= 0);
    assert(imageBuild > snapshot);
    assert(imageInspect > imageBuild);
    assert(imageRun > imageInspect);
    assert(devGrant > imageRun);
    assert(devGate > devGrant);
    assert(runningImageInspect > devGate);
    assert(firstLane > runningImageInspect);
    assert(restore > firstLane);
    assert(events.at(-1)?.startsWith("setfacl:--restore=-"));
  },
);

registerDurableCoreTest(
  "dev image build failure stops before any Compose gate",
  async () => {
    const { fileSystem, files } = inMemoryFileSystem();
    const calls: string[] = [];
    const events: string[] = [];
    await assertRejects(() =>
      runDurableCoreProofInFixture({
        proofDirectory: "/tmp/durable-core-rails-build-failure",
        fileSystem,
        runner: fakeRunner(fileSystem, {
          writeBoundaries: false,
          failDevContainerBuild: true,
          events,
        }, calls),
      })
    );
    assertEquals(calls, []);
    assert(
      events.some((event) =>
        event.startsWith(
          "docker:build --file .devcontainer/Dockerfile --tag bakery-b01-02-devcontainer:proof-",
        )
      ),
    );
    assert(!events.some((event) => event.startsWith("bash:")));
    assert(!files.has("/tmp/durable-core-rails-build-failure/manifest.json"));
  },
);

registerDurableCoreTest(
  "dev and base service gates fail closed without a manifest",
  async () => {
    const cases = [
      {
        name: "base-missing",
        expected: "DURABLE_CORE_SERVICES_UNHEALTHY:server",
        options: { missingBaseService: "server" },
      },
      {
        name: "dev-missing-server",
        expected: "DURABLE_CORE_DEV_CONTAINER_SERVICE_UNHEALTHY",
        options: { missingDevContainerServer: true },
      },
      {
        name: "dev-compose-invalid",
        expected: "DURABLE_CORE_DEV_CONTAINER_COMPOSE_INVALID",
        options: { devComposeInvalid: true },
      },
      {
        name: "dev-image-mismatch",
        expected: "DURABLE_CORE_DEV_CONTAINER_IMAGE_MISMATCH",
        options: { devImageMismatch: true },
      },
      {
        name: "dev-host-uid-mismatch",
        expected: "DURABLE_CORE_DEV_CONTAINER_HOST_UID_MISMATCH",
        options: { devHostUidMismatch: true },
      },
      {
        name: "dev-revision-mismatch",
        expected: "DURABLE_CORE_DEV_CONTAINER_REVISION_MISMATCH",
        options: { devRevision: "c".repeat(40) },
      },
      {
        name: "dev-revision-unavailable",
        expected: "DURABLE_CORE_DEV_CONTAINER_REVISION_UNAVAILABLE",
        options: { devRevisionUnavailable: true },
      },
    ] as const;
    for (const testCase of cases) {
      const { fileSystem, files } = inMemoryFileSystem();
      await assertRejects(
        () =>
          runDurableCoreProofInFixture({
            proofDirectory: `/tmp/durable-core-rails-gate-${testCase.name}`,
            fileSystem,
            runner: fakeRunner(fileSystem, {
              writeBoundaries: false,
              ...testCase.options,
            }, []),
          }),
        Error,
        testCase.expected,
      );
      assert(
        !files.has(
          `/tmp/durable-core-rails-gate-${testCase.name}/manifest.json`,
        ),
      );
    }
  },
);

registerDurableCoreTest(
  "recovery audit evidence rejects empty, partial, mismatched, and open rows",
  async () => {
    const cases: readonly [AuditVariant, string][] = [
      ["empty-recovery", "DURABLE_CORE_CASE_AUDIT_REFS_REQUIRED"],
      ["missing-id", "DURABLE_CORE_CASE_AUDIT_REF_INVALID"],
      ["extra-field", "DURABLE_CORE_CASE_AUDIT_REF_INVALID"],
      ["mismatched-request", "DURABLE_CORE_CASE_AUDIT_IDENTITY_MISMATCH"],
      ["legacy-string", "DURABLE_CORE_CASE_AUDIT_REF_INVALID"],
    ];
    for (const [auditVariant, expectedMessage] of cases) {
      const { fileSystem, files } = inMemoryFileSystem();
      await assertRejects(
        () =>
          runDurableCoreProofInFixture({
            proofDirectory: `/tmp/durable-core-rails-audit-${auditVariant}`,
            fileSystem,
            runner: fakeRunner(fileSystem, {
              writeBoundaries: true,
              auditVariant,
            }, []),
          }),
        Error,
        expectedMessage,
      );
      assert(
        !files.has(
          `/tmp/durable-core-rails-audit-${auditVariant}/manifest.json`,
        ),
      );
    }
  },
);

registerDurableCoreTest(
  "case records reject unknown fields and final errors stay bounded and redacted",
  async () => {
    const { fileSystem } = inMemoryFileSystem();
    const calls: string[] = [];
    await assertRejects(() =>
      runDurableCoreProofInFixture({
        proofDirectory: "/tmp/durable-core-rails-case-schema",
        fileSystem,
        runner: fakeRunner(fileSystem, {
          writeBoundaries: true,
          extraCaseField: true,
        }, calls),
      })
    );
    const rendered = errorText(
      new Error(
        "Authorization: Bearer final-bearer " +
          '{"password":"final-json-secret","token":"final-token"} ' +
          "postgresql://user:final-uri-secret@db:5432/bakery?password=final-query",
      ),
    );
    const nested = errorText(
      new AggregateError(
        [
          new Error(
            "inner Authorization: Bearer nested-secret " +
              '{"token":"nested-json-secret"}',
          ),
        ],
        "outer postgresql://user:uri-secret@db:5432/bakery?password=query-secret",
      ),
    );
    assert(rendered.length <= 4096);
    assert(nested.length <= 4096);
    for (
      const secret of [
        "final-bearer",
        "final-json-secret",
        "final-token",
        "final-uri-secret",
        "final-query",
        "nested-secret",
        "nested-json-secret",
        "uri-secret",
        "query-secret",
      ]
    ) {
      assert(!rendered.includes(secret), secret);
      assert(!nested.includes(secret), secret);
    }
    assert(nested.includes("inner Authorization: [redacted]"));
  },
);
