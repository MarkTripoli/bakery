import { readJsonIfExists, writeJsonAtomically } from "./storage.ts";
import type {
  WorkerMaintenanceAssignment,
  WorkerMaintenanceReport,
} from "./types.ts";

/**
 * Remote maintenance on the worker (issue #25, slice B2).
 *
 * The heartbeat hands the host fenced maintenance assignments. Before this
 * executor changes anything on disk it writes a durable journal entry (write
 * a temporary file, fsync, rename). Each report it sends is journaled first
 * with its sequence and idempotency key, so a crash or a lost answer resends
 * the identical report and a duplicate assignment never executes twice.
 *
 * Recovery after a crash never trusts the journal phase alone: the digest
 * actually installed on disk decides the result.
 */

export type MaintenanceVerb = WorkerMaintenanceAssignment["verb"];
export type MaintenanceReportPhase = WorkerMaintenanceReport["phase"];

/** One release of a component as found on disk. */
export type ComponentRelease = Readonly<{
  digest: string;
  version: string;
  /** Version of the on-disk state layout this release reads and writes. */
  stateFormat: number;
}>;

/**
 * A versioned host adapter for one component. It maps typed verbs to fixed
 * local steps; it never runs shell input from the server.
 */
export interface MaintenanceComponentAdapter {
  readonly componentKey: string;
  /** `external` components are owned by the operator and never touched. */
  readonly installOwner: "bakery" | "external";
  supports(verb: MaintenanceVerb): boolean;
  /** The release installed now, read from disk, or null when absent. */
  installed(): Promise<ComponentRelease | null>;
  /** Read-only verification of the installed release. */
  verify(): Promise<{ ok: boolean; diagnostic?: string }>;
  /**
   * Stages the target next to the current release and verifies its digest.
   * Throws MaintenanceStepError("digest_mismatch") when it does not match.
   */
  stage(target: { digest: string; version: string | null }): Promise<
    ComponentRelease
  >;
  /** A staged or previous release with this digest, if still on disk. */
  release(digest: string): Promise<ComponentRelease | null>;
  /** Atomically makes this release the installed one. */
  switchTo(release: ComponentRelease): Promise<void>;
  /** Local health check of the installed release. */
  health(): Promise<boolean>;
  /** State format the component's on-disk state is in now. */
  stateFormat(): Promise<number>;
  remove(): Promise<void>;
}

/** A local maintenance step that failed with a stable reason. */
export class MaintenanceStepError extends Error {
  constructor(readonly reason: string, readonly diagnostic?: string) {
    super(reason);
    this.name = "MaintenanceStepError";
  }
}

/** Sends one report; throws an error carrying `status` and `retryable`. */
export type MaintenanceReporter = (
  operationId: string,
  body: WorkerMaintenanceReport,
  idempotencyKey: string,
) => Promise<void>;

type LocalPhase =
  | "accepted"
  | "applying"
  | "switching"
  | "switched"
  | "rolling_back"
  | "terminal";

type JournaledReport = {
  body: WorkerMaintenanceReport;
  idempotencyKey: string;
  acknowledged: boolean;
};

export type MaintenanceJournalEntry = {
  operationId: string;
  verb: MaintenanceVerb;
  componentKey: string | null;
  fence: string;
  deadlineAt: string;
  /** Last report sequence used; the next report uses sequence + 1. */
  sequence: number;
  localPhase: LocalPhase;
  target: { digest: string | null; version: string | null };
  /** The release installed before anything changed. */
  knownGood: ComponentRelease | null;
  lastReport: JournaledReport | null;
  /** Terminal outcome as this host knows it. */
  outcome?: MaintenanceReportPhase | "superseded";
  /** Claims stay closed until a person or a later operation recovers it. */
  holdClaims?: boolean;
  updatedAt: string;
};

export type MaintenanceJournal = {
  version: 1;
  /** Highest maintenance fence this host has accepted. */
  hostFence: string;
  entries: Record<string, MaintenanceJournalEntry>;
};

export const MAINTENANCE_JOURNAL_FILE = "maintenance-journal.json";
const MAX_TERMINAL_ENTRIES = 100;
const DEFAULT_REPORT_ATTEMPTS = 4;
const MUTATING: ReadonlySet<MaintenanceVerb> = new Set([
  "install_component",
  "update_component",
  "rollback_component",
  "remove_component",
]);

function emptyJournal(): MaintenanceJournal {
  return { version: 1, hostFence: "0", entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJournal(value: unknown): MaintenanceJournal {
  if (value === null) return emptyJournal();
  if (
    !isRecord(value) || value.version !== 1 ||
    typeof value.hostFence !== "string" || !/^[0-9]+$/.test(value.hostFence) ||
    !isRecord(value.entries)
  ) throw new Error("WORKER_MAINTENANCE_JOURNAL_INVALID");
  return value as MaintenanceJournal;
}

/** The durable journal; every write is an atomic replace of the file. */
export class MaintenanceJournalStore {
  private constructor(
    readonly path: string,
    private journal: MaintenanceJournal,
  ) {}

  static async open(stateDir: string): Promise<MaintenanceJournalStore> {
    const path = `${stateDir}/${MAINTENANCE_JOURNAL_FILE}`;
    return new MaintenanceJournalStore(
      path,
      parseJournal(await readJsonIfExists<unknown>(path)),
    );
  }

  get hostFence(): bigint {
    return BigInt(this.journal.hostFence);
  }

  entry(operationId: string): MaintenanceJournalEntry | undefined {
    const entry = this.journal.entries[operationId];
    return entry ? structuredClone(entry) : undefined;
  }

  entries(): MaintenanceJournalEntry[] {
    return Object.values(this.journal.entries).map((entry) =>
      structuredClone(entry)
    );
  }

  async save(entry: MaintenanceJournalEntry): Promise<void> {
    const next: MaintenanceJournal = structuredClone(this.journal);
    next.entries[entry.operationId] = {
      ...structuredClone(entry),
      updatedAt: new Date().toISOString(),
    };
    if (BigInt(entry.fence) > BigInt(next.hostFence)) {
      next.hostFence = entry.fence;
    }
    const finished = Object.values(next.entries)
      .filter((item) =>
        item.localPhase === "terminal" && item.lastReport?.acknowledged !==
          false &&
        !item.holdClaims
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const old of finished.slice(0, -MAX_TERMINAL_ENTRIES)) {
      delete next.entries[old.operationId];
    }
    await writeJsonAtomically(this.path, next, 0o600);
    this.journal = next;
  }
}

type ReportFields = Omit<WorkerMaintenanceReport, "fence" | "sequence">;

function releaseFields(
  release: ComponentRelease | null,
): Pick<WorkerMaintenanceReport, "installedDigest" | "installedVersion"> {
  return release
    ? { installedDigest: release.digest, installedVersion: release.version }
    : {};
}

function errorStatus(error: unknown): number | null {
  if (isRecord(error) && typeof error.status === "number") return error.status;
  return null;
}

function errorRetryable(error: unknown): boolean {
  if (isRecord(error) && typeof error.retryable === "boolean") {
    return error.retryable;
  }
  const status = errorStatus(error);
  return status === null || status >= 500 || status === 429;
}

export type MaintenanceExecutorOptions = {
  journal: MaintenanceJournalStore;
  adapters: readonly MaintenanceComponentAdapter[];
  report: MaintenanceReporter;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  reportAttempts?: number;
  log?: (event: string, details: Record<string, unknown>) => void;
};

/**
 * Runs maintenance assignments one at a time. It keeps claims closed while
 * any journal entry is unfinished, and recovers unfinished entries from the
 * installed digest before it accepts anything new.
 */
export class MaintenanceExecutor {
  private readonly journal: MaintenanceJournalStore;
  private readonly adapters: Map<string, MaintenanceComponentAdapter>;
  private readonly report: MaintenanceReporter;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reportAttempts: number;
  private readonly log: (
    event: string,
    details: Record<string, unknown>,
  ) => void;
  private recovered = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: MaintenanceExecutorOptions) {
    this.journal = options.journal;
    this.adapters = new Map(
      options.adapters.map((adapter) => [adapter.componentKey, adapter]),
    );
    this.report = options.report;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.reportAttempts = options.reportAttempts ?? DEFAULT_REPORT_ATTEMPTS;
    this.log = options.log ?? ((event, details) =>
      console.warn(JSON.stringify({
        component: "worker-maintenance",
        event,
        ...details,
      })));
  }

  /** True while any entry is unfinished or holds claims after a failure. */
  claimsClosed(): boolean {
    return this.journal.entries().some((entry) =>
      entry.localPhase !== "terminal" || entry.holdClaims === true
    );
  }

  /**
   * Accepts the assignments of one accepted heartbeat. Work is serialized;
   * the returned promise settles when these assignments are handled.
   */
  accept(
    assignments: readonly WorkerMaintenanceAssignment[],
  ): Promise<void> {
    const run = this.tail.then(async () => {
      if (!this.recovered) {
        await this.recover();
        this.recovered = true;
      }
      for (const assignment of assignments) {
        try {
          await this.handle(assignment);
        } catch (error) {
          this.log("maintenance_failed", {
            operationId: assignment.operationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Decides every unfinished entry from what is installed now. Runs once,
   * after the first accepted heartbeat, under that renewed authority.
   */
  async recover(): Promise<void> {
    for (const entry of this.journal.entries()) {
      if (entry.localPhase === "terminal") {
        if (entry.lastReport && !entry.lastReport.acknowledged) {
          await this.resend(entry);
        }
        continue;
      }
      try {
        await this.recoverEntry(entry);
      } catch (error) {
        this.log("maintenance_recovery_failed", {
          operationId: entry.operationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async recoverEntry(entry: MaintenanceJournalEntry): Promise<void> {
    if (entry.lastReport && !entry.lastReport.acknowledged) {
      if (!await this.resend(entry)) return;
      entry = this.journal.entry(entry.operationId) ?? entry;
      if (entry.localPhase === "terminal") return;
    }
    if (!MUTATING.has(entry.verb)) {
      // Read-only work has no local effect; run it again.
      await this.execute(entry);
      return;
    }
    const adapter = entry.componentKey
      ? this.adapters.get(entry.componentKey)
      : undefined;
    if (!adapter) {
      await this.finish(entry, { phase: "failed", reason: "unsupported" });
      return;
    }
    const installed = await adapter.installed();
    if (entry.verb === "remove_component") {
      await this.finish(
        entry,
        installed === null ? { phase: "succeeded", reason: "removed" } : {
          phase: "failed",
          reason: "switch_not_completed",
          ...releaseFields(installed),
        },
      );
      return;
    }
    const target = entry.target.digest;
    if (target !== null && installed?.digest === target) {
      await this.finish(entry, {
        phase: "succeeded",
        reason: "recovered",
        ...releaseFields(installed),
      });
      return;
    }
    if (
      installed !== null && entry.knownGood !== null &&
      installed.digest === entry.knownGood.digest
    ) {
      await this.finish(entry, {
        phase: entry.localPhase === "rolling_back" ? "rolled_back" : "failed",
        reason: entry.localPhase === "rolling_back"
          ? "health_check_failed"
          : "switch_not_completed",
        ...releaseFields(installed),
      });
      return;
    }
    // Neither the target nor the known-good release: say what is there and
    // keep claims closed until it is reconciled.
    await this.send(entry, {
      phase: "reconciling",
      reason: "unexpected_install",
      ...releaseFields(installed),
    });
    const after = this.journal.entry(entry.operationId) ?? entry;
    if (after.localPhase !== "terminal") {
      await this.journal.save({ ...after, holdClaims: true });
    }
  }

  private async handle(assignment: WorkerMaintenanceAssignment): Promise<void> {
    const fence = BigInt(assignment.fence);
    const existing = this.journal.entry(assignment.operationId);
    if (existing) {
      if (fence < BigInt(existing.fence)) {
        this.log("maintenance_stale_fence", {
          operationId: assignment.operationId,
        });
        return;
      }
      if (fence > BigInt(existing.fence)) {
        await this.journal.save({ ...existing, fence: assignment.fence });
      }
      const current = this.journal.entry(assignment.operationId) ?? existing;
      // A duplicate never re-executes: replay the last report, or recover
      // an unfinished entry from what is installed.
      if (current.localPhase === "terminal") {
        // The server may have lost our answer; the identical body replays.
        if (current.lastReport) await this.resend(current);
        return;
      }
      await this.recoverEntry(current);
      return;
    }
    if (fence < this.journal.hostFence) {
      this.log("maintenance_stale_fence", {
        operationId: assignment.operationId,
      });
      return;
    }
    const adapter = assignment.componentKey
      ? this.adapters.get(assignment.componentKey)
      : undefined;
    const entry: MaintenanceJournalEntry = {
      operationId: assignment.operationId,
      verb: assignment.verb,
      componentKey: assignment.componentKey ?? null,
      fence: assignment.fence,
      deadlineAt: assignment.deadlineAt,
      sequence: 0,
      localPhase: "accepted",
      target: {
        digest: assignment.targetDigest ?? null,
        version: assignment.targetVersion ?? null,
      },
      knownGood: adapter && adapter.installOwner === "bakery"
        ? await adapter.installed()
        : null,
      lastReport: null,
      updatedAt: new Date().toISOString(),
    };
    // Durable before any local change.
    await this.journal.save(entry);
    await this.execute(entry);
  }

  private async execute(entry: MaintenanceJournalEntry): Promise<void> {
    if (entry.verb === "refresh_inventory") {
      const components = [];
      for (const adapter of this.adapters.values()) {
        const installed = await adapter.installed();
        components.push({
          componentKey: adapter.componentKey,
          installOwner: adapter.installOwner,
          ...releaseFields(installed),
        });
      }
      await this.finish(entry, {
        phase: "succeeded",
        reason: "inventory_refreshed",
        diagnostic: JSON.stringify({ components }),
      });
      return;
    }
    const adapter = entry.componentKey
      ? this.adapters.get(entry.componentKey)
      : undefined;
    if (!adapter || !adapter.supports(entry.verb)) {
      await this.finish(entry, { phase: "failed", reason: "unsupported" });
      return;
    }
    if (adapter.installOwner === "external") {
      await this.finish(entry, {
        phase: "failed",
        reason: "externally_managed",
      });
      return;
    }
    if (entry.verb === "verify") {
      const installed = await adapter.installed();
      const verified = installed
        ? await adapter.verify()
        : { ok: false, diagnostic: "not installed" };
      await this.finish(entry, {
        phase: verified.ok ? "succeeded" : "failed",
        reason: verified.ok ? "verified" : "verify_failed",
        ...releaseFields(installed),
        ...(verified.diagnostic ? { diagnostic: verified.diagnostic } : {}),
      });
      return;
    }
    if (Date.parse(entry.deadlineAt) <= this.now().getTime()) {
      await this.finish(entry, { phase: "failed", reason: "deadline_passed" });
      return;
    }
    try {
      if (entry.verb === "remove_component") {
        await this.removeComponent(entry, adapter);
      } else if (entry.verb === "rollback_component") {
        await this.rollbackComponent(entry, adapter);
      } else {
        await this.updateComponent(entry, adapter);
      }
    } catch (error) {
      const current = this.journal.entry(entry.operationId) ?? entry;
      if (current.localPhase === "terminal") throw error;
      if (
        current.localPhase === "accepted" || current.localPhase === "applying"
      ) {
        await this.finish(current, {
          phase: "failed",
          reason: error instanceof MaintenanceStepError
            ? error.reason
            : "apply_failed",
          ...(error instanceof MaintenanceStepError && error.diagnostic
            ? { diagnostic: error.diagnostic }
            : {}),
          ...releaseFields(await adapter.installed()),
        });
        return;
      }
      // The switch may have started: only the disk can say what happened.
      await this.recoverEntry(current);
    }
  }

  private async updateComponent(
    entry: MaintenanceJournalEntry,
    adapter: MaintenanceComponentAdapter,
  ): Promise<void> {
    const target = entry.target.digest;
    if (target === null) {
      await this.finish(entry, { phase: "failed", reason: "target_missing" });
      return;
    }
    entry = await this.send(entry, { phase: "applying" }, "applying");
    if (entry.localPhase === "terminal") return;
    const staged = await adapter.stage({
      digest: target,
      version: entry.target.version,
    });
    if (staged.digest !== target) {
      throw new MaintenanceStepError("digest_mismatch");
    }
    await this.switchAndCheck(entry, adapter, staged);
  }

  private async rollbackComponent(
    entry: MaintenanceJournalEntry,
    adapter: MaintenanceComponentAdapter,
  ): Promise<void> {
    const target = entry.target.digest;
    const release = target ? await adapter.release(target) : null;
    if (!release) {
      await this.finish(entry, {
        phase: "failed",
        reason: "rollback_release_missing",
      });
      return;
    }
    if (release.stateFormat < await adapter.stateFormat()) {
      await this.finish(entry, {
        phase: "failed",
        reason: "rollback_incompatible_state",
        ...releaseFields(entry.knownGood),
      });
      return;
    }
    entry = await this.send(entry, { phase: "applying" }, "applying");
    if (entry.localPhase === "terminal") return;
    await this.switchAndCheck(entry, adapter, release);
  }

  private async removeComponent(
    entry: MaintenanceJournalEntry,
    adapter: MaintenanceComponentAdapter,
  ): Promise<void> {
    entry = await this.send(entry, { phase: "applying" }, "applying");
    if (entry.localPhase === "terminal") return;
    await this.journal.save({ ...entry, localPhase: "switching" });
    await adapter.remove();
    const installed = await adapter.installed();
    await this.finish(
      this.journal.entry(entry.operationId) ?? entry,
      installed === null ? { phase: "succeeded", reason: "removed" } : {
        phase: "failed",
        reason: "remove_failed",
        ...releaseFields(installed),
      },
    );
  }

  /**
   * The irreversible step. The journal says "switching" before the switch
   * and "switched" after it, so recovery knows a switch may have happened;
   * the installed digest still decides the result.
   */
  private async switchAndCheck(
    entry: MaintenanceJournalEntry,
    adapter: MaintenanceComponentAdapter,
    release: ComponentRelease,
  ): Promise<void> {
    entry = { ...entry, localPhase: "switching" };
    await this.journal.save(entry);
    await adapter.switchTo(release);
    entry = { ...entry, localPhase: "switched" };
    await this.journal.save(entry);
    if (await adapter.health()) {
      await this.finish(entry, {
        phase: "succeeded",
        ...releaseFields(await adapter.installed()),
      });
      return;
    }
    const knownGood = entry.knownGood;
    if (knownGood === null || knownGood.digest === release.digest) {
      await this.finish(entry, {
        phase: "failed",
        reason: "health_check_failed",
        ...releaseFields(await adapter.installed()),
      }, true);
      return;
    }
    // Never roll back across a state migration the old release cannot read.
    if (knownGood.stateFormat < await adapter.stateFormat()) {
      await this.finish(entry, {
        phase: "failed",
        reason: "rollback_incompatible_state",
        ...releaseFields(await adapter.installed()),
      }, true);
      return;
    }
    entry = { ...entry, localPhase: "rolling_back" };
    await this.journal.save(entry);
    await adapter.switchTo(knownGood);
    const restored = await adapter.installed();
    if (restored?.digest === knownGood.digest && await adapter.health()) {
      await this.finish(entry, {
        phase: "rolled_back",
        reason: "health_check_failed",
        ...releaseFields(restored),
      });
      return;
    }
    await this.finish(entry, {
      phase: "failed",
      reason: "rollback_failed",
      ...releaseFields(restored),
    }, true);
  }

  /** Sends a final report and marks the entry terminal. */
  private async finish(
    entry: MaintenanceJournalEntry,
    fields: ReportFields,
    holdClaims = false,
  ): Promise<void> {
    await this.send(entry, fields, "terminal", holdClaims);
  }

  /**
   * Journals the next report (sequence, body and idempotency key) and only
   * then sends it, so a resend after a crash is byte-identical.
   */
  private async send(
    entry: MaintenanceJournalEntry,
    fields: ReportFields,
    localPhase?: LocalPhase,
    holdClaims = false,
  ): Promise<MaintenanceJournalEntry> {
    const sequence = entry.sequence + 1;
    const body: WorkerMaintenanceReport = {
      ...fields,
      fence: entry.fence,
      sequence,
    };
    const next: MaintenanceJournalEntry = {
      ...entry,
      sequence,
      localPhase: localPhase ?? entry.localPhase,
      ...(localPhase === "terminal" ? { outcome: fields.phase } : {}),
      ...(holdClaims ? { holdClaims: true } : {}),
      lastReport: {
        body,
        idempotencyKey: crypto.randomUUID(),
        acknowledged: false,
      },
    };
    await this.journal.save(next);
    await this.resend(next);
    return this.journal.entry(entry.operationId) ?? next;
  }

  /**
   * Delivers the journaled last report, retrying transient failures. A 403
   * (stale fence or credential generation) stops the operation locally.
   * Returns true once the report is acknowledged.
   */
  private async resend(entry: MaintenanceJournalEntry): Promise<boolean> {
    const last = entry.lastReport;
    if (!last) return false;
    for (let attempt = 1;; attempt++) {
      try {
        await this.report(entry.operationId, last.body, last.idempotencyKey);
        await this.journal.save({
          ...entry,
          lastReport: { ...last, acknowledged: true },
        });
        return true;
      } catch (error) {
        const status = errorStatus(error);
        if (status === 403) {
          await this.journal.save({
            ...entry,
            localPhase: "terminal",
            outcome: "superseded",
            lastReport: { ...last, acknowledged: true },
          });
          this.log("maintenance_superseded", {
            operationId: entry.operationId,
          });
          return false;
        }
        if (status === 409) {
          // The server already finished this operation or refuses the
          // sequence; stop locally rather than retry it forever.
          await this.journal.save({
            ...entry,
            localPhase: "terminal",
            outcome: entry.outcome ?? "superseded",
            lastReport: { ...last, acknowledged: true },
          });
          return false;
        }
        if (!errorRetryable(error) || attempt >= this.reportAttempts) {
          this.log("maintenance_report_pending", {
            operationId: entry.operationId,
            sequence: last.body.sequence,
            status,
          });
          return false;
        }
        await this.sleep(Math.min(30_000, 500 * 2 ** (attempt - 1)));
      }
    }
  }
}
