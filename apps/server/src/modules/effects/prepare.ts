import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { type PgDatabase, withPgTransaction } from "../../platform/database.ts";
import {
  type ActiveIntegrationRegistry,
  type AuthoritySnapshotPort,
  authorizeInvocation,
} from "../catalog/integration-gate.ts";
import { computeRequestDigest, type EffectIdentity } from "./digest.ts";
import { externalIdentityOf } from "./identity.ts";
import {
  approvalScope,
  findEffectByKey,
  insertPreparedEffect,
  lockReservationForPrepare,
  runStepExists,
} from "./repository.ts";
import {
  type EffectApprovalRef,
  INTEGRATION_TARGET_PREFIX,
  MAX_EFFECT_JSON_BYTES,
  type PrepareEffectInput,
  PrepareEffectInputSchema,
  type PrepareEffectResult,
} from "./schema.ts";
import type { ExternalEffectRow } from "./schema.ts";

/** Collaborators prepare needs: the ledger database, the active registry and fresh authority. */
export type PrepareDeps = Readonly<{
  database: PgDatabase;
  registry: ActiveIntegrationRegistry;
  snapshots: AuthoritySnapshotPort;
}>;

const unprocessable = (detail: string) =>
  new StandardError({
    code: "UNPROCESSABLE",
    detail,
    params: { reason: detail },
  });
const stateConflict = (reason: string) =>
  new StandardError({
    code: "STATE_CONFLICT",
    detail: reason,
    params: { reason },
  });
const notFound = () => new StandardError({ code: "RESOURCE_NOT_FOUND" });
const mismatch = () =>
  new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });

const uuidSchema = z.uuid();
const encoder = new TextEncoder();

function approvalOrNull(
  approval: EffectApprovalRef | undefined,
): EffectApprovalRef | null {
  return approval ?? null;
}

type RequestFacts = Readonly<{
  organizationId: string;
  actorRef: string;
  connectionId: string;
  idempotencyKey: string;
  operation: string;
  actionVersion: number;
  resourceId: string;
  target: string;
  arguments: unknown;
  runStepId: string | null;
  budgetReservationId: string | null;
  approval: EffectApprovalRef | null;
}>;

function identityOf(
  facts: RequestFacts,
  derived: Pick<
    EffectIdentity,
    "externalAccountId" | "externalResourceId" | "automationDefinitionId"
  >,
): EffectIdentity {
  return {
    operation: facts.operation,
    actionVersion: facts.actionVersion,
    target: facts.target,
    connectionId: facts.connectionId,
    resourceId: facts.resourceId,
    arguments: facts.arguments,
    actorRef: facts.actorRef,
    runStepId: facts.runStepId,
    budgetReservationId: facts.budgetReservationId,
    approval: facts.approval,
    ...derived,
  };
}

async function replayOf(
  existing: ExternalEffectRow,
  facts: RequestFacts,
  digest?: string,
): Promise<PrepareEffectResult> {
  const expected = digest ?? await computeRequestDigest(
    identityOf(facts, {
      externalAccountId: existing.externalAccountId,
      externalResourceId: existing.externalResourceId,
      automationDefinitionId: existing.automationDefinitionId,
    }),
  );
  if (expected !== existing.requestDigest) throw mismatch();
  return { effectId: existing.id, status: existing.status, replayed: true };
}

/**
 * Records the intent of one external effect, or returns the effect an equal
 * earlier request already recorded. Writes nothing on any rejection.
 *
 * A replay is answered from the ledger without re-authorizing: the digest
 * covers identity fields only, so an unrelated grant edit between two
 * prepares is still the same request. Authority is checked again at claim.
 * Prepared effects on an expired reservation never become `submitted`; a
 * later claim fails them with `budget_reservation_expired`, or, once recovery
 * released the reservation, with an earlier admission code (`job_terminal`,
 * else `budget_reservation_not_held`). Sweeping them is the consumer's duty.
 */
export async function prepareEffect(
  deps: PrepareDeps,
  rawArgs: PrepareEffectInput,
): Promise<PrepareEffectResult> {
  const args = PrepareEffectInputSchema.safeParse(rawArgs);
  if (!args.success) throw unprocessable("invalid effect prepare input");
  const { organizationId, envelope, idempotencyKey } = args.data;
  const parsedInput = contractSchemas.IntegrationActionInput.safeParse(
    args.data.input,
  );
  if (!parsedInput.success) throw unprocessable("invalid invocation input");
  const { actionId, actionVersion, resourceId } = parsedInput.data;
  const runStepId = args.data.runStepId ?? null;
  const budgetReservationId = args.data.budgetReservationId ?? null;
  const approval = approvalOrNull(args.data.approval);
  if (approval !== null && runStepId === null) {
    throw unprocessable("approval_requires_run_step");
  }
  if (budgetReservationId !== null && runStepId === null) {
    throw unprocessable("budget_reservation_requires_run_step");
  }
  const facts: RequestFacts = {
    organizationId,
    actorRef: envelope.actorRef,
    connectionId: envelope.connectionId,
    idempotencyKey,
    operation: actionId,
    actionVersion,
    resourceId,
    target: `${INTEGRATION_TARGET_PREFIX}${resourceId}`,
    arguments: parsedInput.data.arguments,
    runStepId,
    budgetReservationId,
    approval,
  };

  const key = {
    organizationId,
    operation: facts.operation,
    target: facts.target,
    idempotencyKey,
  };
  const existing = await withPgTransaction(
    deps.database,
    (tx) => findEffectByKey(tx, key),
  );
  if (existing) return await replayOf(existing, facts);

  const effectId = crypto.randomUUID();
  const bound = await authorizeInvocation(
    deps.registry,
    deps.snapshots,
    {
      organizationId,
      actorRef: envelope.actorRef,
      connectionId: envelope.connectionId,
      effectId,
    },
    parsedInput.data,
  );
  const provider = deps.registry.get(bound.providerId);
  const action = deps.registry.findAction(
    bound.providerId,
    bound.actionRef.id,
    bound.actionRef.version,
  );
  if (!provider || !action) throw notFound();
  if (action.handler.effect === "read") {
    throw unprocessable("effect_action_is_read_only");
  }
  if (!action.handler.reconcile) {
    throw unprocessable("effect_action_not_reconcilable");
  }
  const argumentBytes = encoder.encode(canonicalJson(facts.arguments)).length;
  if (argumentBytes > MAX_EFFECT_JSON_BYTES) {
    throw unprocessable("effect_arguments_too_large");
  }
  if (
    !uuidSchema.safeParse(bound.connectionId).success ||
    !uuidSchema.safeParse(bound.resource.id).success
  ) throw unprocessable("integration_ids_must_be_uuids");
  const external = externalIdentityOf(deps.registry, bound);
  const automationDefinitionId = bound.actor.automationDefinitionId ?? null;
  if (
    automationDefinitionId !== null &&
    !uuidSchema.safeParse(automationDefinitionId).success
  ) throw unprocessable("integration_ids_must_be_uuids");
  const digest = await computeRequestDigest(identityOf(facts, {
    externalAccountId: external.account,
    externalResourceId: external.resource,
    automationDefinitionId,
  }));

  return await withPgTransaction(deps.database, async (tx) => {
    if (
      runStepId !== null && !await runStepExists(tx, organizationId, runStepId)
    ) {
      throw notFound();
    }
    if (approval !== null) {
      // runStepId is non-null here: an approval without a step is refused above.
      const scope = await approvalScope(
        tx,
        organizationId,
        approval.id,
        runStepId!,
      );
      if (scope === "missing") throw notFound();
      if (scope === "mismatch") throw unprocessable("approval_scope_mismatch");
    }
    if (budgetReservationId !== null) {
      const reservation = await lockReservationForPrepare(
        tx,
        organizationId,
        budgetReservationId,
      );
      if (!reservation) throw notFound();
      if (
        reservation.runStepId === null || reservation.runStepId !== runStepId ||
        (reservation.externalEffectId !== null &&
          reservation.externalEffectId !== effectId)
      ) throw unprocessable("budget_reservation_scope_mismatch");
      if (reservation.status !== "held") {
        throw stateConflict("budget_reservation_not_held");
      }
      if (reservation.expired) {
        throw stateConflict("budget_reservation_expired");
      }
    }
    const inserted = await insertPreparedEffect(tx, {
      id: effectId,
      organizationId,
      runStepId,
      automationDefinitionId,
      operation: facts.operation,
      actionVersion: bound.actionRef.version,
      target: facts.target,
      integrationConnectionId: bound.connectionId,
      integrationResourceId: bound.resource.id,
      integrationInstallId: bound.installId,
      integrationGrantId: bound.grantId,
      adapterManifestDigest: bound.manifestDigest,
      requestingPrincipalId: bound.actor.principalId,
      actorRef: bound.actorRef,
      idempotencyKey,
      requestDigest: digest,
      safeArguments: facts.arguments,
      externalAccountId: external.account,
      externalResourceId: external.resource,
      adapterVersion: `${provider.providerId}@${provider.version}`,
      authorizationRevision: bound.policyRevision,
      budgetReservationId,
      approvalId: approval?.id ?? null,
      approvalStage: approval?.stage ?? null,
      approvalPolicyDigest: approval?.policyDigest ?? null,
    });
    if (inserted) {
      return {
        effectId: inserted.id,
        status: inserted.status,
        replayed: false,
      };
    }
    const winner = await findEffectByKey(tx, key);
    if (!winner) throw stateConflict("effect_key_vanished");
    return await replayOf(winner, facts, digest);
  });
}
