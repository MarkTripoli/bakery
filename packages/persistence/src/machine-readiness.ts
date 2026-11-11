import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "./postgres.ts";
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "./event-audit.ts";
import {
  WORKER_CHECK_EXPIRY_SECONDS,
  WORKER_OFFLINE_AFTER_SECONDS,
  WORKER_PROVIDER_AUTH_TTL_SECONDS,
  WORKER_STALE_AFTER_SECONDS,
} from "./constants.ts";
import type { RequestMetadata } from "./types.ts";

/** Check IDs that gate every capability of a machine when they fail. */
export const GLOBAL_CHECK_IDS = Object.freeze(
  [
    "credential_isolation",
    "supervisor_health",
    "spool_access",
    "disk_threshold",
    "protocol_compatible",
  ] as const,
);

/** Prefix of capability-gated check IDs: `capability:<capability>`. */
export const CAPABILITY_CHECK_PREFIX = "capability:";

export type MachineReadinessOptions = {
  /** How long idempotent replay rows stay answerable. */
  replayTtlSeconds: number;
  /** Enrollment token lifetime. */
  enrollmentTtlSeconds: number;
  randomSecret: () => string;
  hash: (value: string) => Promise<string>;
  /** Encrypts protected challenge material with the server secret. */
  protect: (value: unknown) => Promise<string>;
  /** Decrypts protected challenge material for same-attempt re-delivery. */
  unprotect: (value: string) => Promise<unknown>;
};

export type EnrollmentIntent = {
  name: string;
  os: string;
  architecture: string;
  capabilities: readonly string[];
  slots: number;
};

export type EnrollmentState =
  | "pending"
  | "consumed"
  | "canceled"
  | "expired";

export type EnrollmentInspection = {
  enrollmentId: string;
  organizationName: string;
  name: string;
  os: string;
  architecture: string;
  slots: number;
  capabilities: readonly string[];
  expiresAt: string;
  state: "pending" | "canceled" | "expired";
};

export type EnrollmentStatusResult = {
  response: Record<string, unknown>;
};

export type MutationWorkflowResult = {
  response: Record<string, unknown>;
  replayed: boolean;
};

export type InventoryComponentInput = {
  componentKey: string;
  kind: string;
  actualVersion: string;
  actualDigest?: string | null;
  installOwner: string;
  adapterVersion: string;
  availableVersion?: string | null;
  channel?: string | null;
  observedAt: string;
  capabilities: unknown;
  maintenanceSupport: unknown;
};

export type InventoryCheckInput = {
  checkId: string;
  checkVersion: string;
  componentKey?: string | null;
  status: string;
  reason?: string | null;
  observedAt: string;
};

export type InventoryReportInput = {
  reportId: string;
  expectedInventoryRevision: number;
  hostGeneration: number;
  components: readonly InventoryComponentInput[];
  checks: readonly InventoryCheckInput[];
};

export type StoredCheck = {
  checkId: string;
  componentKey: string | null;
  status: string;
  hostGeneration: number;
  inventoryRevision: number;
  expiresAt: Date | string;
  reason?: string | null;
};

export type ReadinessEvaluation = {
  state: "checking" | "ready" | "needs_attention";
  reason: string | null;
  failedCheckIds: string[];
};

export type ClaimGate = {
  allBlocked: boolean;
  blockedCapabilities: readonly string[];
};

export type ProviderAuthAttemptReportInput = {
  reportId: string;
  phase: "challenge_requested" | "completion" | "failure";
  result?: unknown;
};

/** Binding aggregates emit one event per mutation; the event stream version is
 * the next free version, not the row version, because attempt lifecycle events
 * also target the binding aggregate without bumping its row. */
function bindingEventVersion(
  transaction: PgTransactionClient,
  organizationId: string,
  bindingId: string,
): Promise<number> {
  return nextAggregateVersion(
    transaction,
    organizationId,
    bindingId,
    "worker.provider_binding_changed",
  );
}

export function derivedEnrollmentState(row: {
  consumedAt: Date | string | null;
  canceledAt: Date | string | null;
  expiresAt: Date | string;
  now: Date;
}): EnrollmentState {
  if (row.consumedAt) return "consumed";
  if (row.canceledAt) return "canceled";
  return new Date(row.expiresAt).getTime() > row.now.getTime()
    ? "pending"
    : "expired";
}

function isCapabilityCheck(checkId: string): boolean {
  return checkId.startsWith(CAPABILITY_CHECK_PREFIX);
}

function capabilityOfCheck(checkId: string): string | null {
  return isCapabilityCheck(checkId)
    ? checkId.slice(CAPABILITY_CHECK_PREFIX.length)
    : null;
}
type CheckFreshnessContext = {
  now: Date;
  credentialGeneration: number;
  inventoryRevision: number;
};

function isFreshCheck(
  check: StoredCheck,
  context: CheckFreshnessContext,
): boolean {
  return check.hostGeneration === context.credentialGeneration &&
    check.inventoryRevision === context.inventoryRevision &&
    new Date(check.expiresAt).getTime() > context.now.getTime();
}

function isBlockingCheck(check: StoredCheck): boolean {
  return check.status === "fail" || check.status === "unknown";
}

/**
 * Pure freshness/blocking rule shared by the claim gate and every safe
 * projection: a check only counts while its host generation and inventory
 * revision are current and its expiry is in the future. A fresh failed (or
 * unknown) global check blocks every capability; a fresh failed (or unknown)
 * capability check blocks exactly that capability. Old generations and
 * expired results are ignored — they can never restore readiness.
 */
export function blockingChecks(options: {
  now: Date;
  credentialGeneration: number;
  inventoryRevision: number;
  checks: readonly StoredCheck[];
}): {
  allBlocked: boolean;
  blockedCapabilities: string[];
  failedCheckIds: string[];
} {
  const blockedCapabilities = new Set<string>();
  const failedCheckIds = new Set<string>();
  let allBlocked = false;
  for (const check of options.checks) {
    if (!isFreshCheck(check, options) || !isBlockingCheck(check)) continue;
    failedCheckIds.add(check.checkId);
    const capability = capabilityOfCheck(check.checkId);
    if (capability === null) {
      allBlocked = true;
      continue;
    }
    blockedCapabilities.add(capability);
  }
  return {
    allBlocked,
    blockedCapabilities: [...blockedCapabilities].sort(),
    failedCheckIds: [...failedCheckIds].sort(),
  };
}
/** Connectivity derives only from the server's authenticated receipt time. */
export function connectivityState(
  lastHeartbeatAt: Date | string | null,
  now: Date,
): "online" | "stale" | "offline" {
  if (!lastHeartbeatAt) return "offline";
  const seconds = (now.getTime() - new Date(lastHeartbeatAt).getTime()) / 1000;
  if (seconds <= WORKER_STALE_AFTER_SECONDS) return "online";
  if (seconds <= WORKER_OFFLINE_AFTER_SECONDS) return "stale";
  return "offline";
}

/**
 * Server-derived readiness used by the safe projection and the claim gate.
 * Absence of checks is `checking`, never a false ready; a fresh failure is
 * `needs_attention`; revoked or unusable connectivity makes readiness fail.
 */
export function evaluateReadiness(options: {
  now: Date;
  connectivity: "online" | "stale" | "offline";
  status: string;
  desiredMode: string;
  credentialGeneration: number;
  inventoryRevision: number;
  checks: readonly StoredCheck[];
}): ReadinessEvaluation {
  if (options.status === "revoked" || options.desiredMode === "revoked") {
    return { state: "needs_attention", reason: "revoked", failedCheckIds: [] };
  }
  if (options.connectivity === "offline") {
    return { state: "needs_attention", reason: "offline", failedCheckIds: [] };
  }
  const blocking = blockingChecks({
    now: options.now,
    credentialGeneration: options.credentialGeneration,
    inventoryRevision: options.inventoryRevision,
    checks: options.checks,
  });
  if (blocking.failedCheckIds.length > 0) {
    return {
      state: "needs_attention",
      reason: options.connectivity === "stale" ? "stale" : "check_failed",
      failedCheckIds: blocking.failedCheckIds,
    };
  }
  if (options.connectivity === "stale") {
    return { state: "needs_attention", reason: "stale", failedCheckIds: [] };
  }
  const passingCapability = options.checks.some((check) => {
    const capability = capabilityOfCheck(check.checkId);
    return capability !== null &&
      check.status === "pass" &&
      check.hostGeneration === options.credentialGeneration &&
      check.inventoryRevision === options.inventoryRevision &&
      new Date(check.expiresAt).getTime() > options.now.getTime();
  });
  return passingCapability
    ? { state: "ready", reason: null, failedCheckIds: [] }
    : { state: "checking", reason: null, failedCheckIds: [] };
}

export type DispatchGateReason =
  | "revoked"
  | "offline"
  | "stale"
  | "check_failed"
  | "draining"
  | "paused";

export type DispatchGate = {
  reason: DispatchGateReason | null;
  allBlocked: boolean;
  blockedCapabilities: string[];
  failedChecks: Array<{ checkId: string; reason: string | null }>;
};

/**
 * The single dispatch rule shared by the worker claim gate and the
 * dispatch-blockers projection. `reason` precedence is revoked > offline >
 * stale > check_failed > draining > paused; the first four are exactly the
 * `evaluateReadiness` needs_attention reason, so the two projections cannot
 * disagree, except that a stored status of offline (set until the next
 * accepted heartbeat) reports offline ahead of stale or check_failed. `allBlocked` is computed independently of `reason`: it holds when
 * the host status is not online, the desired mode is not accepting,
 * connectivity is not online, or a fresh failed global check exists. Unknown
 * status or desired-mode values fail closed (blocked, reported as `paused`).
 */
export function dispatchGate(options: {
  now: Date;
  connectivity: "online" | "stale" | "offline";
  status: string;
  desiredMode: string;
  credentialGeneration: number;
  inventoryRevision: number;
  checks: readonly StoredCheck[];
}): DispatchGate {
  const blocking = blockingChecks(options);
  const readiness = evaluateReadiness(options);
  const reasons = new Map<string, string | null>();
  for (const check of options.checks) {
    if (
      isFreshCheck(check, options) &&
      isBlockingCheck(check) &&
      !reasons.has(check.checkId)
    ) {
      reasons.set(check.checkId, check.reason ?? null);
    }
  }
  let reason: DispatchGateReason | null = null;
  if (readiness.state === "needs_attention") {
    reason = readiness.reason as DispatchGateReason;
    if (
      options.status === "offline" && reason !== "revoked" &&
      reason !== "offline"
    ) {
      reason = "offline";
    }
  } else if (options.status === "offline") {
    reason = "offline";
  } else if (
    options.status === "draining" || options.desiredMode === "draining"
  ) {
    reason = "draining";
  } else if (
    options.status !== "online" || options.desiredMode !== "accepting"
  ) {
    reason = "paused";
  }
  const hostBlocked = options.status !== "online" ||
    options.desiredMode !== "accepting" || options.connectivity !== "online";
  return {
    reason,
    allBlocked: hostBlocked || blocking.allBlocked,
    blockedCapabilities: blocking.blockedCapabilities,
    failedChecks: blocking.failedCheckIds.map((checkId) => ({
      checkId,
      reason: reasons.get(checkId) ?? null,
    })),
  };
}

function assertHostGeneration(identity: {
  credentialGeneration: number;
}, reported: number): void {
  if (reported !== identity.credentialGeneration) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
}

function assertSafeText(
  value: string | null | undefined,
  code: "UNPROCESSABLE",
): void {
  if (value === undefined || value === null) return;
  if (new TextEncoder().encode(value).byteLength > 8_192) {
    throw new StandardError({ code });
  }
}

export type MachineReadinessWorkflows = {
  inspectEnrollment(options: {
    enrollmentHash: string;
  }): Promise<EnrollmentInspection | { state: "consumed" }>;
  enrollmentStatus(options: {
    organizationId: string;
    enrollmentId: string;
    now: Date;
  }): Promise<EnrollmentStatusResult>;
  cancelEnrollment(options: {
    organizationId: string;
    principalId: string;
    enrollmentId: string;
    idempotencyKey: string;
    requestDigest: string;
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  replaceEnrollment(options: {
    organizationId: string;
    principalId: string;
    enrollmentId: string;
    idempotencyKey: string;
    requestDigest: string;
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  repairEnrollment(options: {
    organizationId: string;
    principalId: string;
    workerHostId: string;
    idempotencyKey: string;
    requestDigest: string;
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  reportInventory(options: {
    identity: {
      tokenHash: string;
      host: {
        id: string;
        organizationId: string;
        principalId: string;
        capabilities: unknown;
        slots: number;
        status: string;
        desiredMode: string;
        credentialGeneration: number;
        inventoryRevision: number;
        readinessRevision: number;
      };
    };
    input: InventoryReportInput;
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  createProviderBinding(options: {
    organizationId: string;
    principalId: string;
    workerHostId: string;
    input: {
      componentKey: string;
      provider: string;
      billingRoute: string;
      authMode: string;
      credentialLocation: string;
      secretId?: string | null;
      enabled?: boolean;
    };
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  updateProviderBinding(options: {
    organizationId: string;
    principalId: string;
    workerHostId: string;
    bindingId: string;
    expectedVersion: number;
    input: {
      enabled?: boolean;
      billingRoute?: string;
      modelProviderAccountId?: string | null;
    };
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  createProviderAuthAttempt(options: {
    organizationId: string;
    principalId: string;
    workerHostId: string;
    bindingId: string;
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  getProviderAuthAttempt(options: {
    organizationId: string;
    workerHostId: string;
    bindingId: string;
    authAttemptId: string;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  cancelProviderAuthAttempt(options: {
    organizationId: string;
    principalId: string;
    workerHostId: string;
    bindingId: string;
    authAttemptId: string;
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
  reportProviderAuth(options: {
    identity: {
      tokenHash: string;
      host: {
        id: string;
        organizationId: string;
        principalId: string;
        credentialGeneration: number;
      };
    };
    authAttemptId: string;
    input: ProviderAuthAttemptReportInput;
    metadata: RequestMetadata;
    now: Date;
  }): Promise<MutationWorkflowResult>;
};

/**
 * Canonical JSON: object keys sorted recursively so a value and its jsonb
 * round-trip always serialize identically. Arrays keep their order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${
    entries.map(([key, entryValue]) =>
      `${JSON.stringify(key)}:${canonicalJson(entryValue)}`
    ).join(",")
  }}`;
}

/**
 * Canonical inventory fingerprint: stable JSON over a fixed field set per
 * component, sorted by component key. Both the stored rows and the incoming
 * report map onto this one shape, so an unchanged inventory never compares
 * unequal and a changed one always does.
 */
function componentFingerprint(
  components: readonly {
    componentKey: string;
    actualVersion: string;
    actualDigest?: string | null;
    installOwner: string;
    maintenanceSupport: unknown;
  }[],
): string {
  return canonicalJson(
    [...components].map((component) => ({
      key: component.componentKey,
      version: component.actualVersion,
      digest: component.actualDigest ?? null,
      owner: component.installOwner,
      support: component.maintenanceSupport ?? {},
    })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  );
}

/** Enrollment mutation verbs the idempotency ledger accepts. */
const MUTATION_VERBS = Object.freeze(
  [
    "cancel",
    "replace",
    "repair",
  ] as const,
);

/** Component and check vocabularies the inventory report writes. */
const COMPONENT_KINDS = Object.freeze(
  [
    "worker",
    "harness",
    "toolchain",
  ] as const,
);
const COMPONENT_INSTALL_OWNERS = Object.freeze(["bakery", "external"] as const);
const CHECK_STATUSES = Object.freeze(
  [
    "pass",
    "fail",
    "unknown",
    "not_applicable",
  ] as const,
);

/**
 * Transaction-code vocabulary guard: the migration carries no CHECK
 * constraints (PostgreSQL responsibility boundary keeps migrations
 * structural), so every server-written enum is asserted at its write site.
 */
function assertVocabulary(
  value: string,
  allowed: readonly string[],
): void {
  if (!allowed.includes(value)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

export function createMachineReadinessWorkflows(
  transaction: PgTransactionClient,
  config: MachineReadinessOptions,
): MachineReadinessWorkflows {
  async function replayForMutation(
    enrollmentId: string,
    verb: string,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<MutationWorkflowResult | undefined> {
    await transaction.query(
      `delete from bakery.worker_enrollment_mutations
       where enrollment_id = $1 and verb = $2 and idempotency_key = $3
         and expires_at <= clock_timestamp()`,
      [enrollmentId, verb, idempotencyKey],
    );
    const existing = await transaction.query<{
      request_digest: string;
      response: unknown;
    }>(
      `select request_digest, response
       from bakery.worker_enrollment_mutations
       where enrollment_id = $1 and verb = $2 and idempotency_key = $3`,
      [enrollmentId, verb, idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) return undefined;
    if (row.request_digest !== requestDigest) {
      throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    }
    return {
      response: row.response as Record<string, unknown>,
      replayed: true,
    };
  }

  async function saveMutationReplay(
    organizationId: string,
    enrollmentId: string,
    verb: string,
    idempotencyKey: string,
    requestDigest: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    assertVocabulary(verb, MUTATION_VERBS);
    await transaction.query(
      `insert into bakery.worker_enrollment_mutations (
         organization_id, enrollment_id, verb, idempotency_key,
         request_digest, response, expires_at
       ) values ($1, $2, $3, $4, $5, $6::jsonb,
         clock_timestamp() + ($7::integer * interval '1 second'))`,
      [
        organizationId,
        enrollmentId,
        verb,
        idempotencyKey,
        requestDigest,
        JSON.stringify(response),
        config.replayTtlSeconds,
      ],
    );
  }

  async function loadEnrollmentForUpdate(
    organizationId: string,
    enrollmentId: string,
    now: Date,
  ): Promise<{
    id: string;
    organizationId: string;
    principalId: string;
    name: string;
    os: string;
    architecture: string;
    capabilities: string[];
    slots: number;
    expiresAt: string;
    consumedAt: string | null;
    canceledAt: string | null;
    replacementOfId: string | null;
    /** Repair target set when a re-pair enrollment is issued; null otherwise. */
    targetWorkerHostId: string | null;
    /** Host recorded when a worker consumed the enrollment; null before. */
    registeredWorkerHostId: string | null;
    version: number;
    expectedCredentialGeneration: number | null;
    state: EnrollmentState;
  }> {
    const rows = await transaction.query<{
      id: string;
      organization_id: string;
      principal_id: string;
      name: string;
      os: string;
      architecture: string;
      allowed_capabilities: unknown;
      slots: number;
      expires_at: Date | string;
      consumed_at: Date | string | null;
      canceled_at: Date | string | null;
      replacement_of_id: string | null;
      target_worker_host_id: string | null;
      worker_host_id: string | null;
      version: number;
      expected_credential_generation: number | null;
    }>(
      `select id, organization_id, principal_id, name, os, architecture,
              allowed_capabilities, slots, expires_at, consumed_at, canceled_at,
              replacement_of_id, target_worker_host_id, worker_host_id, version,
              expected_credential_generation
       from bakery.worker_enrollments
       where organization_id = $1 and id = $2
       for update`,
      [organizationId, enrollmentId],
    );
    const row = rows.rows[0];
    if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const capabilities = Array.isArray(row.allowed_capabilities) &&
        row.allowed_capabilities.every((entry) => typeof entry === "string")
      ? (row.allowed_capabilities as string[])
      : [];
    const state = derivedEnrollmentState({
      consumedAt: row.consumed_at,
      canceledAt: row.canceled_at,
      expiresAt: row.expires_at,
      now,
    });
    return {
      id: row.id,
      organizationId: row.organization_id,
      principalId: row.principal_id,
      name: row.name,
      os: row.os,
      architecture: row.architecture,
      capabilities,
      slots: row.slots,
      expiresAt: new Date(row.expires_at).toISOString(),
      consumedAt: row.consumed_at
        ? new Date(row.consumed_at).toISOString()
        : null,
      canceledAt: row.canceled_at
        ? new Date(row.canceled_at).toISOString()
        : null,
      replacementOfId: row.replacement_of_id,
      targetWorkerHostId: row.target_worker_host_id,
      registeredWorkerHostId: row.worker_host_id,
      version: row.version,
      expectedCredentialGeneration: row.expected_credential_generation,
      state,
    };
  }

  async function appendEnrollmentEvent(
    organizationId: string,
    enrollmentId: string,
    state: EnrollmentState,
    workerHostId: string | null,
    metadata: RequestMetadata,
  ): Promise<void> {
    const versionResult = await transaction.query<{ version: number }>(
      `select version from bakery.worker_enrollments
       where organization_id = $1 and id = $2`,
      [organizationId, enrollmentId],
    );
    await appendDomainEvent(transaction, {
      organizationId,
      eventType: "worker_enrollment.updated",
      aggregateId: enrollmentId,
      aggregateVersion: versionResult.rows[0]?.version ?? 1,
      workerEnrollmentId: enrollmentId,
      workerHostId,
      payload: {
        resourceId: enrollmentId,
        resourceVersion: versionResult.rows[0]?.version ?? 1,
        state,
      },
      traceId: metadata.traceId,
    });
  }

  async function insertEnrollment(options: {
    organizationId: string;
    principalId: string;
    intent: EnrollmentIntent;
    replacementOfId: string | null;
    targetWorkerHostId: string | null;
    expectedCredentialGeneration: number | null;
    metadata: RequestMetadata;
    now: Date;
  }): Promise<{ id: string; token: string; expiresAt: string }> {
    const token = config.randomSecret();
    const tokenHash = await config.hash(token);
    const inserted = await transaction.query<
      { id: string; expires_at: Date | string }
    >(
      `insert into bakery.worker_enrollments (
         organization_id, principal_id, name, os, architecture,
         allowed_capabilities, slots, token_hash, expires_at,
         replacement_of_id, target_worker_host_id, expected_credential_generation
       ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8,
         clock_timestamp() + ($9::integer * interval '1 second'), $10, $11, $12)
       returning id, expires_at`,
      [
        options.organizationId,
        options.principalId,
        options.intent.name,
        options.intent.os,
        options.intent.architecture,
        JSON.stringify(options.intent.capabilities),
        options.intent.slots,
        tokenHash,
        config.enrollmentTtlSeconds,
        options.replacementOfId,
        options.targetWorkerHostId,
        options.expectedCredentialGeneration,
      ],
    );
    const row = inserted.rows[0];
    if (!row?.id) throw new Error("WORKER_ENROLLMENT_INSERT_FAILED");
    return {
      id: row.id,
      token,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  return {
    async inspectEnrollment({ enrollmentHash }) {
      const rows = await transaction.query<{
        id: string;
        organization_name: string;
        name: string;
        os: string;
        architecture: string;
        allowed_capabilities: unknown;
        slots: number;
        expires_at: Date | string;
        consumed_at: Date | string | null;
        canceled_at: Date | string | null;
      }>(
        `select e.id, e.name, e.os, e.architecture, e.allowed_capabilities,
                e.slots, e.expires_at, e.consumed_at, e.canceled_at,
                o.name as organization_name
         from bakery.worker_enrollments e
         join bakery.organizations o on o.id = e.organization_id
         where e.token_hash = $1`,
        [enrollmentHash],
      );
      const row = rows.rows[0];
      if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const now = new Date();
      if (row.consumed_at) return { state: "consumed" as const };
      const capabilities = Array.isArray(row.allowed_capabilities) &&
          row.allowed_capabilities.every((entry) => typeof entry === "string")
        ? (row.allowed_capabilities as string[])
        : [];
      return {
        enrollmentId: row.id,
        organizationName: row.organization_name,
        name: row.name,
        os: row.os,
        architecture: row.architecture,
        slots: row.slots,
        capabilities,
        expiresAt: new Date(row.expires_at).toISOString(),
        state: derivedEnrollmentState({
          consumedAt: null,
          canceledAt: row.canceled_at,
          expiresAt: row.expires_at,
          now,
        }) as "pending" | "canceled" | "expired",
      };
    },

    async enrollmentStatus({ organizationId, enrollmentId, now }) {
      const enrollment = await loadEnrollmentForUpdate(
        organizationId,
        enrollmentId,
        now,
      );
      // The machine this enrollment links to: the host a worker registered
      // when it consumed the enrollment (worker_host_id, set for first-time
      // and re-pair enrollments alike), else the repair target of a pending
      // or canceled re-pair enrollment. A first-time enrollment has no target,
      // so the registered host is the only link it has once consumed.
      const workerHostId = enrollment.registeredWorkerHostId ??
        enrollment.targetWorkerHostId;
      let worker: Record<string, unknown> | null = null;
      if (enrollment.consumedAt && workerHostId) {
        const hosts = await transaction.query(
          `select id from bakery.worker_hosts
           where organization_id = $1 and id = $2 and status <> 'revoked'`,
          [organizationId, workerHostId],
        );
        worker = hosts.rows.length > 0 ? { workerHostId } : null;
      }
      const cursor = await transaction.query<{ sequence: string }>(
        `select coalesce(max(organization_sequence), 0)::text as sequence
         from bakery.domain_events
         where organization_id = $1
           and (worker_enrollment_id = $2
             or worker_host_id = $3)`,
        [organizationId, enrollmentId, workerHostId],
      );
      return {
        response: {
          enrollmentId: enrollment.id,
          organizationId: enrollment.organizationId,
          state: enrollment.state,
          expiresAt: enrollment.expiresAt,
          workerHostId,
          worker,
          version: 1,
          snapshotCursor: cursor.rows[0]?.sequence ?? null,
        },
      };
    },

    async cancelEnrollment({
      organizationId,
      principalId,
      enrollmentId,
      idempotencyKey,
      requestDigest,
      metadata,
      now,
    }) {
      const replayed = await replayForMutation(
        enrollmentId,
        "cancel",
        idempotencyKey,
        requestDigest,
      );
      if (replayed) return replayed;
      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`worker-enrollment-cancel:${enrollmentId}`],
      );
      const enrollment = await loadEnrollmentForUpdate(
        organizationId,
        enrollmentId,
        now,
      );
      if (enrollment.state === "consumed" || enrollment.state === "canceled") {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const canceled = await transaction.query<{ version: number }>(
        `update bakery.worker_enrollments
         set canceled_at = current_timestamp, updated_at = current_timestamp,
             version = version + 1
         where organization_id = $1 and id = $2
         returning version`,
        [organizationId, enrollmentId],
      );
      await appendEnrollmentEvent(
        organizationId,
        enrollmentId,
        "canceled",
        enrollment.targetWorkerHostId,
        metadata,
      );
      await appendAudit(transaction, {
        organizationId,
        principalId,
        operation: "workerEnrollments.cancel",
        resourceType: "worker_enrollment",
        resourceId: enrollmentId,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
      });
      const response = {
        enrollmentId,
        organizationId,
        state: "canceled" as EnrollmentState,
        expiresAt: enrollment.expiresAt,
        workerHostId: null,
        worker: null,
        version: canceled.rows[0]?.version ?? enrollment.version,
        snapshotCursor: null,
      };
      await saveMutationReplay(
        organizationId,
        enrollmentId,
        "cancel",
        idempotencyKey,
        requestDigest,
        response,
      );
      return { response, replayed: false };
    },

    async replaceEnrollment({
      organizationId,
      principalId,
      enrollmentId,
      idempotencyKey,
      requestDigest,
      metadata,
      now,
    }) {
      const replayed = await replayForMutation(
        enrollmentId,
        "replace",
        idempotencyKey,
        requestDigest,
      );
      if (replayed) return replayed;
      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`worker-enrollment-cancel:${enrollmentId}`],
      );
      const predecessor = await loadEnrollmentForUpdate(
        organizationId,
        enrollmentId,
        now,
      );
      if (
        predecessor.state === "consumed" || predecessor.state === "canceled" ||
        predecessor.state === "expired"
      ) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const successor = await insertEnrollment({
        organizationId,
        principalId,
        intent: {
          name: predecessor.name,
          os: predecessor.os,
          architecture: predecessor.architecture,
          capabilities: predecessor.capabilities,
          slots: predecessor.slots,
        },
        replacementOfId: predecessor.id,
        targetWorkerHostId: null,
        expectedCredentialGeneration: null,
        metadata,
        now,
      });
      await transaction.query(
        `update bakery.worker_enrollments
         set canceled_at = current_timestamp, updated_at = current_timestamp,
             version = version + 1
         where organization_id = $1 and id = $2`,
        [organizationId, predecessor.id],
      );
      await appendEnrollmentEvent(
        organizationId,
        predecessor.id,
        "canceled",
        null,
        metadata,
      );
      await appendAudit(transaction, {
        organizationId,
        principalId,
        operation: "workerEnrollments.replace",
        resourceType: "worker_enrollment",
        resourceId: predecessor.id,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: { successorId: successor.id },
      });
      const response = {
        enrollmentId: successor.id,
        enrollmentToken: successor.token,
        expiresAt: successor.expiresAt,
      };
      await saveMutationReplay(
        organizationId,
        predecessor.id,
        "replace",
        idempotencyKey,
        requestDigest,
        response,
      );
      return { response, replayed: false };
    },

    async repairEnrollment({
      organizationId,
      principalId,
      workerHostId,
      idempotencyKey,
      requestDigest,
      metadata,
      now,
    }) {
      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`worker-repair:${organizationId}:${workerHostId}`],
      );
      // Repair replay: the ledger row is keyed by the enrollment the first
      // repair created, which a retry does not know; resolve it through the
      // target host instead.
      await transaction.query(
        `delete from bakery.worker_enrollment_mutations m
         using bakery.worker_enrollments e
         where e.organization_id = m.organization_id
           and e.id = m.enrollment_id
           and e.target_worker_host_id = $1
           and m.verb = 'repair' and m.idempotency_key = $2
           and m.expires_at <= clock_timestamp()`,
        [workerHostId, idempotencyKey],
      );
      const replay = await transaction.query<
        { request_digest: string; response: unknown }
      >(
        `select m.request_digest, m.response
         from bakery.worker_enrollment_mutations m
         join bakery.worker_enrollments e
           on e.organization_id = m.organization_id
           and e.id = m.enrollment_id
         where e.target_worker_host_id = $1
           and m.verb = 'repair' and m.idempotency_key = $2`,
        [workerHostId, idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow) {
        if (replayRow.request_digest !== requestDigest) {
          throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        }
        return {
          response: replayRow.response as Record<string, unknown>,
          replayed: true,
        };
      }
      const hosts = await transaction.query<{
        id: string;
        name: string;
        os: string;
        architecture: string;
        capabilities: unknown;
        slots: number;
        status: string;
        credential_generation: number;
      }>(
        `select id, name, os, architecture, capabilities, slots, status,
                credential_generation
         from bakery.worker_hosts
         where organization_id = $1 and id = $2
         for update`,
        [organizationId, workerHostId],
      );
      const host = hosts.rows[0];
      if (!host) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (host.status !== "revoked") {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      // A still-unconsumed repair enrollment for this host under a different
      // idempotency key owns the host's single pending-repair slot (partial
      // unique index); conflict instead of a raw unique violation.
      const pendingRepair = await transaction.query<{ id: string }>(
        `select id from bakery.worker_enrollments
         where organization_id = $1 and target_worker_host_id = $2
           and consumed_at is null and canceled_at is null`,
        [organizationId, workerHostId],
      );
      if (pendingRepair.rows.length > 0) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const enrollment = await insertEnrollment({
        organizationId,
        principalId,
        intent: {
          name: host.name,
          os: host.os,
          architecture: host.architecture,
          capabilities: Array.isArray(host.capabilities) &&
              host.capabilities.every((entry) => typeof entry === "string")
            ? (host.capabilities as string[])
            : [],
          slots: host.slots,
        },
        replacementOfId: null,
        targetWorkerHostId: host.id,
        expectedCredentialGeneration: host.credential_generation,
        metadata,
        now,
      });
      await appendEnrollmentEvent(
        organizationId,
        enrollment.id,
        "pending",
        host.id,
        metadata,
      );
      await appendAudit(transaction, {
        organizationId,
        principalId,
        operation: "workers.repairEnrollment",
        resourceType: "worker_enrollment",
        resourceId: enrollment.id,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: { workerHostId },
      });
      const response = {
        enrollmentId: enrollment.id,
        enrollmentToken: enrollment.token,
        expiresAt: enrollment.expiresAt,
      };
      await saveMutationReplay(
        organizationId,
        enrollment.id,
        "repair",
        idempotencyKey,
        requestDigest,
        response,
      );
      return { response, replayed: false };
    },

    async reportInventory({ identity, input, metadata }) {
      assertHostGeneration(identity.host, input.hostGeneration);
      const hostRow = identity.host;
      const replay = await transaction.query<
        { request_digest: string; response: unknown }
      >(
        `select request_digest, response
         from bakery.worker_inventory_replays
         where worker_host_id = $1 and report_id = $2
           and expires_at > clock_timestamp()`,
        [hostRow.id, input.reportId],
      );
      const replayRow = replay.rows[0];
      if (replayRow) {
        return {
          response: replayRow.response as Record<string, unknown>,
          replayed: true,
        };
      }
      if (input.expectedInventoryRevision !== hostRow.inventoryRevision) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const hostCapabilities = Array.isArray(hostRow.capabilities) &&
          hostRow.capabilities.every((entry) => typeof entry === "string")
        ? (hostRow.capabilities as string[]).map((entry) => entry.toLowerCase())
        : [];
      const componentKeys = new Set<string>();
      for (const component of input.components) {
        if (componentKeys.has(component.componentKey)) {
          throw new StandardError({ code: "UNPROCESSABLE" });
        }
        componentKeys.add(component.componentKey);
        const declared = Array.isArray(component.capabilities) &&
            component.capabilities.every((entry) => typeof entry === "string")
          ? (component.capabilities as string[]).map((entry) =>
            entry.toLowerCase()
          )
          : [];
        if (!declared.every((entry) => hostCapabilities.includes(entry))) {
          throw new StandardError({ code: "UNPROCESSABLE" });
        }
        assertSafeText(component.channel, "UNPROCESSABLE");
      }
      for (const check of input.checks) {
        if (check.componentKey !== undefined && check.componentKey !== null) {
          if (!componentKeys.has(check.componentKey)) {
            throw new StandardError({ code: "UNPROCESSABLE" });
          }
        }
        const capability = capabilityOfCheck(check.checkId);
        if (capability !== null && !hostCapabilities.includes(capability)) {
          throw new StandardError({ code: "UNPROCESSABLE" });
        }
        assertSafeText(check.reason, "UNPROCESSABLE");
      }

      // Both sides map onto the same canonical fingerprint shape (sorted
      // keys, shared field set, "[]" when empty), so an unchanged inventory
      // compares equal and does not bump the revision or emit an event.
      const beforeRows = await transaction.query<{
        component_key: string;
        actual_version: string;
        actual_digest: string | null;
        install_owner: string;
        maintenance_support: unknown;
      }>(
        `select component_key, actual_version, actual_digest, install_owner,
                maintenance_support
         from bakery.worker_components
         where worker_host_id = $1`,
        [hostRow.id],
      );
      const inventoryChanged =
        componentFingerprint(beforeRows.rows.map((row) => ({
          componentKey: row.component_key,
          actualVersion: row.actual_version,
          actualDigest: row.actual_digest,
          installOwner: row.install_owner,
          maintenanceSupport: row.maintenance_support,
        }))) !== componentFingerprint(input.components);

      await transaction.query(
        `delete from bakery.worker_components where worker_host_id = $1`,
        [hostRow.id],
      );
      for (const component of input.components) {
        assertVocabulary(component.kind, COMPONENT_KINDS);
        assertVocabulary(component.installOwner, COMPONENT_INSTALL_OWNERS);
        await transaction.query(
          `insert into bakery.worker_components (
             organization_id, worker_host_id, component_key, kind,
             actual_version, actual_digest, install_owner, adapter_version,
             available_version, channel, observed_at, capabilities,
             maintenance_support
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
          [
            hostRow.organizationId,
            hostRow.id,
            component.componentKey,
            component.kind,
            component.actualVersion,
            component.actualDigest ?? null,
            component.installOwner,
            component.adapterVersion,
            component.availableVersion ?? null,
            component.channel ?? null,
            new Date(component.observedAt),
            JSON.stringify(component.capabilities ?? []),
            JSON.stringify(component.maintenanceSupport ?? {}),
          ],
        );
      }
      for (const check of input.checks) {
        assertVocabulary(check.status, CHECK_STATUSES);
        await transaction.query(
          `insert into bakery.worker_checks (
             organization_id, worker_host_id, component_key, check_id,
             check_version, host_generation, inventory_revision, status,
             reason, observed_at, received_at, expires_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp(),
             clock_timestamp() + ($11::integer * interval '1 second'))
           on conflict (worker_host_id, check_id, coalesce(component_key, ''))
           do update set
             check_version = excluded.check_version,
             component_key = excluded.component_key,
             host_generation = excluded.host_generation,
             inventory_revision = excluded.inventory_revision,
             status = excluded.status,
             reason = excluded.reason,
             observed_at = excluded.observed_at,
             received_at = excluded.received_at,
             expires_at = excluded.expires_at,
             updated_at = current_timestamp,
             version = bakery.worker_checks.version + 1`,
          [
            hostRow.organizationId,
            hostRow.id,
            check.componentKey ?? null,
            check.checkId,
            check.checkVersion,
            input.hostGeneration,
            hostRow.inventoryRevision + (inventoryChanged ? 1 : 0),
            check.status,
            check.reason ?? null,
            new Date(check.observedAt),
            WORKER_CHECK_EXPIRY_SECONDS,
          ],
        );
      }
      const checksApplied = input.checks.length > 0;
      const newInventoryRevision = hostRow.inventoryRevision +
        (inventoryChanged ? 1 : 0);
      const newReadinessRevision = hostRow.readinessRevision +
        (inventoryChanged || checksApplied ? 1 : 0);
      await transaction.query(
        `update bakery.worker_hosts
         set inventory_revision = $2,
             readiness_revision = readiness_revision + $3,
             updated_at = current_timestamp, version = version + 1
         where organization_id = $1 and id = $4`,
        [
          hostRow.organizationId,
          newInventoryRevision,
          inventoryChanged || checksApplied ? 1 : 0,
          hostRow.id,
        ],
      );
      if (inventoryChanged) {
        await appendDomainEvent(transaction, {
          organizationId: hostRow.organizationId,
          eventType: "worker.inventory_changed",
          aggregateId: hostRow.id,
          aggregateVersion: newInventoryRevision,
          workerHostId: hostRow.id,
          payload: {
            resourceId: hostRow.id,
            resourceVersion: newInventoryRevision,
          },
          traceId: metadata.traceId,
        });
      }
      if (checksApplied) {
        await appendDomainEvent(transaction, {
          organizationId: hostRow.organizationId,
          eventType: "worker.readiness_changed",
          aggregateId: hostRow.id,
          aggregateVersion: await nextAggregateVersion(
            transaction,
            hostRow.organizationId,
            hostRow.id,
            "worker.readiness_changed",
          ),
          workerHostId: hostRow.id,
          payload: {
            resourceId: hostRow.id,
            resourceVersion: newInventoryRevision,
          },
          traceId: metadata.traceId,
        });
      }
      await appendAudit(transaction, {
        organizationId: hostRow.organizationId,
        principalId: hostRow.principalId,
        operation: "worker.reportInventory",
        resourceType: "worker_host",
        resourceId: hostRow.id,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: {
          reportId: input.reportId,
          inventoryRevision: newInventoryRevision,
        },
      });
      const response = {
        inventoryRevision: newInventoryRevision,
        readinessRevision: newReadinessRevision,
        acceptedComponents: input.components.length,
        acceptedChecks: input.checks.length,
        replayed: false,
      };
      await transaction.query(
        `insert into bakery.worker_inventory_replays (
           organization_id, worker_host_id, report_id, request_digest,
           response, expires_at
         ) values ($1, $2, $3, $4, $5::jsonb,
           clock_timestamp() + ($6::integer * interval '1 second'))`,
        [
          hostRow.organizationId,
          hostRow.id,
          input.reportId,
          JSON.stringify(input),
          JSON.stringify(response),
          config.replayTtlSeconds,
        ],
      );
      return { response, replayed: false };
    },

    async createProviderBinding({
      organizationId,
      principalId,
      workerHostId,
      input,
      metadata,
    }) {
      const hosts = await transaction.query<{ id: string; status: string }>(
        `select id, status from bakery.worker_hosts
         where organization_id = $1 and id = $2
         for update`,
        [organizationId, workerHostId],
      );
      const host = hosts.rows[0];
      if (!host) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (host.status === "revoked") {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      const component = await transaction.query<{ component_key: string }>(
        `select component_key from bakery.worker_components
         where worker_host_id = $1 and component_key = $2`,
        [workerHostId, input.componentKey],
      );
      if (component.rows.length === 0) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      if (
        (input.authMode === "api_secret") !==
          (input.credentialLocation === "bakery_secret")
      ) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      if (input.authMode === "api_secret" && !input.secretId) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      if (input.authMode === "host_native" && input.secretId) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      if (input.secretId) {
        const secret = await transaction.query<{ id: string }>(
          `select id from bakery.secrets
           where organization_id = $1 and id = $2`,
          [organizationId, input.secretId],
        );
        if (secret.rows.length === 0) {
          throw new StandardError({ code: "UNPROCESSABLE" });
        }
      }
      const inserted = await transaction.query<{ id: string }>(
        `insert into bakery.worker_provider_bindings (
           organization_id, worker_host_id, component_key, provider,
           billing_route, enabled, auth_mode, credential_location, secret_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id`,
        [
          organizationId,
          workerHostId,
          input.componentKey,
          input.provider,
          input.billingRoute,
          input.enabled ?? true,
          input.authMode,
          input.credentialLocation,
          input.secretId ?? null,
        ],
      );
      const bindingId = inserted.rows[0]?.id;
      if (!bindingId) throw new Error("WORKER_PROVIDER_BINDING_INSERT_FAILED");
      await appendDomainEvent(transaction, {
        organizationId,
        eventType: "worker.provider_binding_changed",
        aggregateId: bindingId,
        aggregateVersion: 1,
        workerHostId,
        payload: { resourceId: bindingId, resourceVersion: 1 },
        traceId: metadata.traceId,
      });
      await appendAudit(transaction, {
        organizationId,
        principalId,
        operation: "workerProviderBindings.create",
        resourceType: "worker_provider_binding",
        resourceId: bindingId,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: { provider: input.provider, componentKey: input.componentKey },
      });
      return {
        response: { bindingId },
        replayed: false,
      };
    },

    async updateProviderBinding({
      organizationId,
      principalId,
      workerHostId,
      bindingId,
      expectedVersion,
      input,
      metadata,
    }) {
      const bindings = await transaction.query<{
        id: string;
        version: number;
        enabled: boolean;
      }>(
        `select id, version, enabled from bakery.worker_provider_bindings
         where organization_id = $1 and worker_host_id = $2 and id = $3
         for update`,
        [organizationId, workerHostId, bindingId],
      );
      const binding = bindings.rows[0];
      if (!binding) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (binding.version !== expectedVersion) {
        throw new StandardError({ code: "PRECONDITION_FAILED" });
      }
      if (input.modelProviderAccountId !== undefined) {
        if (input.modelProviderAccountId !== null) {
          const account = await transaction.query<{ id: string }>(
            `select id from bakery.model_provider_accounts
             where organization_id = $1 and id = $2`,
            [organizationId, input.modelProviderAccountId],
          );
          if (account.rows.length === 0) {
            throw new StandardError({ code: "UNPROCESSABLE" });
          }
        }
        await transaction.query(
          `update bakery.worker_provider_bindings
           set model_provider_account_id = $3, updated_at = current_timestamp,
               version = version + 1
           where organization_id = $1 and id = $2`,
          [organizationId, bindingId, input.modelProviderAccountId],
        );
      }
      if (input.billingRoute !== undefined) {
        await transaction.query(
          `update bakery.worker_provider_bindings
           set billing_route = $3, updated_at = current_timestamp,
               version = version + 1
           where organization_id = $1 and id = $2`,
          [organizationId, bindingId, input.billingRoute],
        );
      }
      if (input.enabled !== undefined && input.enabled !== binding.enabled) {
        await transaction.query(
          `update bakery.worker_provider_bindings
           set enabled = $3, updated_at = current_timestamp,
               version = version + 1
           where organization_id = $1 and id = $2`,
          [organizationId, bindingId, input.enabled],
        );
        if (!input.enabled) {
          // Disabling fences the binding's active authorization immediately.
          await transaction.query(
            `update bakery.worker_provider_auth_attempts
             set state = 'canceled', updated_at = current_timestamp,
                 version = version + 1
             where worker_provider_binding_id = $1
               and state in ('pending', 'challenge_issued')`,
            [bindingId],
          );
        }
      }
      const versionRow = await transaction.query<{ version: number }>(
        `select version from bakery.worker_provider_bindings where id = $1`,
        [bindingId],
      );
      const bindingEventVersionValue = await bindingEventVersion(
        transaction,
        organizationId,
        bindingId,
      );
      await appendDomainEvent(transaction, {
        organizationId,
        eventType: "worker.provider_binding_changed",
        aggregateId: bindingId,
        aggregateVersion: bindingEventVersionValue,
        workerHostId,
        payload: {
          resourceId: bindingId,
          resourceVersion: versionRow.rows[0]?.version ?? 1,
        },
        traceId: metadata.traceId,
      });
      await appendAudit(transaction, {
        organizationId,
        principalId,
        operation: "workerProviderBindings.update",
        resourceType: "worker_provider_binding",
        resourceId: bindingId,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: { enabled: input.enabled ?? null },
      });
      return { response: { bindingId }, replayed: false };
    },

    async createProviderAuthAttempt({
      organizationId,
      principalId,
      workerHostId,
      bindingId,
      metadata,
      now,
    }) {
      const bindings = await transaction.query<{
        id: string;
        component_key: string;
        provider: string;
        enabled: boolean;
      }>(
        `select id, component_key, provider, enabled
         from bakery.worker_provider_bindings
         where organization_id = $1 and worker_host_id = $2 and id = $3
         for update`,
        [organizationId, workerHostId, bindingId],
      );
      const binding = bindings.rows[0];
      if (!binding) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (!binding.enabled) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      const hosts = await transaction.query<{ credential_generation: number }>(
        `select credential_generation from bakery.worker_hosts
         where organization_id = $1 and id = $2`,
        [organizationId, workerHostId],
      );
      const hostGeneration = hosts.rows[0]?.credential_generation;
      if (!hostGeneration) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const support = await transaction.query<{ maintenance_support: unknown }>(
        `select maintenance_support from bakery.worker_components
         where worker_host_id = $1 and component_key = $2`,
        [workerHostId, binding.component_key],
      );
      const remoteLogin = recordValue(support.rows[0]?.maintenance_support)
        ? String(
          (support.rows[0]!.maintenance_support as Record<string, unknown>)
            .remoteLogin ?? "none",
        )
        : "none";
      const expiresAt = new Date(
        now.getTime() + WORKER_PROVIDER_AUTH_TTL_SECONDS * 1000,
      ).toISOString();
      if (remoteLogin !== "device" && remoteLogin !== "browser") {
        // Terminal-only adapter: record the explicit handoff, never fabricate
        // a remote login flow.
        const inserted = await transaction.query<{ id: string }>(
          `insert into bakery.worker_provider_auth_attempts (
             organization_id, worker_provider_binding_id, worker_host_id,
             host_generation, requesting_principal_id, flow, state, result,
             expires_at
           ) values ($1, $2, $3, $4, $5, 'terminal', 'terminal', $6::jsonb, $7)
           returning id`,
          [
            organizationId,
            bindingId,
            workerHostId,
            hostGeneration,
            principalId,
            JSON.stringify({
              instructions:
                `Sign in to ${binding.provider} locally on the machine's terminal, then re-check the binding.`,
            }),
            expiresAt,
          ],
        );
        const attemptId = inserted.rows[0]?.id;
        if (!attemptId) {
          throw new Error("WORKER_PROVIDER_AUTH_ATTEMPT_INSERT_FAILED");
        }
        await appendDomainEvent(transaction, {
          organizationId,
          eventType: "worker.provider_binding_changed",
          aggregateId: bindingId,
          aggregateVersion: await bindingEventVersion(
            transaction,
            organizationId,
            bindingId,
          ),
          workerHostId,
          payload: { resourceId: attemptId, resourceVersion: 1 },
          traceId: metadata.traceId,
        });
        await appendAudit(transaction, {
          organizationId,
          principalId,
          operation: "workerProviderAuth.create",
          resourceType: "worker_provider_auth_attempt",
          resourceId: attemptId,
          requestId: metadata.requestId,
          traceId: metadata.traceId,
          details: { flow: "terminal" },
        });
        return {
          response: {
            authAttemptId: attemptId,
            flow: "terminal",
            state: "terminal",
            challenge: null,
            instructions:
              `Sign in to ${binding.provider} locally on the machine's terminal, then re-check the binding.`,
            expiresAt,
          },
          replayed: false,
        };
      }
      const inserted = await transaction.query<{ id: string }>(
        `insert into bakery.worker_provider_auth_attempts (
           organization_id, worker_provider_binding_id, worker_host_id,
           host_generation, requesting_principal_id, flow, state, expires_at
         ) values ($1, $2, $3, $4, $5, $6, 'pending', $7)
         returning id`,
        [
          organizationId,
          bindingId,
          workerHostId,
          hostGeneration,
          principalId,
          remoteLogin === "device" ? "remote_device" : "remote_browser",
          expiresAt,
        ],
      );
      const attemptId = inserted.rows[0]?.id;
      if (!attemptId) {
        throw new Error("WORKER_PROVIDER_AUTH_ATTEMPT_INSERT_FAILED");
      }
      await appendDomainEvent(transaction, {
        organizationId,
        eventType: "worker.provider_binding_changed",
        aggregateId: bindingId,
        aggregateVersion: await bindingEventVersion(
          transaction,
          organizationId,
          bindingId,
        ),
        workerHostId,
        payload: { resourceId: attemptId, resourceVersion: 1 },
        traceId: metadata.traceId,
      });
      await appendAudit(transaction, {
        organizationId,
        principalId,
        operation: "workerProviderAuth.create",
        resourceType: "worker_provider_auth_attempt",
        resourceId: attemptId,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: { flow: remoteLogin },
      });
      return {
        response: {
          authAttemptId: attemptId,
          flow: remoteLogin === "device" ? "remote_device" : "remote_browser",
          state: "pending",
          challenge: null,
          instructions: null,
          expiresAt,
        },
        replayed: false,
      };
    },

    async getProviderAuthAttempt({
      organizationId,
      workerHostId,
      bindingId,
      authAttemptId,
      now,
    }) {
      const attempts = await transaction.query<{
        id: string;
        state: string;
        flow: string;
        expires_at: Date | string;
        result: unknown;
      }>(
        `select id, state, flow, expires_at, result
         from bakery.worker_provider_auth_attempts
         where organization_id = $1 and worker_provider_binding_id = $2
           and worker_host_id = $3 and id = $4`,
        [organizationId, bindingId, workerHostId, authAttemptId],
      );
      const attempt = attempts.rows[0];
      if (!attempt) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      let state = attempt.state;
      if (
        (state === "pending" || state === "challenge_issued") &&
        new Date(attempt.expires_at).getTime() <= now.getTime()
      ) {
        await transaction.query(
          `update bakery.worker_provider_auth_attempts
           set state = 'expired', updated_at = current_timestamp,
               version = version + 1
           where id = $1 and state in ('pending', 'challenge_issued')`,
          [attempt.id],
        );
        state = "expired";
      }
      return {
        response: {
          id: attempt.id,
          bindingId,
          workerHostId,
          flow: attempt.flow,
          state,
          challenge: null,
          expiresAt: new Date(attempt.expires_at).toISOString(),
          result: attempt.result ?? null,
        },
        replayed: false,
      };
    },

    async cancelProviderAuthAttempt({
      organizationId,
      principalId,
      workerHostId,
      bindingId,
      authAttemptId,
      metadata,
    }) {
      const attempts = await transaction.query<{
        id: string;
        state: string;
        flow: string;
        expires_at: Date | string;
      }>(
        `select id, state, flow, expires_at from bakery.worker_provider_auth_attempts
         where organization_id = $1 and worker_provider_binding_id = $2
           and worker_host_id = $3 and id = $4
         for update`,
        [organizationId, bindingId, workerHostId, authAttemptId],
      );
      const attempt = attempts.rows[0];
      if (!attempt) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (
        attempt.state !== "pending" && attempt.state !== "challenge_issued"
      ) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      await transaction.query(
        `update bakery.worker_provider_auth_attempts
         set state = 'canceled', updated_at = current_timestamp,
             version = version + 1
         where id = $1`,
        [attempt.id],
      );
      await appendDomainEvent(transaction, {
        organizationId,
        eventType: "worker.provider_binding_changed",
        aggregateId: bindingId,
        aggregateVersion: await bindingEventVersion(
          transaction,
          organizationId,
          bindingId,
        ),
        workerHostId,
        payload: { resourceId: attempt.id, resourceVersion: 1 },
        traceId: metadata.traceId,
      });
      await appendAudit(transaction, {
        organizationId,
        principalId,
        operation: "workerProviderAuth.cancel",
        resourceType: "worker_provider_auth_attempt",
        resourceId: attempt.id,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
      });
      return {
        response: {
          id: attempt.id,
          bindingId,
          workerHostId,
          flow: attempt.flow,
          state: "canceled",
          challenge: null,
          expiresAt: new Date(attempt.expires_at).toISOString(),
          result: null,
        },
        replayed: false,
      };
    },

    async reportProviderAuth({
      identity,
      authAttemptId,
      input,
      metadata,
      now,
    }) {
      const hostRow = identity.host;
      const attempts = await transaction.query<{
        id: string;
        organization_id: string;
        worker_provider_binding_id: string;
        worker_host_id: string;
        host_generation: number;
        state: string;
        flow: string;
        expires_at: Date | string;
        result: unknown;
        protected_state: string | null;
      }>(
        `select id, organization_id, worker_provider_binding_id, worker_host_id,
                host_generation, state, flow, expires_at, result, protected_state
         from bakery.worker_provider_auth_attempts
         where organization_id = $1 and id = $2
         for update`,
        [hostRow.organizationId, authAttemptId],
      );
      const attempt = attempts.rows[0];
      if (!attempt) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      // The attempt must belong to the authenticated host and its binding;
      // cross-binding completion is refused.
      if (attempt.worker_host_id !== hostRow.id) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      assertHostGeneration(hostRow, attempt.host_generation);
      const expired = new Date(attempt.expires_at).getTime() <= now.getTime();
      const bindings = await transaction.query<{
        id: string;
        provider: string;
        billing_route: string;
        auth_generation: number;
      }>(
        `select id, provider, billing_route, auth_generation
         from bakery.worker_provider_bindings
         where organization_id = $1 and id = $2`,
        [hostRow.organizationId, attempt.worker_provider_binding_id],
      );
      const binding = bindings.rows[0];
      if (!binding) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

      if (input.phase === "challenge_requested") {
        const replay = await transaction.query<{ response: unknown }>(
          `select response from bakery.worker_provider_auth_reports
           where worker_provider_auth_attempt_id = $1 and report_id = $2
             and expires_at > clock_timestamp()`,
          [attempt.id, input.reportId],
        );
        const replayRow = replay.rows[0];
        if (replayRow) {
          // The ledger never stores the raw nonce. While the attempt is
          // still active, the same challenge is re-delivered from its
          // encrypted protected_state; once terminal, the replay returns
          // the attempt in its current state without any challenge
          // material.
          const replayedResponse = replayRow.response as Record<
            string,
            unknown
          >;
          if (
            !expired && attempt.state === "challenge_issued" &&
            attempt.protected_state
          ) {
            const challenge = await config.unprotect(attempt.protected_state);
            return {
              response: { ...replayedResponse, challenge },
              replayed: true,
            };
          }
          if (expired || attempt.state !== "pending") {
            return {
              response: {
                id: attempt.id,
                bindingId: attempt.worker_provider_binding_id,
                workerHostId: attempt.worker_host_id,
                flow: attempt.flow,
                state: attempt.state,
                expiresAt: new Date(attempt.expires_at).toISOString(),
                challenge: null,
                result: attempt.result ?? null,
              },
              replayed: true,
            };
          }
          return { response: replayedResponse, replayed: true };
        }
        if (
          expired ||
          attempt.state !== "pending" && attempt.state !== "challenge_issued"
        ) {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        const challenge = {
          nonce: config.randomSecret(),
          issuedAt: now.toISOString(),
          expiresAt: new Date(attempt.expires_at).toISOString(),
        };
        const protectedState = await config.protect(challenge);
        await transaction.query(
          `update bakery.worker_provider_auth_attempts
           set state = 'challenge_issued', protected_state = $2,
               updated_at = current_timestamp, version = version + 1
           where id = $1`,
          [attempt.id, protectedState],
        );
        // The stored response carries no challenge material: only the
        // encrypted protected_state on the attempt ever holds the nonce.
        const response = {
          id: attempt.id,
          bindingId: attempt.worker_provider_binding_id,
          workerHostId: attempt.worker_host_id,
          flow: attempt.flow,
          state: "challenge_issued",
          expiresAt: new Date(attempt.expires_at).toISOString(),
          challenge: null,
          result: null,
        };
        await transaction.query(
          `insert into bakery.worker_provider_auth_reports (
             organization_id, worker_provider_auth_attempt_id, report_id,
             request_digest, response, expires_at
           ) values ($1, $2, $3, $4, $5::jsonb,
             clock_timestamp() + ($6::integer * interval '1 second'))`,
          [
            hostRow.organizationId,
            attempt.id,
            input.reportId,
            JSON.stringify(input),
            JSON.stringify(response),
            config.replayTtlSeconds,
          ],
        );
        return {
          response: { ...response, challenge },
          replayed: false,
        };
      }

      if (input.phase === "failure") {
        if (
          expired ||
          attempt.state !== "pending" && attempt.state !== "challenge_issued"
        ) {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        await transaction.query(
          `update bakery.worker_provider_auth_attempts
           set state = 'failed', updated_at = current_timestamp,
               version = version + 1
           where id = $1`,
          [attempt.id],
        );
        await appendDomainEvent(transaction, {
          organizationId: hostRow.organizationId,
          eventType: "worker.provider_binding_changed",
          aggregateId: attempt.worker_provider_binding_id,
          aggregateVersion: await bindingEventVersion(
            transaction,
            hostRow.organizationId,
            attempt.worker_provider_binding_id,
          ),
          workerHostId: hostRow.id,
          payload: { resourceId: attempt.id, resourceVersion: 1 },
          traceId: metadata.traceId,
        });
        await appendAudit(transaction, {
          organizationId: hostRow.organizationId,
          principalId: hostRow.principalId,
          operation: "worker.reportProviderAuth",
          resourceType: "worker_provider_auth_attempt",
          resourceId: attempt.id,
          requestId: metadata.requestId,
          traceId: metadata.traceId,
          details: { phase: "failure" },
        });
        return {
          response: {
            id: attempt.id,
            bindingId: attempt.worker_provider_binding_id,
            workerHostId: attempt.worker_host_id,
            flow: attempt.flow,
            state: "failed",
            challenge: null,
            expiresAt: new Date(attempt.expires_at).toISOString(),
            result: null,
          },
          replayed: false,
        };
      }

      // completion: one winning completion inside one organization transaction.
      const replay = await transaction.query<{ response: unknown }>(
        `select response from bakery.worker_provider_auth_reports
         where worker_provider_auth_attempt_id = $1 and report_id = $2
           and expires_at > clock_timestamp()`,
        [attempt.id, input.reportId],
      );
      const replayRow = replay.rows[0];
      if (replayRow) {
        return {
          response: replayRow.response as Record<string, unknown>,
          replayed: true,
        };
      }
      if (
        expired ||
        (attempt.state !== "pending" && attempt.state !== "challenge_issued")
      ) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const completion = recordValue(input.result)
        ? input.result as Record<string, unknown>
        : null;
      const billingIdentity =
        completion && typeof completion.billingIdentity === "string" &&
          completion.billingIdentity.trim().length > 0
          ? completion.billingIdentity
          : null;
      const displayIdentity =
        completion && typeof completion.displayIdentity === "string" &&
          completion.displayIdentity.trim().length > 0
          ? completion.displayIdentity
          : null;
      if (!billingIdentity || !displayIdentity) {
        throw new StandardError({ code: "UNPROCESSABLE" });
      }
      if (
        completion && "bindingId" in completion &&
        completion.bindingId !== attempt.worker_provider_binding_id
      ) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const quotaSource =
        completion && typeof completion.quotaSource === "string"
          ? completion.quotaSource
          : null;
      const quotaRemaining =
        completion && typeof completion.quotaRemaining === "string" &&
          /^-?[0-9]+(\.[0-9]+)?$/.test(completion.quotaRemaining)
          ? completion.quotaRemaining
          : null;
      const identityHash = await config.hash(billingIdentity);
      const account = await transaction.query<{ id: string }>(
        `select id from bakery.model_provider_accounts
         where organization_id = $1 and provider = $2 and identity_hash = $3`,
        [hostRow.organizationId, binding.provider, identityHash],
      );
      let accountId = account.rows[0]?.id;
      if (!accountId) {
        const inserted = await transaction.query<{ id: string }>(
          `insert into bakery.model_provider_accounts (
             organization_id, provider, billing_identity, identity_hash,
             billing_route, display_identity, verified_at, auth_state,
             last_checked_at, quota_source, quota_remaining, quota_observed_at
           ) values ($1, $2, $3, $4, $5, $6, clock_timestamp(), 'signed_in',
             clock_timestamp(), $7, $8, clock_timestamp())
           returning id`,
          [
            hostRow.organizationId,
            binding.provider,
            billingIdentity,
            identityHash,
            binding.billing_route,
            displayIdentity,
            quotaSource,
            quotaRemaining,
          ],
        );
        accountId = inserted.rows[0]?.id;
      } else {
        await transaction.query(
          `update bakery.model_provider_accounts
           set verified_at = clock_timestamp(), auth_state = 'signed_in',
               last_checked_at = clock_timestamp(),
               quota_source = $3, quota_remaining = $4,
               quota_observed_at = clock_timestamp(),
               updated_at = current_timestamp, version = version + 1
           where organization_id = $1 and id = $2`,
          [hostRow.organizationId, accountId, quotaSource, quotaRemaining],
        );
      }
      if (!accountId) throw new Error("MODEL_PROVIDER_ACCOUNT_UPSERT_FAILED");
      const bindingUpdate = await transaction.query<
        { auth_generation: number }
      >(
        `update bakery.worker_provider_bindings
         set model_provider_account_id = $3, auth_generation = auth_generation + 1,
             last_checked_at = clock_timestamp(), updated_at = current_timestamp,
             version = version + 1
         where organization_id = $1 and id = $2
         returning auth_generation`,
        [hostRow.organizationId, attempt.worker_provider_binding_id, accountId],
      );
      const safeResult = {
        accountId,
        displayIdentity,
        quotaSource,
        quotaRemaining,
        bindingAuthGeneration: bindingUpdate.rows[0]?.auth_generation ?? null,
      };
      await transaction.query(
        `update bakery.worker_provider_auth_attempts
         set state = 'completed', completed_at = clock_timestamp(),
             result = $2::jsonb, protected_state = null,
             updated_at = current_timestamp, version = version + 1
         where id = $1`,
        [attempt.id, JSON.stringify(safeResult)],
      );
      await appendDomainEvent(transaction, {
        organizationId: hostRow.organizationId,
        eventType: "worker.provider_binding_changed",
        aggregateId: attempt.worker_provider_binding_id,
        aggregateVersion: await bindingEventVersion(
          transaction,
          hostRow.organizationId,
          attempt.worker_provider_binding_id,
        ),
        workerHostId: hostRow.id,
        payload: { resourceId: attempt.id, resourceVersion: 1 },
        traceId: metadata.traceId,
      });
      await appendAudit(transaction, {
        organizationId: hostRow.organizationId,
        principalId: hostRow.principalId,
        operation: "worker.reportProviderAuth",
        resourceType: "worker_provider_auth_attempt",
        resourceId: attempt.id,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
        details: { phase: "completion", accountId },
      });
      const response = {
        id: attempt.id,
        bindingId: attempt.worker_provider_binding_id,
        workerHostId: attempt.worker_host_id,
        flow: attempt.flow,
        state: "completed",
        challenge: null,
        expiresAt: new Date(attempt.expires_at).toISOString(),
        result: safeResult,
      };
      await transaction.query(
        `insert into bakery.worker_provider_auth_reports (
           organization_id, worker_provider_auth_attempt_id, report_id,
           request_digest, response, expires_at
         ) values ($1, $2, $3, $4, $5::jsonb,
           clock_timestamp() + ($6::integer * interval '1 second'))`,
        [
          hostRow.organizationId,
          attempt.id,
          input.reportId,
          JSON.stringify(input),
          JSON.stringify(response),
          config.replayTtlSeconds,
        ],
      );
      return { response, replayed: false };
    },
  };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
