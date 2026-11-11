import type { WorkerApiClient } from "./client.ts";
import type { WorkerConfig } from "./config.ts";
import type { WorkerExecutor } from "./executor.ts";
import type { PreparedSecretInvoker } from "./prepared-secret-invoker.ts";
import type { SkillMaterializer } from "./skill-materializer.ts";
import type { RegistrationStore } from "./registration.ts";
import type { EventSpool } from "./spool.ts";
import type {
  ActiveAssignment,
  PendingHeartbeat,
  Sleep,
} from "./supervisor-support.ts";
import type { ControlPlaneState } from "./supervisor-control-plane.ts";
import {
  type ControlState,
  createControlState,
  type LocalTerminationEvidence,
} from "./control-state.ts";
import type { PublicationAuthority } from "./quarantine.ts";
import {
  createReadinessState,
  type ReadinessState,
} from "./supervisor-readiness.ts";
import type { RegistrationState, WorkerCommandOutcomeStatus } from "./types.ts";
export type SupervisorState = {
  config: WorkerConfig;
  client: WorkerApiClient;
  registrationStore: RegistrationStore;
  spool: EventSpool;
  executor: WorkerExecutor | null;
  preparedSecretInvoker: PreparedSecretInvoker | null;
  skillMaterializer: Pick<SkillMaterializer, "prepare" | "recover"> | null;
  skillRecoveryComplete: boolean;
  sleep: Sleep;
  processSessionId: string;
  processSessionGeneration: string;
  pendingHeartbeat: PendingHeartbeat | null;
  /**
   * Set at startup when the restored pending heartbeat still lists an attempt
   * released before the first heartbeat. The loop then sends the next
   * heartbeat without waiting a full interval so the server learns the release
   * at once. Cleared after that wait is skipped.
   */
  heartbeatImmediately: boolean;
  freshHeartbeatReady: boolean;
  readiness: ReadinessState;
  monotonicNow: () => number;
  latestAuthoritativeServerTimeMs: number | null;
  latestAuthoritativeServerTimeObservedAtMs: number | null;
  inFlightClaimController: AbortController | null;
  controlPlane: ControlPlaneState;
  processSessionAcquired: boolean;
  fatalFailure: boolean;
  active: Map<string, ActiveAssignment>;
  abandonmentTimers: Set<number>;
  abandonmentTasks: Set<Promise<void>>;
  executionTasks: Set<Promise<void>>;
  renewalTasks: Set<Promise<void>>;
  publicationAuthorities: Map<string, PublicationAuthority>;
  terminationEvidence: Map<string, LocalTerminationEvidence>;
  terminationCleanupCursor: string | null;
  terminationCleanupFailures: Map<string, number>;
  terminationCleanupRetries: Map<string, number>;
  terminationCleanupNextRetryAt: Map<string, number>;
  serverTerminalObservations: Set<string>;
  releasedJournalAttempts: Set<string>;
  lifecycleController: AbortController;
  registration: RegistrationState | null;
  commandOutcomes: Map<string, WorkerCommandOutcomeStatus>;
  controlState: ControlState;
  stopping: boolean;
  draining: boolean;
  drainFaulted: boolean;
  healthy: boolean;
  flushPromise: Promise<boolean> | null;
  flushAbortController: AbortController | null;
  drainPromise: Promise<void> | null;
  stopResolver: (() => void) | null;
  stopPromise: Promise<void> | null;
  standaloneReplayInProgress: boolean;
  lastFailure: string | null;
  sessionReadyResolved: boolean;
  sessionReadyResolver: () => void;
  sessionReadyPromise: Promise<void>;
};

export function createSupervisorState(options: {
  config: WorkerConfig;
  client: WorkerApiClient;
  registrationStore: RegistrationStore;
  spool: EventSpool;
  executor?: WorkerExecutor;
  preparedSecretInvoker?: PreparedSecretInvoker;
  skillMaterializer?: Pick<SkillMaterializer, "prepare" | "recover">;
  sleep: Sleep;
  monotonicNow?: () => number;
}): SupervisorState {
  const sessionReady = Promise.withResolvers<void>();
  return {
    config: options.config,
    client: options.client,
    registrationStore: options.registrationStore,
    spool: options.spool,
    executor: options.executor ?? null,
    preparedSecretInvoker: options.preparedSecretInvoker ?? null,
    skillMaterializer: options.skillMaterializer ?? null,
    skillRecoveryComplete: false,
    sleep: options.sleep,
    processSessionId: crypto.randomUUID(),
    processSessionGeneration: "0",
    pendingHeartbeat: null,
    heartbeatImmediately: false,
    freshHeartbeatReady: false,
    readiness: createReadinessState(),
    monotonicNow: options.monotonicNow ?? (() => performance.now()),
    latestAuthoritativeServerTimeMs: null,
    latestAuthoritativeServerTimeObservedAtMs: null,
    inFlightClaimController: null,
    controlPlane: {
      tail: Promise.resolve(),
      abortController: null,
      inFlight: new Set(),
    },
    processSessionAcquired: false,
    fatalFailure: false,
    active: new Map(),
    abandonmentTimers: new Set(),
    abandonmentTasks: new Set(),
    executionTasks: new Set(),
    renewalTasks: new Set(),
    publicationAuthorities: new Map(),
    terminationEvidence: new Map(),
    terminationCleanupCursor: null,
    terminationCleanupFailures: new Map(),
    terminationCleanupRetries: new Map(),
    terminationCleanupNextRetryAt: new Map(),
    serverTerminalObservations: new Set(),
    releasedJournalAttempts: new Set(),
    lifecycleController: new AbortController(),
    registration: null,
    commandOutcomes: new Map(),
    controlState: createControlState(),
    draining: false,
    drainFaulted: false,
    stopping: false,
    healthy: false,
    flushPromise: null,
    flushAbortController: null,
    drainPromise: null,
    stopResolver: null,
    stopPromise: null,
    standaloneReplayInProgress: false,
    lastFailure: null,
    sessionReadyResolved: false,
    sessionReadyResolver: sessionReady.resolve,
    sessionReadyPromise: sessionReady.promise,
  };
}
