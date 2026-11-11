import type { IntegrationScope } from "@bakery/contracts/integrations";
import { INTEGRATION_SCOPE_OPERATIONS } from "@bakery/contracts/integrations";

/** Bakery operation names reachable through `bakery.call`, derived from the scope map. */
export type BakeryOperation =
  (typeof INTEGRATION_SCOPE_OPERATIONS)[IntegrationScope][number];

/** Exact request template reference; no wildcard or latest. */
export type RequestRef = { readonly id: string; readonly version: number };

/** Projection of the bound resource: only declared attributes plus its kind. */
export type ResourceProjection = Readonly<
  { kind: string } & Record<string, unknown>
>;

/**
 * Host-built, frozen, null-prototype context for `execute`. It exposes no
 * credential, secret, header, URL or installation accessor.
 */
export type ActionContext = {
  readonly signal: AbortSignal;
  readonly bakery: {
    call(operation: BakeryOperation, input: unknown): Promise<unknown>;
  };
  readonly provider: {
    request(ref: RequestRef, input: unknown): Promise<unknown>;
  };
  readonly effect: { readonly id: string };
  readonly resource: ResourceProjection;
};

/**
 * Host-built, frozen, null-prototype context for recovery. Read-only provider
 * access, no `bakery`, and the original parsed input.
 */
export type ReconciliationContext<I = unknown> = {
  readonly signal: AbortSignal;
  readonly provider: {
    request(ref: RequestRef, input: unknown): Promise<unknown>;
  };
  readonly effect: { readonly id: string };
  readonly input: Readonly<I>;
  readonly resource: ResourceProjection;
};

/** Recursively freezes plain data; returns the same value. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
