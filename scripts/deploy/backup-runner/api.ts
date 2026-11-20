import { redact, type Secrets } from "./redact.ts";

/** Failure causes the server accepts on a failed report (the closed set). */
export type FailureCode =
  | "disk_full"
  | "destination_refused"
  | "destination_unreachable"
  | "key_missing"
  | "runner_error";

export type ReportBody = {
  readonly status: "running" | "completed" | "failed";
  readonly progressPercent?: number;
  readonly sizeBytes?: string;
  readonly locations?: readonly string[];
  readonly failureCode?: FailureCode;
  readonly failureDetail?: string;
};

export type Claim =
  | { readonly claimed: false }
  | {
    readonly claimed: true;
    readonly runId: string;
    readonly leaseToken: string;
    readonly leaseExpiresAt: string;
  };

export type RunnerSettings = {
  readonly scheduleEnabled: boolean;
  readonly daysToKeep: number;
  readonly offsiteConfigured: boolean;
  readonly offsiteEndpoint: string | null;
  readonly offsiteRegion: string | null;
  readonly offsiteBucket: string | null;
  readonly offsitePrefix: string | null;
  readonly offsiteAccessKeyId: string | null;
  readonly offsiteSecretAccessKey: string | null;
  readonly offsiteRefusal: string | null;
};

/** The runner credential was refused, or a request the runner built is invalid: retrying cannot help. */
export class ApiFatal extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`BACKUP_RUNNER_API_FATAL ${status} ${code}`);
  }
}

/** The server no longer accepts this run's reports: its lease lapsed or it already ended. */
export class LeaseLost extends Error {
  constructor(readonly reason: string) {
    super(`BACKUP_RUNNER_LEASE_LOST ${reason}`);
  }
}

/** A report could not be delivered after every retry; the lease will lapse on its own. */
export class ReportUndelivered extends Error {
  constructor() {
    super("BACKUP_RUNNER_REPORT_UNDELIVERED");
  }
}

/** A read that failed for a reason worth retrying later (network, 5xx). */
export class ApiUnavailable extends Error {
  constructor(detail: string) {
    super(`BACKUP_RUNNER_API_UNAVAILABLE ${detail}`);
  }
}

export type RunnerApi = {
  claim(signal?: AbortSignal): Promise<Claim>;
  settings(signal?: AbortSignal): Promise<RunnerSettings>;
  /** Sends one report; retries the SAME sequence and body on a network error or 5xx. */
  report(
    runId: string,
    leaseToken: string,
    sequence: number,
    body: ReportBody,
    signal?: AbortSignal,
  ): Promise<void>;
};

/** Waits before retry n (1-based); the last entry repeats. Bounded: about 31 seconds in total. */
export const REPORT_BACKOFF_MS: readonly number[] = [
  1000,
  2000,
  4000,
  8000,
  16000,
];

export type ApiOptions = {
  readonly baseUrl: string;
  readonly token: string;
  readonly secrets: Secrets;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly requestTimeoutMs?: number;
};

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

type Problem = { code?: string; reason?: string };

async function problemOf(response: Response): Promise<Problem> {
  try {
    const body = await response.json() as Problem;
    return typeof body === "object" && body !== null ? body : {};
  } catch {
    return {};
  }
}

export function createRunnerApi(options: ApiOptions): RunnerApi {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeout = options.requestTimeoutMs ?? 30_000;
  const base = options.baseUrl.replace(/\/+$/, "");
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${options.token}`,
    ...extra,
  });

  async function request(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timer = AbortSignal.timeout(timeout);
    try {
      return await doFetch(`${base}${path}`, {
        method,
        headers: headers(
          body === undefined ? {} : { "content-type": "application/json" },
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timer]) : timer,
      });
    } catch (error) {
      // No answer at all: refused connection, timeout, DNS. Never echo headers.
      throw new ApiUnavailable(
        redact(
          String((error as Error)?.message ?? error),
          options.secrets,
          200,
        ),
      );
    }
  }

  /** The common refusals: a bad credential or a request the runner built wrongly can never succeed. */
  async function assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const problem = await problemOf(response);
    if (response.status >= 500 || response.status === 429) {
      throw new ApiUnavailable(`status ${response.status}`);
    }
    throw new ApiFatal(response.status, problem.code ?? "UNKNOWN");
  }

  return {
    async claim(signal) {
      const response = await request(
        "POST",
        "/v1/backup-runner/claims",
        undefined,
        signal,
      );
      await assertOk(response);
      const body = await response.json() as {
        claimed: boolean;
        runId: string | null;
        leaseToken: string | null;
        leaseExpiresAt: string | null;
      };
      if (!body.claimed) return { claimed: false };
      if (!body.runId || !body.leaseToken || !body.leaseExpiresAt) {
        throw new ApiFatal(200, "MALFORMED_CLAIM");
      }
      return {
        claimed: true,
        runId: body.runId,
        leaseToken: body.leaseToken,
        leaseExpiresAt: body.leaseExpiresAt,
      };
    },

    async settings(signal) {
      const response = await request(
        "GET",
        "/v1/backup-runner/settings",
        undefined,
        signal,
      );
      await assertOk(response);
      return await response.json() as RunnerSettings;
    },

    async report(runId, leaseToken, sequence, body, signal) {
      const payload = { leaseToken, sequence, ...body };
      for (let attempt = 0;; attempt++) {
        let response: Response | null = null;
        try {
          response = await request(
            "POST",
            `/v1/backup-runner/runs/${runId}/reports`,
            payload,
            signal,
          );
        } catch (error) {
          if (!(error instanceof ApiUnavailable)) throw error;
        }
        if (response !== null && response.ok) return;
        if (
          response !== null && response.status < 500 && response.status !== 429
        ) {
          const problem = await problemOf(response);
          // 409: the lease lapsed, the run already ended, or a sequence rule
          // refused. The server will not take another report for this claim.
          if (response.status === 409) {
            throw new LeaseLost(problem.reason ?? problem.code ?? "conflict");
          }
          throw new ApiFatal(response.status, problem.code ?? "UNKNOWN");
        }
        // A network error or a 5xx: send the very same report again. The server
        // answers a replay of a stored sequence from its row, so a lost answer
        // never double-applies and never skips a number.
        if (attempt >= REPORT_BACKOFF_MS.length) throw new ReportUndelivered();
        await sleep(REPORT_BACKOFF_MS[attempt], signal);
        if (signal?.aborted) throw new ReportUndelivered();
      }
    },
  };
}
