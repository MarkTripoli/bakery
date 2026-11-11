import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import {
  createEffectExecutor,
  type EffectExecutorDeps,
  type RunEffectResult,
} from "../effects/executor.ts";
import { type PrepareEffectResult } from "../effects/schema.ts";
import {
  type ActiveAction,
  type ActiveIntegrationRegistry,
  type AuthoritySnapshotPort,
  authorizeInvocation,
  type BakeryOperationPort,
  createActionContext,
} from "./integration-gate.ts";

/**
 * Consumer door for the registered integration send path. The
 * shared gate classifies sends by the active action's transport effect: a
 * `read`-classified action sends directly through the gate, while a
 * write-classified action routes through the external effect ledger
 * (`prepareEffect`, then `runEffect`) under one canonically derived effect key
 * per #436's ledger scheme, so a retried send can only replay or reconcile
 * under the same effect id instead of issuing a second non-idempotent
 * provider mutation.
 */

const unprocessable = (detail: string) =>
  new StandardError({
    code: "UNPROCESSABLE",
    detail,
    params: { reason: detail },
  });

/** Prefix marking a host-derived (not caller-trusted) integration effect key. */
export const DERIVED_EFFECT_KEY_PREFIX = "integration-send";

/** One send an HTTP route, workflow step or automation may issue and retry. */
export const IntegrationInvokeInputSchema = z.strictObject({
  organizationId: z.uuid().describe("Organization the invocation runs under."),
  actorRef: z.string().min(1).max(200).describe(
    "Reference of the invoking actor: a principal id or an automation definition id.",
  ),
  connectionId: z.uuid().describe(
    "Integration connection the action runs through.",
  ),
  input: z.unknown().describe(
    "Integration invocation input naming the action, its pinned version, the selected resource and the arguments; validated against the gate's shared contract.",
  ),
  requestId: z.string().min(1).max(200).optional().describe(
    "Audit identifier for the claim; minted when omitted.",
  ),
  traceId: z.string().min(1).max(200).optional().describe(
    "Trace identifier for the claim audit trail; minted when omitted.",
  ),
  idempotencyKey: z.string().min(1).max(200).optional().describe(
    "Explicit effect key naming the same send on retry; a canonical key is derived from the invocation facts when omitted.",
  ),
  runStepId: z.uuid().optional().describe(
    "Run step the write belongs to, when the invocation happens inside one; passed to the ledger.",
  ),
  budgetReservationId: z.uuid().optional().describe(
    "Held reservation of the same run step paying for the write; passed to the ledger.",
  ),
  approval: z.strictObject({
    id: z.uuid().describe("Approval question that authorizes the write."),
    stage: z.string().min(1).max(200).describe(
      "Stage the approval was granted for, matched again when the effect is claimed.",
    ),
    policyDigest: z.string().min(1).max(200).describe(
      "Policy digest the approval was granted under, matched again when the effect is claimed.",
    ),
  }).optional().describe(
    "Approval the write depends on, when the action needs one; passed to the ledger.",
  ),
}).describe(
  "One registered integration send whose write-classified path routes through the external effect ledger.",
);
export type IntegrationInvokeInput = z.input<
  typeof IntegrationInvokeInputSchema
>;

/** How one invocation ran, and what it produced. */
export type IntegrationInvokeResult =
  | Readonly<{
    route: "direct";
    /** The read-classified action that was authorized and invoked. */
    action: ActiveAction;
    /** Output of the handler's read, as declared by its output schema. */
    output: unknown;
  }>
  | Readonly<{
    route: "ledger";
    /** The write-classified action behind the recorded effect. */
    action: ActiveAction;
    /** Ledger result: a new effect, or a replay of an earlier equal send. */
    prepare: PrepareEffectResult;
    /** Claim, dispatch and reconcile result for that effect. */
    run: RunEffectResult;
    /** Bounded handler receipt; non-null only for a confirmed effect. */
    output: unknown;
  }>;

/**
 * Facts that make a retried invocation the same send: actor, connection,
 * action reference, selected resource, arguments and, when present, the run
 * scope, budget reservation and approval. Authority version counters are
 * deliberately absent; the ledger rechecks them at claim against fresh
 * authority instead of doubling as identity.
 */
export type DerivedKeyFacts = Readonly<{
  actorRef: string;
  connectionId: string;
  actionRef: Readonly<{ id: string; version: number }>;
  resourceId: string;
  arguments: unknown;
  runStepId: string | null;
  budgetReservationId: string | null;
  approval:
    | Readonly<{ id: string; stage: string; policyDigest: string }>
    | null;
}>;

/**
 * Canonical effect key per #436's ledger scheme (`organizationId`,
 * `operation`, `integrations:`-prefix target, idempotency key): SHA-256 hex
 * over the canonical JSON of the invocation facts. Deriving the key inside the
 * host keeps a retried send on its original effect without trusting a
 * caller-supplied key for authority.
 */
export async function deriveEffectIdempotencyKey(
  facts: DerivedKeyFacts,
): Promise<string> {
  const digest = await sha256Hex(canonicalJson({
    actorRef: facts.actorRef,
    connectionId: facts.connectionId,
    actionRef: `${facts.actionRef.id}@${facts.actionRef.version}`,
    resourceId: facts.resourceId,
    arguments: facts.arguments,
    runStepId: facts.runStepId,
    budgetReservationId: facts.budgetReservationId,
    approval: facts.approval === null ? null : { ...facts.approval },
  }));
  return `${DERIVED_EFFECT_KEY_PREFIX}:${digest}`;
}

/**
 * Resolves one declared action reference across the active registry without a
 * known provider. Returns null when no active integration declares the exact
 * reference, letting the gate raise its own unknown-action error.
 */
export function findActiveAction(
  registry: ActiveIntegrationRegistry,
  ref: Readonly<{ id: string; version: number }>,
): ActiveAction | null {
  for (const integration of registry.integrations) {
    for (const action of integration.actions) {
      if (action.id === ref.id && action.version === ref.version) {
        return action;
      }
    }
  }
  return null;
}

/** Collaborators of the door: the ledger executor stack plus the gate's direct-context ports. */
export type IntegrationInvokeDeps =
  & EffectExecutorDeps
  & Readonly<{
    registry: ActiveIntegrationRegistry;
    snapshots: AuthoritySnapshotPort;
    bakeryOperations?: BakeryOperationPort;
    signal?: AbortSignal;
    now?: () => Date;
  }>;

type ParsedInvocation = Readonly<{
  ref: Readonly<{ id: string; version: number }>;
  resourceId: string;
  arguments: unknown;
  body: Readonly<Record<string, unknown>>;
}>;

function parseInvocationBody(value: unknown): ParsedInvocation | null {
  const parsed = contractSchemas.IntegrationActionInput.safeParse(value);
  if (!parsed.success) return null;
  return {
    ref: {
      id: parsed.data.actionId,
      version: parsed.data.actionVersion,
    },
    resourceId: parsed.data.resourceId,
    arguments: parsed.data.arguments,
    body: value as Readonly<Record<string, unknown>>,
  };
}

/**
 * Sends one registered integration invocation: authorized by the shared gate,
 * then classified by the resolved action's transport effect. Read-classified
 * actions invoke the handler directly. Write-classified actions first record
 * their intent in the effect ledger, then claim, dispatch and reconcile
 * through the executor; an equal resend under the same key replays that
 * effect instead of preparing a duplicate mutation.
 */
export async function invokeIntegration(
  deps: IntegrationInvokeDeps,
  rawArgs: IntegrationInvokeInput,
): Promise<IntegrationInvokeResult> {
  const parsed = IntegrationInvokeInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw unprocessable("invalid integration invocation input");
  }
  const args = parsed.data;
  const input = parseInvocationBody(args.input);
  if (input === null) throw unprocessable("invalid invocation input");
  const action = findActiveAction(deps.registry, input.ref);
  if (action === null) throw unprocessable("unknown integration action");

  if (action.effect === "read") {
    const bound = await authorizeInvocation(deps.registry, deps.snapshots, {
      organizationId: args.organizationId,
      actorRef: args.actorRef,
      connectionId: args.connectionId,
      effectId: crypto.randomUUID(),
    }, args.input);
    const ctx = createActionContext(bound, {
      registry: deps.registry,
      snapshots: deps.snapshots,
      ...(deps.providerRequests
        ? { providerRequests: deps.providerRequests }
        : {}),
      ...(deps.bakeryOperations
        ? { bakeryOperations: deps.bakeryOperations }
        : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    const output = await action.handler.invoke(ctx, input.arguments);
    return { route: "direct", action, output };
  }

  const executor = createEffectExecutor(deps);
  const idempotencyKey = args.idempotencyKey ??
    await deriveEffectIdempotencyKey({
      actorRef: args.actorRef,
      connectionId: args.connectionId,
      actionRef: input.ref,
      resourceId: input.resourceId,
      arguments: input.arguments,
      runStepId: args.runStepId ?? null,
      budgetReservationId: args.budgetReservationId ?? null,
      approval: args.approval ?? null,
    });
  const prepare = await executor.prepareEffect({
    organizationId: args.organizationId,
    envelope: { actorRef: args.actorRef, connectionId: args.connectionId },
    input: args.input,
    idempotencyKey,
    ...(args.runStepId ? { runStepId: args.runStepId } : {}),
    ...(args.budgetReservationId
      ? { budgetReservationId: args.budgetReservationId }
      : {}),
    ...(args.approval ? { approval: args.approval } : {}),
  });
  const run = await executor.runEffect({
    organizationId: args.organizationId,
    effectId: prepare.effectId,
    requestId: args.requestId ?? crypto.randomUUID(),
    traceId: args.traceId ?? crypto.randomUUID(),
  });
  const output = run.outcome === "confirmed" ? run.effect.safeResult : null;
  return { route: "ledger", action, prepare, run, output };
}
