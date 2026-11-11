import { AuthProviderError } from "@bakery/contracts/auth-provider-client";
import type { ApiFailure } from "../api/client.ts";
import type { Connectivity } from "./connectivity-state.ts";

/**
 * Shared mapping from a failure to the async state a settings page renders
 * (design R12). Pages never re-read status codes themselves: a 403 is
 * `forbidden`, a 409 or 412 is `conflict`, a transport failure is `offline`,
 * anything else is a retryable `error`.
 */

/**
 * The shared async states every settings screen renders. `loading`, `empty`,
 * `error` and `forbidden` replace the screen body; `conflict`, `stale`,
 * `offline` and `reconnecting` put a notice above it so a draft survives.
 */
export type AsyncKind =
  | "loading"
  | "empty"
  | "error"
  | "forbidden"
  | "conflict"
  | "stale"
  | "offline"
  | "reconnecting";

const FORBIDDEN = 403;
const CONFLICT_STATUSES: readonly number[] = [409, 412];

function isApiFailure(error: unknown): error is ApiFailure {
  return typeof error === "object" && error !== null && "kind" in error &&
    typeof (error as { kind: unknown }).kind === "string";
}

/** HTTP status a failure carries, or `null` for transport failures. */
export function failureStatus(error: unknown): number | null {
  if (error instanceof AuthProviderError) return error.status;
  if (isApiFailure(error)) {
    if (error.kind === "problem") return error.problem.status;
    if (error.kind === "invalid-response") return error.status;
  }
  return null;
}

/** True when the transport itself failed: nothing reached the server. */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof AuthProviderError) return error.code === "NETWORK";
  return isApiFailure(error) && error.kind === "network";
}

/** The server refused the signed-in person (403). */
export function isForbiddenFailure(error: unknown): boolean {
  return failureStatus(error) === FORBIDDEN;
}

/** The server holds a newer version than the one sent (409 or 412). */
export function isConflictFailure(error: unknown): boolean {
  const status = failureStatus(error);
  return status !== null && CONFLICT_STATUSES.includes(status);
}

/** The async state a failed load or save renders. */
export function asyncKindForError(error: unknown): AsyncKind {
  if (isForbiddenFailure(error)) return "forbidden";
  if (isConflictFailure(error)) return "conflict";
  if (isNetworkFailure(error)) return "offline";
  return "error";
}

/** The async notice browser connectivity alone calls for, if any. */
export function asyncKindForConnectivity(
  connectivity: Connectivity,
): "offline" | "reconnecting" | null {
  return connectivity === "online" ? null : connectivity;
}

/**
 * A cached read is `stale` once it is older than `maxAgeMs` while the
 * connection is fine: the person is offered an explicit refresh instead of a
 * silent one.
 */
export function isStaleRead(
  dataUpdatedAt: number,
  now: number,
  maxAgeMs: number,
): boolean {
  return dataUpdatedAt > 0 && now - dataUpdatedAt > maxAgeMs;
}
