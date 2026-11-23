import { join } from "node:path";
import { MaintenanceExecutor, MaintenanceJournalStore } from "./maintenance.ts";
import { workerMaintenanceAdapters } from "./maintenance-release.ts";
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
import { createClaudeJudgeTransport } from "./bounded-judge.ts";
import { createEvaluationExecutor } from "./evaluation-executor.ts";
import { createPiHarnessExecutor } from "./pi-harness.ts";
import { designToolAvailableFrom } from "./harness-rpi.ts";
import { createClaudeHarnessExecutor } from "./claude-harness.ts";
import { createToolGatewayFactory } from "./tool-gateway.ts";
import {
  discoverLocalMcpServers,
  LOCAL_MCP_DISCOVERY_INTERVAL_MS,
} from "./local-mcp-discovery.ts";
import { createCodexHarnessExecutor } from "./codex-harness.ts";
import { withSessionCredentialFile } from "./session-credential-file.ts";
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
import type { PluginJobDeps } from "./plugin-job-executor.ts";
import {
  jobCommand,
  PLUGIN_JOB_CAPABILITY,
  selectPluginRuntime,
  workerOwnedPaths,
} from "./plugin-job-select.ts";
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
    // Plugin jobs run only where a containment runtime proved its boundary just
    // now. Off unless an operator enables a runtime; an enabled runtime that
    // fails its probe leaves the capability unadvertised and logs why.
    const pluginEnv = {
      BAKERY_PLUGIN_JOBS_DOCKER: optionalEnvironmentValue(
        "BAKERY_PLUGIN_JOBS_DOCKER",
      ),
      BAKERY_PLUGIN_JOBS_BWRAP: optionalEnvironmentValue(
        "BAKERY_PLUGIN_JOBS_BWRAP",
      ),
      BAKERY_PLUGIN_JOB_IMAGE: optionalEnvironmentValue(
        "BAKERY_PLUGIN_JOB_IMAGE",
      ),
      BAKERY_PLUGIN_JOB_COMMAND: optionalEnvironmentValue(
        "BAKERY_PLUGIN_JOB_COMMAND",
      ),
    };
    const pluginRuntime = options.executor
      ? { kind: "none", reasons: [] } as const
      : await selectPluginRuntime(pluginEnv, {}, {
        hide: workerOwnedPaths(config),
      });
    if (pluginRuntime.kind === "selected") {
      if (!config.capabilities.includes(PLUGIN_JOB_CAPABILITY)) {
        config.capabilities.push(PLUGIN_JOB_CAPABILITY);
      }
    } else if (pluginRuntime.reasons.length > 0) {
      console.warn(JSON.stringify({
        component: "worker",
        event: "plugin_jobs_unavailable",
        reasons: pluginRuntime.reasons,
      }));
    }
    const pluginJobFor = pluginRuntime.kind === "selected"
      ? (assignment: JobAssignment): PluginJobDeps => {
        if (
          assignment.workerSessionId === undefined ||
          assignment.workerSessionGeneration === undefined
        ) throw new Error("PLUGIN_JOB_SESSION_MISSING");
        const proof = {
          leaseToken: assignment.leaseToken,
          fence: String(assignment.fence),
          workerSessionId: assignment.workerSessionId,
          workerSessionGeneration: String(assignment.workerSessionGeneration),
        };
        return {
          runtime: pluginRuntime.runtime,
          codeParent: `${config.stateDir}/plugin-jobs`,
          command: (entry, mount) => jobCommand(pluginEnv, entry, mount),
          fetchFiles: async (signal) =>
            (await client.getPluginJobFiles(
              assignment.attemptId,
              proof,
              signal,
            ))
              .value,
          relay: async (call, signal) => {
            const answer = (await client.callPluginBroker(
              assignment.attemptId,
              proof,
              call,
              signal,
            )).value;
            return answer.ok
              ? { ok: true as const, result: answer.result }
              : { ok: false as const, denial: answer.denial };
          },
        };
      }
      : undefined;
    if (pluginJobFor) {
      await Deno.mkdir(`${config.stateDir}/plugin-jobs`, {
        recursive: true,
        mode: 0o700,
      });
    }
    const nativeExecutor = options.executor ?? createNativeExecutor({
      publishArtifactFor,
      pluginJobFor,
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
    const baseExecutor = options.executor === undefined &&
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
    // `evaluation.check` and `evaluation.score` run in-process on the pinned
    // output bytes, so every production worker advertises them; an injected
    // test executor keeps exactly the actions it declares. The score judge
    // makes its one model call through the configured Claude Code CLI; any
    // other harness leaves it without a transport, so scores are unscored.
    const executor = options.executor === undefined
      ? createEvaluationExecutor(baseExecutor, {
        readAttemptContext: async (attemptId) => {
          const served = await client.attemptContext(attemptId);
          return served.value;
        },
        judge: codingHarness?.name === "claude"
          ? {
            transport: createClaudeJudgeTransport({
              authSourceDir: config.claudeAuthSourceDir ??
                join(home!, ".claude"),
              claudeExecutable: codingHarness.executable,
              model: codingHarness.model,
              stateDir: config.stateDir,
            }),
          }
          : {},
      })
      : baseExecutor;
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
        // The check executor seeds the attempt's context from the assignment's
        // pins. Without this the executor refuses every assignment that pins
        // inputs, so the reader is not an optimisation: it is the only way a
        // check with declared inputs can run at all.
        readAttemptContext: async (attemptId) => {
          const served = await client.attemptContext(attemptId);
          return served.value;
        },
      });
    // A coding harness writes a step's pinned inputs into its attempt root
    // before it starts, from the same route the check executor reads.
    const readAttemptContext = async (attemptId: string) => {
      const served = await client.attemptContext(attemptId);
      return served.value;
    };
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
        gatewayUrl: config.serverUrl,
        redactionSecrets: config.outputRedactionSecrets,
        authSourceDir: config.claudeAuthSourceDir ?? join(home!, ".claude"),
        readAttemptContext,
        // The design tool is a capability binding (#436): a Paper connection
        // bound to the step, its seat or its agent reaches the session through
        // the tool gateway, so the worker's own capability list no longer
        // decides it for the Claude harness.
        toolGateway: createToolGatewayFactory(client, async () => {
          const registration = await registrationStore.load();
          return registration?.workerSessionId === undefined ||
              registration.workerSessionGeneration === undefined
            ? null
            : {
              workerSessionId: registration.workerSessionId,
              workerSessionGeneration: String(
                registration.workerSessionGeneration,
              ),
            };
        }, { stdioAllowlist: config.mcpStdioAllowlist ?? [] }),
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
        gatewayUrl: config.serverUrl,
        piAgentSourceDir: piAgentSourceDir!,
        redactionSecrets: config.outputRedactionSecrets,
        capabilities: config.adapterCapabilities,
        readAttemptContext,
        designToolAvailable: designToolAvailableFrom(config.capabilities),
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
        gatewayUrl: config.serverUrl,
        authSourceDir: config.codexAuthSourceDir ?? join(home!, ".codex"),
        redactionSecrets: config.outputRedactionSecrets,
        readAttemptContext,
        designToolAvailable: designToolAvailableFrom(config.capabilities),
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
    // One wrapper around every adapter (#404): the session's operation
    // credential is written to an owner-only file for exactly as long as the
    // attempt runs, and the child environment is given its path, never the
    // value. Doing it here rather than per adapter is what keeps "does this
    // harness clean up" from being a per-harness question.
    const sessionAwareExecutor = withSessionCredentialFile(workerExecutor, {
      stateDir: config.stateDir,
    });
    await sessionAwareExecutor.initialize?.();
    const skillMaterializer = new SkillMaterializer(
      new SkillCache(config.stateDir),
      client,
    );
    const maintenanceAdapters = workerMaintenanceAdapters(config);
    if (maintenanceAdapters.length === 0) {
      console.warn(JSON.stringify({
        component: "worker-maintenance",
        event: "maintenance_no_managed_components",
      }));
    }
    const maintenance = new MaintenanceExecutor({
      journal: await MaintenanceJournalStore.open(config.stateDir),
      adapters: maintenanceAdapters,
      report: async (operationId, body, idempotencyKey) => {
        await client.reportMaintenance(operationId, body, idempotencyKey);
      },
    });
    const supervisor = new WorkerSupervisor({
      monitoring: options.monitoring,
      maintenance,
      config,
      client,
      registrationStore,
      // The wrapper, not the adapter chain: every attempt that holds a session
      // credential gets its file and loses it here.
      executor: sessionAwareExecutor,
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
    // Local stdio MCP servers placed on this host are discovered here (#441).
    // Only a Claude-harness host serves sessions their tools, so only it
    // looks; the first pass waits for registration to settle.
    const localDiscovery = codingHarness?.name === "claude"
      ? startLocalMcpDiscovery(client, config.mcpStdioAllowlist ?? [])
      : undefined;
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
      localDiscovery?.stop();
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

/** Runs local MCP discovery a minute after start, then every ten minutes. */
function startLocalMcpDiscovery(
  client: WorkerApiClient,
  allowlist: readonly string[],
): { stop(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pass = async () => {
    try {
      const outcomes = await discoverLocalMcpServers(client, {
        allowlist,
        signal: controller.signal,
      });
      for (const outcome of outcomes) {
        if (outcome.failure !== null) {
          console.error(JSON.stringify({
            event: "local_mcp_discovery_failed",
            connectionId: outcome.connectionId,
            code: outcome.failure,
          }));
        }
      }
    } catch {
      // Not registered yet, or the server is away: the next pass tries again.
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(pass, LOCAL_MCP_DISCOVERY_INTERVAL_MS);
    }
  };
  timer = setTimeout(pass, 60_000);
  return {
    stop() {
      controller.abort();
      clearTimeout(timer);
    },
  };
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
