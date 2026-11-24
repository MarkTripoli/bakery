import { type Context } from "hono";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { canonicalJson } from "../../platform/canonical-json.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { assertActiveLease, lockAttempt } from "./events.ts";
import { jsonResponse, parseContract } from "./http.ts";
import {
  assertAttemptMutationSession,
  assertWorkerMutationSessionShape,
  type ExecutionRouteOptions,
  readAttemptId,
  sha256Hex,
  workerIdempotencyUuid,
  workerTransaction,
} from "./shared.ts";
import {
  decideManifestResume,
  type ResumeDecision,
} from "./handoff-eligibility.ts";
import {
  HANDOFF_MANIFEST_MAX_BYTES,
  type HandoffManifest,
  HandoffManifestSchema,
  manifestArtifactRefs,
  NON_REPLAY_SAFE_EFFECT_STATES,
} from "./handoff-manifest.ts";

/**
 * Fenced handoff manifests (chapter 17, "Handoff and interruption protocol";
 * #33 slice 1): the source session persists where it stopped, before it is
 * retired, and a continuation reads it back as a claim to re-verify.
 *
 * The manifest is a record and never the authority. Everything a source says
 * that the server can know is checked against the server's own rows, and what the
 * source merely claims about safety is replaced by the server's computation:
 *
 * - the run, step, task, agent version, workflow version, source session,
 *   conversation and repository must match the attempt's durable rows;
 * - every artifact reference must name a live version of this task with the
 *   digest the server holds;
 * - `checkpoint.safeBoundary` and `pendingEffects` are overwritten with what the
 *   event journal and the effect ledger say, so a worker or a model cannot make
 *   a state true by writing it into the manifest.
 */

type AttemptIdentity = Readonly<{
  id: string;
  job_id: string;
  fence: string | number | bigint;
  last_event_seq: string | number | bigint;
}>;

type ManifestRow = {
  id: string;
  organization_id: string;
  task_id: string;
  run_id: string;
  run_step_id: string;
  source_attempt_id: string;
  source_fence: string;
  mode: string;
  digest: string;
  safe_boundary: boolean;
  status: string;
  manifest: unknown;
  created_at: Date | string;
};

const MANIFEST_COLUMNS =
  `id, organization_id, task_id, run_id, run_step_id, source_attempt_id,
   source_fence::text as source_fence, mode, digest, safe_boundary, status,
   manifest, created_at`;

function unprocessable(field: string): never {
  throw new StandardError({ code: "UNPROCESSABLE", params: { field } });
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export type HandoffManifestRecord = ReturnType<typeof toRecord>;

type ManifestExtras = Readonly<{
  decision?: ResumeDecision | null;
  machineName?: string | null;
  continuation?:
    | Readonly<{
      mode: string;
      freshReason: string | null;
      byName: string | null;
      at: Date | string;
    }>
    | null;
}>;

function toRecord(row: ManifestRow, extras: ManifestExtras = {}) {
  const decision = extras.decision ?? null;
  const continuation = extras.continuation ?? null;
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    runStepId: row.run_step_id,
    sourceAttemptId: row.source_attempt_id,
    sourceFence: String(row.source_fence),
    mode: row.mode,
    digest: row.digest,
    safeBoundary: row.safe_boundary,
    status: row.status,
    manifest: row.manifest,
    createdAt: iso(row.created_at),
    decisionMode: decision?.mode ?? null,
    freshReason: decision?.mode === "fresh_session" ? decision.reason : null,
    machineName: extras.machineName ?? null,
    continuedMode: continuation?.mode ?? null,
    continuedFreshReason: continuation?.freshReason ?? null,
    continuedByName: continuation?.byName ?? null,
    continuedAt: continuation ? iso(continuation.at) : null,
  };
}

/**
 * Whether resuming at this checkpoint cannot repeat a non-replay-safe
 * operation. True only when the checkpoint lies within the durable event
 * journal and no external effect of the step is still prepared, submitted or
 * uncertain. Pure so the rule is tested without a database.
 */
export function computeSafeBoundary(input: {
  checkpointSequence: string;
  lastEventSeq: string | number | bigint;
  effectStates: readonly string[];
}): boolean {
  const checkpoint = BigInt(input.checkpointSequence);
  const journal = BigInt(input.lastEventSeq);
  if (checkpoint > journal) return false;
  return !input.effectStates.some((state) =>
    (NON_REPLAY_SAFE_EFFECT_STATES as readonly string[]).includes(state)
  );
}

type AttemptContext = {
  run_step_id: string;
  run_id: string;
  task_id: string;
  workflow_version_id: string;
  agent_version_id: string | null;
  repository_id: string | null;
};

async function loadAttemptContext(
  transaction: PgTransactionClient,
  organizationId: string,
  attemptId: string,
): Promise<AttemptContext> {
  const result = await transaction.query<AttemptContext>(
    `select j.run_step_id, rs.run_id, wr.task_id, wr.workflow_version_id,
            j.agent_version_id, j.repository_id
       from bakery.job_attempts a
       join bakery.jobs j
         on j.organization_id = a.organization_id and j.id = a.job_id
       join bakery.run_steps rs
         on rs.organization_id = j.organization_id and rs.id = j.run_step_id
       join bakery.workflow_runs wr
         on wr.organization_id = rs.organization_id and wr.id = rs.run_id
      where a.organization_id = $1 and a.id = $2`,
    [organizationId, attemptId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

/** The effect ledger rows of the step whose outcome is not yet settled. */
async function loadStepEffects(
  transaction: PgTransactionClient,
  organizationId: string,
  runStepId: string,
): Promise<Array<{ id: string; status: string }>> {
  const result = await transaction.query<{ id: string; status: string }>(
    `select id, status
       from bakery.external_effects
      where organization_id = $1 and run_step_id = $2
      order by created_at, id`,
    [organizationId, runStepId],
  );
  return result.rows;
}

async function verifyArtifactRefs(
  transaction: PgTransactionClient,
  organizationId: string,
  taskId: string,
  manifest: HandoffManifest,
): Promise<void> {
  const refs = manifestArtifactRefs(manifest);
  const evidence = manifest.tests.flatMap((test) =>
    test.evidenceVersionId === null ? [] : [test.evidenceVersionId]
  );
  const ids = [...new Set([...refs.map((ref) => ref.versionId), ...evidence])];
  if (ids.length === 0) return;
  const result = await transaction.query<
    { id: string; artifact_id: string; sha256: string }
  >(
    `select v.id, v.artifact_id, v.sha256
       from bakery.artifact_versions v
      where v.organization_id = $1
        and v.task_id = $2
        and v.purged_at is null
        -- A staged or refused version (O29) cannot be handed off.
        and v.publication_status = 'current'
        and v.id = any($3::uuid[])`,
    [organizationId, taskId, ids],
  );
  const known = new Map(result.rows.map((row) => [row.id, row]));
  for (const ref of refs) {
    const row = known.get(ref.versionId);
    if (
      !row || row.artifact_id !== ref.artifactId || row.sha256 !== ref.sha256
    ) unprocessable("artifactRefs");
  }
  for (const id of evidence) {
    if (!known.has(id)) unprocessable("tests.evidenceVersionId");
  }
}

async function verifySourceSession(
  transaction: PgTransactionClient,
  organizationId: string,
  runStepId: string,
  manifest: HandoffManifest,
  expectedAgentVersionId: string | null,
): Promise<void> {
  const result = await transaction.query<
    { conversation_id: string; agent_version_id: string; harness: string }
  >(
    `select conversation_id, agent_version_id, harness
       from bakery.agent_sessions
      where organization_id = $1 and id = $2 and run_step_id = $3`,
    [organizationId, manifest.sourceSessionId, runStepId],
  );
  const session = result.rows[0];
  if (!session) unprocessable("sourceSessionId");
  if (session.conversation_id !== manifest.context.conversationId) {
    unprocessable("context.conversationId");
  }
  if (session.agent_version_id !== manifest.agentVersionId) {
    unprocessable("agentVersionId");
  }
  if (
    expectedAgentVersionId !== null &&
    expectedAgentVersionId !== manifest.agentVersionId
  ) unprocessable("agentVersionId");
  if (session.harness !== manifest.harness) unprocessable("harness");
}

/**
 * Stores the manifest of one source attempt. The same manifest replays; a
 * different one for the same attempt is a conflict. Caller has already proved
 * the lease, the fence and the worker session.
 */
export async function createHandoffManifest(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    attempt: AttemptIdentity;
    rawManifest: unknown;
  },
): Promise<{ kind: "created" | "replayed"; record: HandoffManifestRecord }> {
  const { organizationId, attempt } = input;
  if (
    new TextEncoder().encode(JSON.stringify(input.rawManifest ?? null))
      .byteLength > HANDOFF_MANIFEST_MAX_BYTES
  ) throw new StandardError({ code: "BODY_TOO_LARGE" });
  const parsed = HandoffManifestSchema.safeParse(input.rawManifest);
  if (!parsed.success) {
    unprocessable(parsed.error.issues[0]?.path.join(".") || "manifest");
  }
  const manifest = parsed.data;

  const context = await loadAttemptContext(
    transaction,
    organizationId,
    attempt.id,
  );
  if (
    manifest.runStepId !== context.run_step_id ||
    manifest.runId !== context.run_id ||
    manifest.taskId !== context.task_id
  ) unprocessable("runStepId");
  if (manifest.workflowVersionId !== context.workflow_version_id) {
    unprocessable("workflowVersionId");
  }
  if (
    context.repository_id !== null &&
    manifest.repository.repositoryId !== context.repository_id
  ) unprocessable("repository.repositoryId");

  await verifySourceSession(
    transaction,
    organizationId,
    context.run_step_id,
    manifest,
    context.agent_version_id,
  );
  await verifyArtifactRefs(
    transaction,
    organizationId,
    context.task_id,
    manifest,
  );

  const effects = await loadStepEffects(
    transaction,
    organizationId,
    context.run_step_id,
  );
  const safeBoundary = computeSafeBoundary({
    checkpointSequence: manifest.checkpoint.sequence,
    lastEventSeq: attempt.last_event_seq,
    effectStates: effects.map((effect) => effect.status),
  });
  // The server's view replaces the source's claims.
  const stored: HandoffManifest = {
    ...manifest,
    pendingEffects: effects
      .filter((effect) =>
        (NON_REPLAY_SAFE_EFFECT_STATES as readonly string[]).includes(
          effect.status,
        )
      )
      .map((effect) => ({
        effectId: effect.id,
        state: effect.status as "prepared" | "submitted" | "uncertain",
      }))
      .slice(0, 64),
    checkpoint: { ...manifest.checkpoint, safeBoundary },
  };
  const encoded = canonicalJson(stored);
  if (
    new TextEncoder().encode(encoded).byteLength > HANDOFF_MANIFEST_MAX_BYTES
  ) throw new StandardError({ code: "BODY_TOO_LARGE" });
  const digest = await sha256Hex(encoded);
  // What the source sent, before the server's view replaced parts of it: the
  // key a retry is compared on.
  const requestDigest = await sha256Hex(canonicalJson(manifest));

  const inserted = await transaction.query<ManifestRow>(
    `insert into bakery.handoff_manifests
       (organization_id, task_id, run_id, run_step_id, source_attempt_id,
        source_fence, mode, digest, request_digest, safe_boundary, manifest)
     values ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10, $11::jsonb)
     on conflict (source_attempt_id) do nothing
     returning ${MANIFEST_COLUMNS}`,
    [
      organizationId,
      context.task_id,
      context.run_id,
      context.run_step_id,
      attempt.id,
      String(attempt.fence),
      stored.mode,
      digest,
      requestDigest,
      safeBoundary,
      JSON.stringify(stored),
    ],
  );
  if (inserted.rows[0]) {
    return { kind: "created", record: toRecord(inserted.rows[0]) };
  }
  const existing = await transaction.query<
    ManifestRow & { request_digest: string }
  >(
    `select ${MANIFEST_COLUMNS}, request_digest
       from bakery.handoff_manifests
      where organization_id = $1 and source_attempt_id = $2`,
    [organizationId, attempt.id],
  );
  const row = existing.rows[0];
  if (!row) throw new StandardError({ code: "STATE_CONFLICT" });
  if (row.request_digest !== requestDigest) {
    throw new StandardError({ code: "STATE_CONFLICT" });
  }
  return { kind: "replayed", record: toRecord(row) };
}

export async function getHandoffManifest(
  context: ActionContext,
): Promise<HandoffManifestRecord> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const result = await transaction.query<ManifestRow>(
    `select ${MANIFEST_COLUMNS}
       from bakery.handoff_manifests
      where organization_id = $1 and id = $2`,
    [organizationId, id],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const source = (await transaction.query<
    { worker_host_id: string | null; name: string | null }
  >(
    `select a.worker_host_id, h.name
       from bakery.job_attempts as a
       left join bakery.worker_hosts as h
         on h.organization_id = a.organization_id and h.id = a.worker_host_id
      where a.organization_id = $1 and a.id = $2`,
    [organizationId, row.source_attempt_id],
  )).rows[0];
  const machineName = source?.name ?? null;
  if (row.status === "continued") {
    const continued = (await transaction.query<
      {
        mode: string;
        fresh_reason: string | null;
        display_name: string | null;
        created_at: Date | string;
      }
    >(
      `select c.mode, c.fresh_reason, p.display_name, c.created_at
         from bakery.handoff_continuations as c
         left join bakery.principals as p on p.id = c.admitted_by_principal_id
        where c.organization_id = $1 and c.manifest_id = $2`,
      [organizationId, row.id],
    )).rows[0];
    return toRecord(row, {
      machineName,
      continuation: continued
        ? {
          mode: continued.mode,
          freshReason: continued.fresh_reason,
          byName: continued.display_name,
          at: continued.created_at,
        }
        : null,
    });
  }
  if (row.status !== "pending") return toRecord(row, { machineName });
  const stored = HandoffManifestSchema.safeParse(row.manifest);
  if (!stored.success) return toRecord(row, { machineName });
  const { decision } = await decideManifestResume(transaction, {
    organizationId,
    runId: row.run_id,
    runStepId: row.run_step_id,
    manifestId: row.id,
    manifestDigest: row.digest,
    manifest: stored.data,
    sourceHostId: source?.worker_host_id ?? "",
  });
  return toRecord(row, { decision, machineName });
}

/**
 * `POST /v1/worker/attempts/{id}/handoff-manifests`: the worker of a live
 * attempt persists its manifest. The lease, the fence and the worker session
 * are proved first, as for every attempt mutation, so a fenced, expired or
 * foreign attempt can never write one.
 */
export async function workerHandoffManifestRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const input = await parseContract(
    context,
    contractSchemas.WorkerHandoffManifest,
  );
  // Required like every worker mutation; the write is naturally idempotent
  // (the same attempt and manifest replays).
  workerIdempotencyUuid(context.req.header("Idempotency-Key"));
  const tokenHash = await sha256Hex(input.leaseToken);
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      assertWorkerMutationSessionShape(
        identity.host,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      const attempt = await lockAttempt(transaction, identity, attemptId);
      assertAttemptMutationSession(
        identity.host,
        attempt,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      assertActiveLease(attempt, identity, tokenHash, input.fence);
      return await createHandoffManifest(transaction, {
        organizationId: identity.host.organization_id,
        attempt,
        rawManifest: input.manifest,
      });
    },
  );
  return jsonResponse(
    contractSchemas.HandoffManifestRecord.parse(result.record),
    result.kind === "created" ? 201 : 200,
    result.kind === "replayed",
  );
}
