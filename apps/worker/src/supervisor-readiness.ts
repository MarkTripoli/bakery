import { WorkerRequestError } from "./client.ts";
import type { SupervisorState } from "./supervisor-state.ts";
import type { WorkerInventoryCheck } from "./types.ts";

/**
 * Report refresh interval: half of the server's five-minute check expiry, so
 * a healthy host re-asserts its checks before they go stale while writing at
 * most one report per 150 s when nothing changes.
 */
export const READINESS_REFRESH_MS = 150_000;

const CAPABILITY_CHECK_PREFIX = "capability:";

export type ReadinessState = {
  /** Inventory revision from the latest non-replayed accepted heartbeat. */
  inventoryRevision: number | null;
  /** Inventory revision a report was last accepted for; null until then. */
  reportedRevision: number | null;
  /** Check id to status in the last accepted report. */
  reportedStatuses: Map<string, string> | null;
  /** Monotonic time of the last accepted report. */
  reportedAtMs: number | null;
  /** Latest local capability check results by capability name. */
  localCapabilityStatus: Map<string, string>;
};

export function createReadinessState(): ReadinessState {
  return {
    inventoryRevision: null,
    reportedRevision: null,
    reportedStatuses: null,
    reportedAtMs: null,
    localCapabilityStatus: new Map(),
  };
}

function capabilityOf(checkId: string): string | null {
  return checkId.startsWith(CAPABILITY_CHECK_PREFIX)
    ? checkId.slice(CAPABILITY_CHECK_PREFIX.length)
    : null;
}

function configuredCapabilityChecks(
  state: SupervisorState,
  checks: readonly WorkerInventoryCheck[],
): WorkerInventoryCheck[] {
  const configured = new Set(
    state.config.capabilities.map((capability) => capability.toLowerCase()),
  );
  return checks.filter((check) => {
    const capability = capabilityOf(check.checkId);
    return capability !== null && configured.has(capability.toLowerCase());
  });
}

function statusesOf(
  checks: readonly WorkerInventoryCheck[],
): Map<string, string> {
  return new Map(checks.map((check) => [check.checkId, check.status]));
}

function sameStatuses(
  left: ReadonlyMap<string, string> | null,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left === null || left.size !== right.size) return false;
  for (const [checkId, status] of right) {
    if (left.get(checkId) !== status) return false;
  }
  return true;
}

/** True when the executor reports local readiness checks. */
export function hasReadinessChecks(state: SupervisorState): boolean {
  return typeof state.executor?.readinessChecks === "function";
}

/**
 * Claim hold: with readiness checks in play, no claim until a report for the
 * current inventory revision has been accepted, so a host that just
 * registered or repaired cannot claim before its first check lands.
 */
export function claimHeldForReadiness(state: SupervisorState): boolean {
  if (!hasReadinessChecks(state)) return false;
  const { inventoryRevision, reportedRevision } = state.readiness;
  return inventoryRevision === null || reportedRevision !== inventoryRevision;
}

/** Capabilities to request: configured ones minus locally failing ones. */
export function claimableCapabilities(state: SupervisorState): string[] {
  const failing = state.readiness.localCapabilityStatus;
  return state.config.capabilities.filter((capability) => {
    const status = failing.get(capability.toLowerCase());
    return status === undefined || status === "pass" ||
      status === "not_applicable";
  });
}

function logReadiness(event: string, details: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    component: "worker-supervisor",
    event,
    ...details,
  }));
}

/**
 * Called after an accepted heartbeat. Records the heartbeat's revision (never
 * from a replayed response, which may carry an older one), collects local
 * checks and reports them when the revision or a status changed or the last
 * accepted report is at least READINESS_REFRESH_MS old. Failures are logged
 * and retried on the next heartbeat; STATE_CONFLICT simply re-bases on the
 * next heartbeat's revision.
 */
export async function refreshReadiness(
  state: SupervisorState,
  heartbeat: { inventoryRevision: number; replayed: boolean },
  signal: AbortSignal,
): Promise<void> {
  const readinessChecks = state.executor?.readinessChecks;
  if (!readinessChecks || !state.executor) return;
  const readiness = state.readiness;
  if (!heartbeat.replayed) {
    readiness.inventoryRevision = heartbeat.inventoryRevision;
  }
  const revision = readiness.inventoryRevision;
  const hostGeneration = state.registration?.registrationGeneration;
  if (revision === null || hostGeneration === undefined) return;
  let checks: WorkerInventoryCheck[];
  try {
    checks = configuredCapabilityChecks(
      state,
      await readinessChecks.call(state.executor),
    );
  } catch (error) {
    logReadiness("readiness_checks_failed", {
      code: error instanceof Error ? error.name : "UNKNOWN",
    });
    return;
  }
  readiness.localCapabilityStatus = new Map(
    checks.map((check) => [
      capabilityOf(check.checkId)!.toLowerCase(),
      check.status,
    ]),
  );
  const statuses = statusesOf(checks);
  if (checks.length === 0) {
    // Nothing applicable to report; there is nothing to hold claims for.
    readiness.reportedRevision = revision;
    readiness.reportedStatuses = statuses;
    return;
  }
  const now = state.monotonicNow();
  const due = readiness.reportedRevision !== revision ||
    !sameStatuses(readiness.reportedStatuses, statuses) ||
    readiness.reportedAtMs === null ||
    now - readiness.reportedAtMs >= READINESS_REFRESH_MS;
  if (!due) return;
  try {
    const response = await state.client.reportInventory({
      reportId: crypto.randomUUID(),
      expectedInventoryRevision: revision,
      hostGeneration,
      components: [],
      checks,
    }, signal);
    const accepted = response.value.inventoryRevision;
    readiness.inventoryRevision = accepted;
    readiness.reportedRevision = accepted;
    readiness.reportedStatuses = statuses;
    readiness.reportedAtMs = now;
  } catch (error) {
    if (state.stopping || signal.aborted) return;
    readiness.reportedRevision = null;
    readiness.reportedStatuses = null;
    const code = error instanceof WorkerRequestError
      ? error.code
      : "READINESS_REPORT_FAILED";
    logReadiness("readiness_report_failed", { code });
  }
}
