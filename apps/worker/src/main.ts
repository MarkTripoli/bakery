import { join } from "node:path";
import { WorkerApiClient } from "./client.ts";
import {
  disabledMonitoring,
  initializeDenoMonitoring,
  type RuntimeMonitoring,
} from "@bakery/config/sentry-deno";
import {
  type CodingHarnessConfig,
  readWorkerConfig,
  type WorkerConfig,
} from "./config.ts";
import { createCheckExecutor } from "./check-runner.ts";
import { createPiHarnessExecutor } from "./pi-harness.ts";
import { createClaudeHarnessExecutor } from "./claude-harness.ts";
import { createCodexHarnessExecutor } from "./codex-harness.ts";
import { createReviewerExecutor } from "./reviewer.ts";
import {
  createNativeExecutor,
  NativeExecutorError,
  type NativeExecutorOptions,
  type WorkerExecutor,
} from "./executor.ts";
import type { PublishArtifact } from "./task-brief.ts";
import type { JobAssignment } from "./types.ts";
import { loadRepositoryInspectionSource } from "./repository-inspection-source.ts";
import { createPreparedSecretInvoker } from "./prepared-secret-invoker.ts";
import { RegistrationStore } from "./registration.ts";
import { SkillCache } from "./skill-cache.ts";
import { createScriptedHarnessExecutor } from "./scripted-harness.ts";
import { SkillMaterializer } from "./skill-materializer.ts";
import { EventSpool } from "./spool.ts";
import {
  publishWorkerShutdownReceipt,
  type WorkerShutdownIdentity,
  workerShutdownReceiptPath,
} from "./shutdown-receipt.ts";
import { acquireStateLock, ensurePrivateDirectory } from "./storage.ts";
import {
  WorkerShutdownQuiescenceError,
  WorkerSupervisor,
} from "./supervisor.ts";

export type WorkerMainOptions = {
  monitoring?: RuntimeMonitoring;
  config?: WorkerConfig;
  client?: WorkerApiClient;
  registrationStore?: RegistrationStore;
  spool?: EventSpool;
  executor?: WorkerExecutor;
  /** Test-only observation hooks for the main-owned native executor. */
  nativeExecutorTestHooks?: NativeExecutorOptions["testHooks"];
  onSupervisor?: (supervisor: WorkerSupervisor) => void;
};

function optionalEnvironmentValue(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) return undefined;
    throw error;
  }
}

export async function main(options: WorkerMainOptions = {}): Promise<void> {
  const config = options.config ?? readWorkerConfig();
  await ensurePrivateDirectory(config.stateDir);
  const stateLock = await acquireStateLock(`${config.stateDir}/.worker.lock`);
  let releaseStateLock = true;
  let shutdownReceiptIdentity: WorkerShutdownIdentity | undefined;
  try {
    if (config.shutdownReceiptLaunchId) {
      await Deno.remove(workerShutdownReceiptPath(config.stateDir)).catch(
        (error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        },
      );
    }
    const client = options.client ?? new WorkerApiClient({
      baseUrl: config.serverUrl,
      requestTimeoutMs: config.requestTimeoutMs,
    });
    const registrationStore = options.registrationStore ??
      new RegistrationStore(config.registrationPath);
    const spool = options.spool ?? await EventSpool.open({
      path: config.spoolPath,
      maxRecords: config.spoolMaxRecords,
      maxBytes: config.spoolMaxBytes,
    });
    // CI-only probe: assignment data selects this code-owned action, while
    // executable, args, cwd, and environment remain fixed here. The probe is
    // test-only so production cannot replace the real action definition.
    const nativeOutputFixture = config.environment === "test" &&
      optionalEnvironmentValue("BAKERY_WORKER_NATIVE_OUTPUT_FIXTURE") === "1";
    const nativeSmokeActions = nativeOutputFixture
      ? [{
        action: "harness.implement",
        executable: Deno.execPath(),
        args: [
          "eval",
          [
            "const encoder = new TextEncoder();",
            'await Deno.stdout.write(encoder.encode("stdout-before native-synthetic-"));',
            "await new Promise((resolve) => setTimeout(resolve, 10));",
            'await Deno.stdout.write(encoder.encode("secret stdout-after 🔐\\n"));',
            'await Deno.stderr.write(encoder.encode("\\x1b[31mstderr-safe\\x1b[0m\\n"));',
            'await Deno.stdout.write(encoder.encode("native-\\x1b[31msynthetic-<script>secret</script>\\n"));',
          ].join("\n"),
        ],
      }] as const
      : config.environment === "test" &&
          optionalEnvironmentValue("BAKERY_WORKER_NATIVE_SMOKE") === "1"
      ? [{
        action: "quality.check",
        executable: Deno.execPath(),
        args: [
          "eval",
          "setInterval(() => undefined, 1000); await new Promise(() => undefined);",
        ],
      }] as const
      : undefined;
    const publishArtifactFor =
      (assignment: JobAssignment): PublishArtifact => (request, signal) => {
        if (
          assignment.workerSessionId === undefined ||
          assignment.workerSessionGeneration === undefined
        ) throw new Error("ARTIFACT_PUBLISH_SESSION_MISSING");
        return client.publishArtifact(assignment.attemptId, {
          ...request,
          signal,
          leaseToken: assignment.leaseToken,
          fence: String(assignment.fence),
          workerSessionId: assignment.workerSessionId,
          workerSessionGeneration: String(assignment.workerSessionGeneration),
        });
      };
    const nativeExecutor = options.executor ?? createNativeExecutor({
      publishArtifactFor,
      cgroupRoot: config.nativeCgroupRoot,
      stateDir: config.stateDir,
      supervisorSecretPaths: [
        config.registrationPath,
        config.spoolPath,
        ...(config.enrollmentTokenPath ? [config.enrollmentTokenPath] : []),
      ],
      terminationGraceMs: config.terminationGraceMs,
      actions: nativeSmokeActions,
      testHooks: options.nativeExecutorTestHooks,
      loadInspectionSource: async (assignment, signal, directory) => {
        const registration = await registrationStore.load();
        if (
          !registration?.workerHostId || !registration.workerSessionId ||
          registration.workerSessionGeneration === undefined
        ) throw new Error("INSPECTION_SESSION_REQUIRED");
        return await loadRepositoryInspectionSource({
          client,
          assignment,
          signal,
          directory,
          authority: {
            workerHostId: registration.workerHostId,
            workerSessionId: registration.workerSessionId,
            workerSessionGeneration: String(
              registration.workerSessionGeneration,
            ),
          },
        });
      },
    });
    // The scripted harness exists only for the test environment; the config
    // reader already rejected its directory everywhere else.
    const executor = options.executor === undefined &&
        config.environment === "test" && config.scriptedHarnessDir
      ? createScriptedHarnessExecutor({
        dir: config.scriptedHarnessDir,
        inner: nativeExecutor,
        publishFor: publishArtifactFor,
      })
      : nativeExecutor;
    const codingHarness: CodingHarnessConfig | undefined =
      config.codingHarness ??
        (config.codexHarness
          ? { name: "codex", ...config.codexHarness }
          : undefined);
    if (
      codingHarness !== undefined &&
      codingHarness.name !== "codex" &&
      codingHarness.name !== "claude" &&
      codingHarness.name !== "pi"
    ) {
      throw new Error(
        `BAKERY_CODING_HARNESS_UNSUPPORTED:${codingHarness.name}`,
      );
    }
    // Real coding harnesses are opt-in; every other action stays on the
    // deterministic/native executor.
    const home = optionalEnvironmentValue("HOME");
    const piAgentSourceDir =
      optionalEnvironmentValue("PI_CODING_AGENT_DIR")?.trim() ||
      (home ? join(home, ".pi", "agent") : undefined);
    if (codingHarness?.name === "claude" && !home) {
      throw new Error("HOME_REQUIRED_FOR_CLAUDE_HARNESS");
    }
    if (codingHarness?.name === "pi" && !piAgentSourceDir) {
      throw new Error("HOME_REQUIRED_FOR_PI_HARNESS");
    }
    if (
      codingHarness?.name === "codex" && !config.codexAuthSourceDir && !home
    ) {
      throw new Error("HOME_REQUIRED_FOR_CODEX_HARNESS");
    }
    // Worker credential and state files: no attempt root may sit beside them.
    const credentialPaths = [
      config.registrationPath,
      config.spoolPath,
      ...(config.enrollmentTokenPath ? [config.enrollmentTokenPath] : []),
    ];
    // `quality.check` runs fixed policy commands in a detached worktree of the
    // harness repository, so it is advertised only when one is configured. It
    // wraps the executor below the harness adapters, so the test-only native
    // smoke override of `quality.check` cannot shadow it.
    const checkedExecutor = codingHarness === undefined
      ? executor
      : createCheckExecutor(executor, {
        repository: codingHarness.repository,
        stateDir: config.stateDir,
        publishFor: publishArtifactFor,
        commandTimeLimitMs: codingHarness.timeLimitMs,
        redactionSecrets: config.outputRedactionSecrets,
        credentialPaths,
      });
    const harnessExecutor = codingHarness?.name === "claude"
      ? createClaudeHarnessExecutor({
        publishFor: publishArtifactFor,
        repositoryFor: () => codingHarness.repository,
        repository: codingHarness.repository,
        timeLimitMs: codingHarness.timeLimitMs,
        claudeExecutable: codingHarness.executable,
        model: codingHarness.model,
        effort: codingHarness.effort,
        coordinatorTimeLimitMs: config.claudeCoordinatorTimeLimitMs,
        coordinatorEffort: config.claudeCoordinatorEffort,
        stateDir: config.stateDir,
        redactionSecrets: config.outputRedactionSecrets,
        authSourceDir: config.claudeAuthSourceDir ?? join(home!, ".claude"),
        inner: checkedExecutor,
      })
      : codingHarness?.name === "pi"
      ? createPiHarnessExecutor({
        publishFor: publishArtifactFor,
        repositoryFor: () => codingHarness.repository,
        repository: codingHarness.repository,
        timeLimitMs: codingHarness.timeLimitMs,
        piExecutable: codingHarness.executable,
        model: codingHarness.model,
        effort: codingHarness.effort,
        stateDir: config.stateDir,
        piAgentSourceDir: piAgentSourceDir!,
        redactionSecrets: config.outputRedactionSecrets,
        capabilities: config.adapterCapabilities,
        inner: checkedExecutor,
      })
      : codingHarness?.name === "codex"
      ? createCodexHarnessExecutor({
        publishFor: publishArtifactFor,
        repositoryFor: () => codingHarness.repository,
        repository: codingHarness.repository,
        timeLimitMs: codingHarness.timeLimitMs,
        codexExecutable: codingHarness.executable,
        stateDir: config.stateDir,
        authSourceDir: config.codexAuthSourceDir ?? join(home!, ".codex"),
        redactionSecrets: config.outputRedactionSecrets,
        inner: checkedExecutor,
      })
      : checkedExecutor;
    // `review.independent` runs the Claude CLI read-only in a detached worktree
    // of the harness repository, so it is advertised only with the Claude
    // harness. It sits ahead of the adapter chain; a host still claims the job
    // only when `model` and `reviewer` are both in its enrolled capabilities.
    const workerExecutor = codingHarness?.name === "claude"
      ? createReviewerExecutor({
        inner: harnessExecutor,
        repository: codingHarness.repository,
        stateDir: config.stateDir,
        claude: {
          authSourceDir: config.claudeAuthSourceDir ?? join(home!, ".claude"),
          claudeExecutable: codingHarness.executable,
          model: codingHarness.model,
          effort: codingHarness.effort,
          timeLimitMs: codingHarness.timeLimitMs,
        },
        redactionSecrets: config.outputRedactionSecrets,
        credentialPaths,
      })
      : harnessExecutor;
    await workerExecutor.initialize?.();
    const skillMaterializer = new SkillMaterializer(
      new SkillCache(config.stateDir),
      client,
    );
    const supervisor = new WorkerSupervisor({
      monitoring: options.monitoring,
      config,
      client,
      registrationStore,
      executor: workerExecutor,
      preparedSecretInvoker: createPreparedSecretInvoker(client),
      skillMaterializer,
      spool,
    });
    if (optionalEnvironmentValue("BAKERY_WORKER_STARTUP_MARKER") === "1") {
      console.log("WORKER_SUPERVISOR_STARTUP_REACHED");
    }
    options.onSupervisor?.(supervisor);
    let shutdownSignal: "SIGTERM" | "SIGINT" | undefined;
    const drainForSigterm = () => {
      shutdownSignal ??= "SIGTERM";
      void supervisor.drain();
    };
    const drainForSigint = () => {
      shutdownSignal ??= "SIGINT";
      void supervisor.drain();
    };
    Deno.addSignalListener("SIGTERM", drainForSigterm);
    Deno.addSignalListener("SIGINT", drainForSigint);
    try {
      await supervisor.run();
      if (supervisor.fatalReason) {
        throw supervisor.fatalError ?? new Error(supervisor.fatalReason);
      }
      if (config.shutdownReceiptLaunchId && shutdownSignal === "SIGTERM") {
        shutdownReceiptIdentity = supervisor.shutdownIdentity ?? undefined;
        if (!shutdownReceiptIdentity) {
          throw new Error("WORKER_SHUTDOWN_IDENTITY_MISSING");
        }
      }
    } finally {
      Deno.removeSignalListener("SIGTERM", drainForSigterm);
      Deno.removeSignalListener("SIGINT", drainForSigint);
    }
  } catch (error) {
    if (error instanceof WorkerShutdownQuiescenceError) {
      releaseStateLock = false;
      if (!import.meta.main) {
        await error.quiescence;
        releaseStateLock = true;
      }
    }
    throw error;
  } finally {
    if (releaseStateLock) await stateLock.release();
  }
  if (config.shutdownReceiptLaunchId && shutdownReceiptIdentity) {
    await publishWorkerShutdownReceipt({
      stateDir: config.stateDir,
      launchId: config.shutdownReceiptLaunchId,
      identity: shutdownReceiptIdentity,
    });
  }
}

if (import.meta.main) {
  let monitoring = disabledMonitoring;
  let failed = false;
  try {
    const config = readWorkerConfig();
    monitoring = await initializeDenoMonitoring(
      config.sentry,
      "worker",
      config.serverUrl,
    );
    await main({ config, monitoring });
  } catch (error) {
    failed = true;
    monitoring.capture(error);
    const message = error instanceof Error ? error.message : "";
    const code = /^[A-Z0-9_.:-]+$/.test(message)
      ? message
      : "WORKER_START_FAILED";
    console.error(`worker stopped: ${code}`);
    if (error instanceof NativeExecutorError && error.diagnostic) {
      console.error(`worker diagnostic: ${error.diagnostic}`);
    }
  } finally {
    await monitoring.close();
  }
  if (failed) Deno.exit(1);
}
