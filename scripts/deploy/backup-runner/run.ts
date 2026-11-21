import type { Cutoff } from "../../../apps/server/src/modules/backups/cutoff-rules.ts";
import { cutoffFromView } from "./cutoff.ts";
import {
  ApiFatal,
  ApiUnavailable,
  type FailureCode,
  LeaseLost,
  type Maintenance,
  type ReportBody,
  ReportUndelivered,
  type RunnerApi,
  type RunnerSettings,
} from "./api.ts";
import { type Artifact, StepError } from "./backup-step.ts";
import { type Offsite, OffsiteError } from "./offsite.ts";
import { redact, type Secrets } from "./redact.ts";

/** What one pass of the runner did. */
export type RunOutcome =
  | { readonly kind: "idle" }
  | {
    readonly kind: "completed";
    readonly runId: string;
    readonly locations: readonly string[];
  }
  | {
    readonly kind: "failed";
    readonly runId: string;
    readonly code: FailureCode;
  }
  /** The backup was taken and kept on the host, but the off-site copy failed. */
  | {
    readonly kind: "not-copied";
    readonly runId: string;
    readonly code: NotCopiedCode;
  }
  | {
    readonly kind: "lease-lost";
    readonly runId: string;
    readonly reason: string;
  }
  | { readonly kind: "undelivered"; readonly runId: string };

export type RunnerDeps = {
  readonly api: RunnerApi;
  readonly secrets: Secrets;
  /** Takes the backup on this host; throws StepError. */
  readonly backup: (signal: AbortSignal, cutoff: Cutoff) => Promise<Artifact>;
  /** Reads what to upload to from the settings; null when there is no off-site copy. Throws OffsiteError. */
  readonly offsite: (settings: RunnerSettings) => Offsite | null;
  /** Uploads and verifies the set; throws OffsiteError. */
  readonly upload: (
    offsite: Offsite,
    artifact: Artifact,
    signal: AbortSignal,
    onFile: (done: number, total: number) => void,
  ) => Promise<void>;
  /** Best-effort retention after a completed run; failures never fail the backup. */
  readonly prune: (
    settings: RunnerSettings,
    offsite: Offsite | null,
    artifact: Artifact,
  ) => Promise<void>;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly log: (line: string) => void;
  /** How often a running report is sent while a long step runs; the lease is 300 seconds. */
  readonly heartbeatMs?: number;
  /** How long to wait for the installation to go quiet before giving up. */
  readonly drainTimeoutMs?: number;
  /** Milliseconds now; tests inject a clock that the injected sleep advances. */
  readonly now?: () => number;
};

export const HEARTBEAT_MS = 120_000;
/** The longest the runner waits for work in flight to finish before it gives up. */
export const DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Bounds on how long the runner sleeps between two drain checks. */
const DRAIN_POLL_MIN_MS = 1_000;
const DRAIN_POLL_MAX_MS = 30_000;
/** How long to wait after the server could not be reached before asking again. */
const DRAIN_RETRY_MS = 5_000;

/** The only causes the server accepts on a completed report: the off-site copy failed. */
export type NotCopiedCode = "destination_refused" | "destination_unreachable";

/**
 * A refusal stays a refusal; anything else about the off-site step (a dead
 * connection, a size that did not verify, an unexpected error) is mapped
 * conservatively to unreachable, with the real cause in the detail.
 */
export function notCopiedCode(code: FailureCode): NotCopiedCode {
  return code === "destination_refused"
    ? "destination_refused"
    : "destination_unreachable";
}

/** Progress points: reported, never lowered. */
const PROGRESS = {
  claimed: 0,
  quiet: 3,
  settings: 5,
  backedUp: 60,
  uploadSpan: 35,
} as const;

class Reporter {
  sequence = 0;
  progress = 0;
  /** Reports leave one at a time, in sequence order. */
  private chain: Promise<unknown> = Promise.resolve();
  closed = false;

  constructor(
    private readonly api: RunnerApi,
    private readonly runId: string,
    private readonly leaseToken: string,
    private readonly signal: AbortSignal,
  ) {}

  /** Sends one report in its turn; the sequence advances only when it was delivered. */
  send(body: ReportBody): Promise<void> {
    const turn = this.chain.then(async () => {
      if (this.closed) return;
      const next = this.sequence + 1;
      await this.api.report(
        this.runId,
        this.leaseToken,
        next,
        body,
        this.signal,
      );
      this.sequence = next;
      if (body.status !== "running") this.closed = true;
    });
    this.chain = turn.catch(() => {});
    return turn;
  }

  running(progress?: number): Promise<void> {
    if (progress !== undefined) {
      this.progress = Math.max(this.progress, progress);
    }
    return this.send({ status: "running", progressPercent: this.progress });
  }
}

function describe(error: unknown, secrets: Secrets): string {
  return redact(String((error as Error)?.message ?? error), secrets, 1000);
}

/**
 * One pass: ask for work and, when there is some, do it end to end.
 *
 * The order is the contract with the server: claim first, and only then read
 * the settings (every read that releases the off-site key pair is an audit row,
 * so an idle minutely poll must not make one). Reports carry the lease token and
 * count up from 1; a heartbeat keeps the lease alive while a long step runs.
 */
export async function runOnce(deps: RunnerDeps): Promise<RunOutcome> {
  const claim = await deps.api.claim();
  if (!claim.claimed) return { kind: "idle" };
  const { runId, leaseToken } = claim;
  deps.log(`claimed backup run ${runId}`);

  const work = new AbortController();
  const reporter = new Reporter(deps.api, runId, leaseToken, work.signal);
  let fatal: unknown = null;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;

  // The heartbeat: a running report whenever heartbeatMs passes without one.
  const stopHeartbeat = new AbortController();
  const heartbeat = (async () => {
    while (!stopHeartbeat.signal.aborted && !work.signal.aborted) {
      await deps.sleep(heartbeatMs, stopHeartbeat.signal);
      if (stopHeartbeat.signal.aborted || work.signal.aborted) return;
      try {
        await reporter.running();
      } catch (error) {
        // The lease is gone or reports cannot be delivered: stop the work now.
        fatal ??= error;
        work.abort();
        return;
      }
    }
  })();

  const finish = async (): Promise<RunOutcome> => {
    stopHeartbeat.abort();
    await heartbeat;
    return outcomeOf(fatal);
  };
  const outcomeOf = (error: unknown): RunOutcome => {
    if (error instanceof LeaseLost) {
      return { kind: "lease-lost", runId, reason: error.reason };
    }
    return { kind: "undelivered", runId };
  };

  /** Reports a terminal failure. If even that cannot be delivered the outcome says so. */
  const fail = async (
    code: FailureCode,
    detail: string,
  ): Promise<RunOutcome> => {
    stopHeartbeat.abort();
    await heartbeat;
    if (fatal !== null) return outcomeOf(fatal);
    try {
      await reporter.send({
        status: "failed",
        failureCode: code,
        failureDetail: redact(detail, deps.secrets, 1000),
      });
    } catch (error) {
      return outcomeOf(error);
    }
    deps.log(`backup run ${runId} failed: ${code}`);
    return { kind: "failed", runId, code };
  };

  try {
    await reporter.running(PROGRESS.claimed);

    // Hold the installation and wait for it to go quiet before anything else:
    // no snapshot is taken while work is still in flight. Entering stops the
    // server admitting new work; each later ask re-checks the drain. Every way
    // out of here ends in a terminal report, which lets go; if the runner dies
    // instead, the hold lapses with the claim.
    const drainTimeoutMs = deps.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    const now = deps.now ?? Date.now;
    const drainStartedAt = now();
    for (;;) {
      let view: Maintenance | null = null;
      try {
        view = await deps.api.maintain(runId, leaseToken, work.signal);
      } catch (error) {
        if (fatal !== null) return await finish();
        if (error instanceof ApiFatal) {
          return await fail(
            "runner_error",
            `The runner could not hold the installation for the snapshot. ${
              describe(error, deps.secrets)
            }`,
          );
        }
        if (!(error instanceof ApiUnavailable)) throw error;
        // The server could not be reached: ask again inside the same window.
        if (now() - drainStartedAt >= drainTimeoutMs) {
          return await fail(
            "runner_error",
            `The runner could not reach the server to hold the installation. ${
              describe(error, deps.secrets)
            }`,
          );
        }
        await deps.sleep(DRAIN_RETRY_MS, work.signal);
        if (fatal !== null) return await finish();
        continue;
      }
      if (fatal !== null) return await finish();
      if (view.state === "quiesced") break;
      if (now() - drainStartedAt >= drainTimeoutMs) {
        return await fail(
          "drain_timeout",
          `The installation did not go quiet within ${
            Math.round(drainTimeoutMs / 60_000)
          } minutes: ${view.liveAttempts} worker attempts and ${view.openTransactions} open transactions were still in flight. No backup was taken.`,
        );
      }
      await deps.sleep(
        Math.min(
          DRAIN_POLL_MAX_MS,
          Math.max(DRAIN_POLL_MIN_MS, view.retryAfterSeconds * 1000),
        ),
        work.signal,
      );
      if (fatal !== null) return await finish();
    }
    // Progress only moves up; the next report carries it, so a quiet
    // installation adds no extra report of its own.
    reporter.progress = Math.max(reporter.progress, PROGRESS.quiet);

    let settings: RunnerSettings;
    try {
      settings = await deps.api.settings(work.signal);
    } catch (error) {
      if (error instanceof ApiFatal || error instanceof ApiUnavailable) {
        return await fail(
          "runner_error",
          `The runner could not read its settings. ${
            describe(error, deps.secrets)
          }`,
        );
      }
      throw error;
    }
    for (
      const secret of [
        settings.offsiteAccessKeyId,
        settings.offsiteSecretAccessKey,
      ]
    ) {
      if (secret) deps.secrets.values.add(secret);
    }
    await reporter.running(PROGRESS.settings);

    // The cutoff comes AFTER the installation is quiet and BEFORE the dumps
    // start, from the database clock: it is the moment everything in the set was
    // read at or after, and the census of effects still unsettled then.
    let cutoff: Cutoff;
    try {
      cutoff = cutoffFromView(
        await deps.api.cutoff(runId, leaseToken, work.signal),
      );
    } catch (error) {
      if (error instanceof ApiFatal || error instanceof ApiUnavailable) {
        return await fail(
          "runner_error",
          `The runner could not record the cutoff. No backup was taken. ${
            describe(error, deps.secrets)
          }`,
        );
      }
      throw error;
    }

    let artifact: Artifact;
    try {
      artifact = await deps.backup(work.signal, cutoff);
    } catch (error) {
      if (fatal !== null) return await finish();
      if (error instanceof StepError) {
        return await fail(error.code, error.detail);
      }
      return await fail("runner_error", describe(error, deps.secrets));
    }
    if (fatal !== null) return await finish();
    /**
     * The local backup exists; the off-site copy did not happen. The run is
     * COMPLETED on the host with the cause, not failed: the backup is safe here.
     * Retention afterwards prunes the local sets only.
     */
    const notCopied = async (
      code: FailureCode,
      detail: string,
    ): Promise<RunOutcome> => {
      stopHeartbeat.abort();
      await heartbeat;
      if (fatal !== null) return outcomeOf(fatal);
      const cause = notCopiedCode(code);
      const text = redact(detail, deps.secrets, 1000);
      try {
        await reporter.send({
          status: "completed",
          sizeBytes: String(artifact.totalBytes),
          locations: ["server-host"],
          failureCode: cause,
          ...(text === "" ? {} : { failureDetail: text }),
        });
      } catch (error) {
        return outcomeOf(error);
      }
      deps.log(
        `backup run ${runId} was taken but NOT copied off-site (${cause}): ${text}`,
      );
      try {
        await deps.prune(settings, null, artifact);
      } catch (error) {
        deps.log(`retention failed: ${describe(error, deps.secrets)}`);
      }
      return { kind: "not-copied", runId, code: cause };
    };

    // The destination is judged AFTER the local backup exists: a refused or
    // invalid off-site destination must not cost the backup itself.
    let offsite: Offsite | null;
    try {
      offsite = deps.offsite(settings);
    } catch (error) {
      if (error instanceof OffsiteError) {
        return await notCopied(error.code, error.detail);
      }
      return await notCopied("runner_error", describe(error, deps.secrets));
    }
    await reporter.running(offsite === null ? 90 : PROGRESS.backedUp);

    const locations = ["server-host"];
    if (offsite !== null) {
      try {
        await deps.upload(offsite, artifact, work.signal, (done, total) => {
          void reporter.running(
            PROGRESS.backedUp +
              Math.floor((PROGRESS.uploadSpan * done) / total),
          ).catch((error) => {
            fatal ??= error;
            work.abort();
          });
        });
      } catch (error) {
        if (fatal !== null) return await finish();
        if (error instanceof OffsiteError) {
          return await notCopied(error.code, error.detail);
        }
        return await notCopied("runner_error", describe(error, deps.secrets));
      }
      if (fatal !== null) return await finish();
      locations.push("off-site");
    }

    stopHeartbeat.abort();
    await heartbeat;
    if (fatal !== null) return outcomeOf(fatal);
    await reporter.send({
      status: "completed",
      sizeBytes: String(artifact.totalBytes),
      locations,
    });
    deps.log(`backup run ${runId} completed: ${locations.join(", ")}`);

    // Retention is housekeeping after the fact: a failure is logged, never reported.
    try {
      await deps.prune(settings, offsite, artifact);
    } catch (error) {
      deps.log(`retention failed: ${describe(error, deps.secrets)}`);
    }
    return { kind: "completed", runId, locations };
  } catch (error) {
    if (error instanceof LeaseLost || error instanceof ReportUndelivered) {
      work.abort();
      return await (async () => {
        stopHeartbeat.abort();
        await heartbeat;
        return outcomeOf(error);
      })();
    }
    // An unexpected bug: say so rather than leave the run to lapse.
    return await fail("runner_error", describe(error, deps.secrets));
  }
}
