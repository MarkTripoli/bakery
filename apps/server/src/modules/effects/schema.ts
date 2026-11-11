import { z } from "zod";

/**
 * Zod schemas for the external effect ledger (`bakery.external_effects`).
 * The state machine and the integration-effect invariant live here because the
 * PostgreSQL boundary rails forbid CHECK constraints and triggers.
 */

/** Largest canonical JSON size, in bytes, of stored arguments or results. */
export const MAX_EFFECT_JSON_BYTES = 65_536;

/** Largest canonical JSON size, in bytes, of a reconciliation evidence summary. */
export const MAX_RECONCILIATION_EVIDENCE_BYTES = 4_096;

/** Target prefix that marks an effect aimed at an integration resource. */
export const INTEGRATION_TARGET_PREFIX = "integration-resource:";

/** Describes a schema and, for nullable or optional wrappers, the wrapped node too, so the description audit passes. */
function described<T extends z.ZodType>(schema: T, text: string): T {
  if (schema instanceof z.ZodNullable) {
    return z.nullable(described(schema.unwrap() as z.ZodType, text))
      .describe(text) as unknown as T;
  }
  if (schema instanceof z.ZodOptional) {
    return z.optional(described(schema.unwrap() as z.ZodType, text))
      .describe(text) as unknown as T;
  }
  return schema.describe(text) as T;
}

export const ExternalEffectStatusSchema = z.enum([
  "prepared",
  "submitted",
  "confirmed",
  "uncertain",
  "failed",
]).describe(
  "Lifecycle state of one external effect: intent recorded, dispatch claimed, outcome proven, outcome unknown, or abandoned without a send.",
);
export type ExternalEffectStatus = z.infer<typeof ExternalEffectStatusSchema>;

export const EFFECT_FAILURE_CODES = [
  "run_terminal",
  "job_canceled",
  "job_terminal",
  "budget_reservation_not_held",
  "budget_reservation_expired",
  "budget_reservation_scope_mismatch",
  "approval_stale",
  "approval_unavailable",
  "authorization_denied",
  "integration_reinstalled",
  "adapter_changed",
  "resource_identity_changed",
  "retry_exhausted",
  "provider_rejected",
  "provider_not_sent",
] as const;

export const EffectFailureCodeSchema = z.enum(EFFECT_FAILURE_CODES).describe(
  "Machine-readable reason an effect was abandoned without a provider send, or ended on an authoritative provider refusal.",
);
export type EffectFailureCode = z.infer<typeof EffectFailureCodeSchema>;

const uuid = (text: string) => z.uuid().describe(text);

/** One row of `bakery.external_effects`, exactly as the repository reads it. */
export const ExternalEffectRowSchema = z.strictObject({
  id: uuid(
    "Effect identifier minted at prepare; the same value the provider marker and reconciliation carry.",
  ),
  organizationId: uuid(
    "Organization that owns the effect; every read is scoped by it.",
  ),
  runStepId: described(
    z.uuid().nullable(),
    "Run step that caused the effect, or null for an effect outside a run.",
  ),
  automationDefinitionId: described(
    z.uuid().nullable(),
    "Automation definition that requested the effect when the actor is an automation.",
  ),
  subscriptionId: described(
    z.uuid().nullable(),
    "Event subscription that triggered the effect, when one did; no foreign key until that table exists.",
  ),
  operation: z.string().min(1).max(200).describe(
    "Action identifier the effect performs, such as an integration action id.",
  ),
  actionVersion: described(
    z.number().int().min(1).nullable(),
    "Exact action version the effect was prepared against; required for integration effects.",
  ),
  target: z.string().min(1).max(400).describe(
    "Stable target the effect writes to; integration effects use the resource prefix followed by the resource id.",
  ),
  integrationConnectionId: described(
    z.uuid().nullable(),
    "Integration connection the effect runs through; a NO ACTION foreign key keeps it across suspend, revoke and reconnect.",
  ),
  integrationResourceId: described(
    z.uuid().nullable(),
    "Selected integration resource the effect writes to; a NO ACTION foreign key ties it to the effect's own connection.",
  ),
  mcpConnectionId: described(
    z.uuid().nullable(),
    "MCP connection the effect runs through, when it is an MCP call; no foreign key until that table exists.",
  ),
  integrationInstallId: described(
    z.string().min(1).max(200).nullable(),
    "Integration install the authorization was bound to at prepare; rechecked at claim.",
  ),
  integrationGrantId: described(
    z.string().min(1).max(200).nullable(),
    "Grant that authorized the effect at prepare; informational because grants can be edited.",
  ),
  adapterManifestDigest: described(
    z.string().min(1).max(200).nullable(),
    "Digest of the adapter manifest the effect was prepared against; rechecked at claim.",
  ),
  repositoryProfileId: described(
    z.uuid().nullable(),
    "Repository profile in force for the effect, when the effect belongs to repository delivery.",
  ),
  requestingPrincipalId: uuid(
    "Principal whose authority the effect carries; used for approval consumption at claim.",
  ),
  actorRef: z.string().min(1).max(200).describe(
    "Reference of the invoking actor, either the principal id or the automation definition id.",
  ),
  idempotencyKey: z.string().min(1).max(200).describe(
    "Caller supplied key that makes a repeated prepare return the same effect.",
  ),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "SHA-256 hex over the identity fields of the request; a different digest under the same key is a mismatch.",
  ),
  safeArguments: described(
    z.unknown().nullable(),
    "Validated action arguments, bounded in size and never redacted by the ledger (action input schemas carry no credentials), replayed to the handler for reconciliation.",
  ),
  argumentArtifactVersionId: described(
    z.uuid().nullable(),
    "Artifact version holding large arguments when they do not fit inline.",
  ),
  externalAccountId: described(
    z.string().min(1).max(200).nullable(),
    "Provider account identifier taken from the resource binding at prepare; required for integration effects.",
  ),
  externalResourceId: described(
    z.string().min(1).max(200).nullable(),
    "Provider resource identifier taken from the resource binding at prepare; required for integration effects.",
  ),
  adapterVersion: z.string().min(1).max(200).describe(
    "Provider identifier and manifest version of the adapter that performs the effect.",
  ),
  credentialVersionId: described(
    z.uuid().nullable(),
    "Secret version used for the send; written once credential provenance lands.",
  ),
  authorizationRevision: described(
    z.number().int().min(0).nullable(),
    "Policy revision that authorized the effect at prepare; required for integration effects.",
  ),
  budgetReservationId: described(
    z.uuid().nullable(),
    "Held budget reservation that pays for the effect; stays held while the effect is live.",
  ),
  approvalId: described(
    z.uuid().nullable(),
    "Approval question the effect depends on, when the action needs one.",
  ),
  approvalStage: described(
    z.string().min(1).max(200).nullable(),
    "Stage the approval was granted for; set together with the approval id and policy digest.",
  ),
  approvalPolicyDigest: described(
    z.string().min(1).max(200).nullable(),
    "Policy digest the approval was granted under; set together with the approval id and stage.",
  ),
  status: ExternalEffectStatusSchema,
  remoteId: described(
    z.string().min(1).max(400).nullable(),
    "Identifier the provider assigned to the created remote object, once proven.",
  ),
  safeResult: described(
    z.unknown().nullable(),
    "Parsed handler output recorded when the effect is confirmed, bounded in size.",
  ),
  failureCode: described(
    EffectFailureCodeSchema.nullable(),
    "Reason the effect was abandoned or refused; set only when the status is failed or a retry was refused.",
  ),
  nextRetryAt: described(
    z.date().nullable(),
    "Earliest moment a retryable prepared effect may be claimed again.",
  ),
  dispatchGeneration: z.number().int().min(0).describe(
    "Count of successful claims; each claim commits a new generation before provider I/O.",
  ),
  leaseExpiresAt: described(
    z.date().nullable(),
    "Moment the current dispatch or reconciliation lease expires; null when nobody holds the effect.",
  ),
  lastCheckedAt: described(
    z.date().nullable(),
    "Moment of the latest read-only reconciliation check.",
  ),
  reconciliationAttempts: z.number().int().min(0).describe(
    "Number of read-only reconciliation checks recorded for the effect.",
  ),
  reconciliationEvidence: described(
    z.unknown().nullable(),
    "Bounded summary of the latest reconciliation check, kept as recovery evidence.",
  ),
  createdAt: z.date().describe("Moment the intent was first recorded."),
  updatedAt: z.date().describe("Moment the row last changed."),
  version: z.number().int().min(1).describe(
    "Row version counter that increases on every state change.",
  ),
}).superRefine((row, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (row.target.startsWith(INTEGRATION_TARGET_PREFIX)) {
    const required = {
      integrationConnectionId: row.integrationConnectionId,
      integrationResourceId: row.integrationResourceId,
      actionVersion: row.actionVersion,
      externalAccountId: row.externalAccountId,
      externalResourceId: row.externalResourceId,
      authorizationRevision: row.authorizationRevision,
      integrationInstallId: row.integrationInstallId,
      integrationGrantId: row.integrationGrantId,
      adapterManifestDigest: row.adapterManifestDigest,
    };
    for (const [name, value] of Object.entries(required)) {
      if (value === null) {
        issue(name, "integration effects require this column");
      }
    }
  }
  const approval = [
    row.approvalId,
    row.approvalStage,
    row.approvalPolicyDigest,
  ];
  if (approval.some((v) => v === null) && approval.some((v) => v !== null)) {
    issue("approvalId", "approval id, stage and policy digest are all or none");
  }
  if (row.approvalId !== null && row.runStepId === null) {
    issue("approvalId", "an approval requires a run step");
  }
  if (row.status === "failed" && row.failureCode === null) {
    issue("failureCode", "a failed effect records its failure code");
  }
  if (
    (row.status === "submitted" || row.status === "confirmed" ||
      row.status === "uncertain") && row.dispatchGeneration < 1
  ) {
    issue("dispatchGeneration", "a dispatched effect has claimed a generation");
  }
  if (row.status === "prepared" && row.leaseExpiresAt !== null) {
    issue("leaseExpiresAt", "a prepared effect holds no lease");
  }
  if (row.status === "confirmed" && row.leaseExpiresAt !== null) {
    issue("leaseExpiresAt", "a confirmed effect holds no lease");
  }
}).describe(
  "One external effect ledger row with the integration-effect and state invariants checked.",
);
export type ExternalEffectRow = z.infer<typeof ExternalEffectRowSchema>;

export const EffectApprovalRefSchema = z.strictObject({
  id: uuid("Approval question that authorizes the effect."),
  stage: z.string().min(1).max(200).describe(
    "Stage the approval was granted for, matched again when the effect is claimed.",
  ),
  policyDigest: z.string().min(1).max(200).describe(
    "Policy digest the approval was granted under, matched again when the effect is claimed.",
  ),
}).describe("Reference to the approval an effect depends on.");
export type EffectApprovalRef = z.infer<typeof EffectApprovalRefSchema>;

export const PrepareEffectInputSchema = z.strictObject({
  organizationId: uuid("Organization the effect belongs to."),
  envelope: z.strictObject({
    actorRef: z.string().min(1).max(200).describe(
      "Reference of the invoking actor: a principal id or an automation definition id.",
    ),
    connectionId: uuid("Integration connection the action runs through."),
  }).describe(
    "Host-owned facts about who invokes the action and through what.",
  ),
  input: z.unknown().describe(
    "Integration action input holding action id, version, resource id and arguments; validated by the gate.",
  ),
  idempotencyKey: z.string().min(1).max(200).describe(
    "Caller supplied key; the same key with the same request returns the same effect.",
  ),
  runStepId: z.uuid().describe(
    "Run step the effect belongs to; required with an approval or a budget reservation.",
  ).optional().describe(
    "Run step the effect belongs to; required with an approval or a budget reservation.",
  ),
  budgetReservationId: z.uuid().describe(
    "Held reservation of the same run step that pays for the effect.",
  ).optional().describe(
    "Held reservation of the same run step that pays for the effect.",
  ),
  approval: EffectApprovalRefSchema.optional().describe(
    "Approval the effect depends on; needs a run step.",
  ),
}).describe(
  "Everything a caller supplies to record an external effect intent.",
);
export type PrepareEffectInput = z.input<typeof PrepareEffectInputSchema>;

export const PrepareEffectResultSchema = z.strictObject({
  effectId: uuid("Identifier of the new or already existing effect."),
  status: ExternalEffectStatusSchema,
  replayed: z.boolean().describe(
    "True when the idempotency key already named an equal request, so no new row was written.",
  ),
}).describe("Result of recording an effect intent.");
export type PrepareEffectResult = z.infer<typeof PrepareEffectResultSchema>;

export const EffectOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("confirmed").describe("The provider write is proven."),
    remoteId: described(
      z.string().min(1).max(400).nullable(),
      "Provider identifier of the created object, when the handler reports one.",
    ),
    safeResult: z.unknown().describe("Parsed handler output to store."),
  }).describe("Outcome of a proven provider write."),
  z.strictObject({
    kind: z.literal("uncertain").describe(
      "The write may or may not have reached the provider.",
    ),
  }).describe("Outcome that only a read-only reconciliation can settle."),
  z.strictObject({
    kind: z.literal("retry").describe(
      "The provider refused with a transient limit; try again later.",
    ),
    retryAfterSeconds: z.number().int().min(1).max(3600).describe(
      "Delay before the effect may be claimed again.",
    ),
  }).describe("Outcome that returns the effect to prepared with a delay."),
  z.strictObject({
    kind: z.literal("failed").describe("The write definitely did not happen."),
    failureCode: EffectFailureCodeSchema,
  }).describe("Outcome of a write that is proven not to have happened."),
]).describe("How one dispatch attempt ended, as recorded by the executor.");
export type EffectOutcome = z.infer<typeof EffectOutcomeSchema>;

export const ReconciliationEvidenceSchema = z.strictObject({
  attempt: z.number().int().min(1).describe(
    "Ordinal of this reconciliation check for the effect.",
  ),
  requestCount: z.number().int().min(0).max(100).describe(
    "Provider requests the read-only handler started.",
  ),
  refs: z.array(
    z.string().max(220).describe(
      "One request reference written as action id, an at sign and its version.",
    ),
  ).max(8).describe(
    "Distinct request references, written as id and version, the handler used.",
  ),
  settledOk: z.number().int().min(0).max(100).describe(
    "Requests that settled with a provider answer.",
  ),
  rejected: z.number().int().min(0).max(100).describe(
    "Requests the provider or the host refused.",
  ),
  outcome: z.enum([
    "confirmed",
    "uncertain",
    "threw",
    "denied",
    "identity_drift",
  ])
    .describe("How the check ended."),
  errorClass: z.string().max(100).describe(
    "Short class of the error that ended the check, when one did.",
  ).optional().describe(
    "Short class of the error that ended the check, when one did.",
  ),
}).describe("Bounded record of one read-only reconciliation check.");
export type ReconciliationEvidence = z.infer<
  typeof ReconciliationEvidenceSchema
>;
