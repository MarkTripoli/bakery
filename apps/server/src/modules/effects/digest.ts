import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { EffectApprovalRef } from "./schema.ts";

/**
 * Identity fields of one effect request. These, and only these, decide whether
 * a repeated prepare under the same idempotency key is the same request.
 *
 * Deliberately absent: the effect id, timestamps, `authorizationRevision`,
 * `manifestDigest`, `installId` and `grantId`. The last four are authority
 * version counters. An unrelated grant edit must not turn a legitimate replay
 * into a mismatch; claim rechecks them against fresh authority instead.
 */
export type EffectIdentity = Readonly<{
  operation: string;
  actionVersion: number;
  target: string;
  connectionId: string;
  resourceId: string;
  externalAccountId: string | null;
  externalResourceId: string | null;
  arguments: unknown;
  actorRef: string;
  runStepId: string | null;
  automationDefinitionId: string | null;
  budgetReservationId: string | null;
  approval: EffectApprovalRef | null;
}>;

/** SHA-256 hex over the canonical JSON of the identity fields. */
export function computeRequestDigest(
  identity: EffectIdentity,
): Promise<string> {
  return sha256Hex(canonicalJson({
    operation: identity.operation,
    actionVersion: identity.actionVersion,
    target: identity.target,
    connectionId: identity.connectionId,
    resourceId: identity.resourceId,
    externalAccountId: identity.externalAccountId,
    externalResourceId: identity.externalResourceId,
    arguments: identity.arguments,
    actorRef: identity.actorRef,
    runStepId: identity.runStepId,
    automationDefinitionId: identity.automationDefinitionId,
    budgetReservationId: identity.budgetReservationId,
    approval: identity.approval === null ? null : {
      id: identity.approval.id,
      stage: identity.approval.stage,
      policyDigest: identity.approval.policyDigest,
    },
  }));
}
