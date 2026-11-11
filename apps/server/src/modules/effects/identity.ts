import { StandardError } from "@bakery/contracts/http";
import type {
  ActiveIntegrationRegistry,
  BoundInvocation,
} from "../catalog/integration-gate.ts";

/** Provider account and resource identity read from a bound resource binding. */
export type ExternalIdentity = Readonly<{ account: string; resource: string }>;

/**
 * Reads the provider-side account and resource identifiers the host profile
 * declares for the bound resource kind. Prepare persists them; claim compares
 * the fresh binding against the persisted values.
 */
export function externalIdentityOf(
  registry: ActiveIntegrationRegistry,
  bound: BoundInvocation,
): ExternalIdentity {
  const kind = registry.get(bound.providerId)?.profile
    .resourceKinds[bound.resource.kind];
  if (!kind) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const read = (attribute: string): string => {
    const value = Object.hasOwn(bound.resource.binding, attribute)
      ? bound.resource.binding[attribute]
      : undefined;
    if (
      (typeof value !== "string" && typeof value !== "number") ||
      String(value) === ""
    ) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        detail: "resource_identity_missing",
        params: { reason: "resource_identity_missing" },
      });
    }
    return String(value);
  };
  return {
    account: read(kind.externalIdentity.account),
    resource: read(kind.externalIdentity.resource),
  };
}
