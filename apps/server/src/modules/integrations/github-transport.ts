import { StandardError } from "@bakery/contracts/http";
import {
  boundRetryAfterSeconds,
  retryAfterSeconds,
} from "../../platform/retry-after.ts";

/*
 * The bounded, no-redirect HTTP transport every GitHub App client call goes
 * through, and the classification of GitHub's failures. Nothing here ever
 * returns or throws GitHub's status text, headers or body.
 */

/** REST API version pinned on every GitHub App call Bakery makes. */
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_API_ORIGIN = "https://api.github.com";
/** GitHub's OAuth token endpoint for GitHub App user authorization. */
export const GITHUB_OAUTH_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
/** Default cap on one GitHub answer body. */
const MAX_RESPONSE_BYTES = 262_144;
/** Per-request deadline unless a client sets its own. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** GitHub refused the App JWT; never carries the provider body. */
export class GitHubRejected extends Error {
  constructor() {
    super("REJECTED_CREDENTIAL");
    this.name = "GitHubRejected";
  }
}
export const REJECTED_CREDENTIAL_STATUSES: readonly number[] = [401, 403, 404];

/** How GitHub failed a classified read, by status and rate-limit evidence. */
export type GitHubReadFailureKind =
  | "rejected"
  | "forbidden"
  | "rate_limited"
  | "timeout";

/** A rate limit GitHub names no reset for is waited out this long. */
export const DEFAULT_RATE_LIMIT_SECONDS = 60;

/**
 * A classified GitHub read failure. It is redacted by construction: a fixed
 * message, the kind and a bounded wait; never GitHub's status text, headers,
 * body or the request's credential.
 */
export class GitHubReadFailure extends Error {
  readonly kind: GitHubReadFailureKind;
  /** Whole seconds until GitHub accepts a rate-limited caller, 1..3600. */
  readonly retryAfterSeconds: number | null;
  constructor(kind: GitHubReadFailureKind, retryAfterSeconds: number | null) {
    super("GITHUB_READ_FAILURE");
    this.name = "GitHubReadFailure";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The fetch and per-request deadline every call of one client shares. */
export type Transport = { fetch: typeof fetch; timeoutMs: number };

/** GitHub's primary and secondary rate-limit answers on a 403 or 429. */
function isRateLimited(response: Response): boolean {
  return response.status === 429 ||
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after");
}

/**
 * Seconds until a rate-limited caller may retry: `Retry-After` (delta
 * seconds or an HTTP date), else `x-ratelimit-reset` (Unix seconds), else
 * one minute; always 1..3600 whole seconds.
 */
export function gitHubRetryAfterSeconds(headers: Headers, now: number): number {
  const after = retryAfterSeconds(headers, now);
  if (after !== undefined) return after;
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^[0-9]{1,12}$/.test(reset)) {
    return boundRetryAfterSeconds(Number(reset) - now / 1000);
  }
  return DEFAULT_RATE_LIMIT_SECONDS;
}

/**
 * The classified failure a non-success answer stands for, or null when it
 * is an ordinary outage. `token` reads a 401 as this installation token
 * rejected and a plain 403 as a permission GitHub no longer grants;
 * `provider` classifies only rate limits.
 */
function classifyFailure(
  response: Response,
  mode: "token" | "provider",
): GitHubReadFailure | null {
  if (response.redirected) return null;
  if (
    (response.status === 403 || response.status === 429) &&
    isRateLimited(response)
  ) {
    return new GitHubReadFailure(
      "rate_limited",
      gitHubRetryAfterSeconds(response.headers, Date.now()),
    );
  }
  if (mode !== "token") return null;
  if (response.status === 401) return new GitHubReadFailure("rejected", null);
  if (response.status === 403) return new GitHubReadFailure("forbidden", null);
  return null;
}

/**
 * One bounded, no-redirect JSON call; failures never echo the provider body.
 * `status` is the HTTP status GitHub answered with: the expected status for a
 * read body, or the listed status that read as absent, so a caller can tell a
 * moved resource (301, 308) from a missing one (404, 410).
 */
export async function readJson(
  transport: Transport,
  url: string,
  options: {
    method: "POST" | "GET" | "DELETE";
    expectedStatus: number;
    /**
     * Statuses read as "absent": the body is discarded and null returned with
     * the status kept. A 403 carrying a rate-limit signal is never absent: it
     * is a failure.
     */
    absentStatuses?: readonly number[];
    accept?: string;
    authorization?: string;
    body?: Record<string, unknown>;
    maxBytes?: number;
    /** Statuses that mean GitHub refused the credential rather than failed. */
    rejectedStatuses?: readonly number[];
    /**
     * Throw GitHubReadFailure for a rate limit, this client's own deadline
     * and, for `token`, a rejected (401) or forbidden (403) token. Absent
     * statuses still read as absent.
     */
    classify?: "token" | "provider";
  },
  signal: AbortSignal,
): Promise<{ body: unknown; link: string | null; status: number }> {
  const target = new URL(url);
  if (
    target.origin !== GITHUB_API_ORIGIN &&
    target.href !== GITHUB_OAUTH_TOKEN_URL
  ) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  // Set only when this client's own deadline fired, never the caller's abort.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = !signal.aborted;
    abort();
  }, transport.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const bytes = new Uint8Array(options.maxBytes ?? MAX_RESPONSE_BYTES);
  try {
    const response = await transport.fetch(target.href, {
      method: options.method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: options.accept ?? "application/vnd.github+json",
        "User-Agent": "Bakery",
        ...(target.origin === GITHUB_API_ORIGIN
          ? { "X-GitHub-Api-Version": GITHUB_API_VERSION }
          : {}),
        ...(options.authorization === undefined
          ? {}
          : { Authorization: options.authorization }),
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (
      !response.redirected && !isRateLimited(response) &&
      options.rejectedStatuses?.includes(response.status)
    ) {
      await response.body?.cancel().catch(() => {});
      throw new GitHubRejected();
    }
    if (
      options.absentStatuses?.includes(response.status) &&
      !response.redirected && !isRateLimited(response)
    ) {
      await response.body?.cancel().catch(() => {});
      return { body: null, link: null, status: response.status };
    }
    if (
      options.classify !== undefined &&
      response.status !== options.expectedStatus
    ) {
      const failure = classifyFailure(response, options.classify);
      if (failure !== null) {
        await response.body?.cancel().catch(() => {});
        throw failure;
      }
    }
    if (
      response.status === options.expectedStatus &&
      options.expectedStatus === 204 && !response.redirected
    ) {
      await response.body?.cancel().catch(() => {});
      return { body: null, link: null, status: response.status };
    }
    if (
      response.status !== options.expectedStatus || response.redirected ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error("REJECTED");
    }
    reader = response.body.getReader();
    let length = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      if (length + result.value.byteLength > bytes.length) {
        throw new Error("REJECTED");
      }
      bytes.set(result.value, length);
      length += result.value.byteLength;
    }
    controller.signal.throwIfAborted();
    return {
      body: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ),
      link: response.headers.get("link"),
      status: response.status,
    };
  } catch (error) {
    if (error instanceof GitHubRejected) throw error;
    if (error instanceof GitHubReadFailure) throw error;
    if (timedOut && options.classify !== undefined) {
      throw new GitHubReadFailure("timeout", null);
    }
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  } finally {
    bytes.fill(0);
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
