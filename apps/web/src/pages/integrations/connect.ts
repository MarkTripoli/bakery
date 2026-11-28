import type { ApiFailure } from "../../api/client.ts";

/**
 * Where starting a connection stands, for any provider: the generic views show
 * it, and a provider's own hook drives it.
 */
export type ConnectStatus =
  | "idle"
  | "starting"
  | "redirecting"
  | "unregistered"
  | "storageUnavailable"
  | "failed";

export function problemReason(error: ApiFailure): string | null {
  return error.kind === "problem" ? error.problem.reason ?? null : null;
}
