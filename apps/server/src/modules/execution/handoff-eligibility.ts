import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type HandoffManifest,
  manifestArtifactRefs,
  NON_REPLAY_SAFE_EFFECT_STATES,
} from "./handoff-manifest.ts";

/**
 * Exact-resume eligibility for a handoff (chapter 17, "Handoff and interruption
 * protocol"; #33 slice 3): whether the continuation may resume the source's
 * native harness session, or must start a fresh bounded one.
 *
 * Resuming reuses the model's native history, so it needs proof the server holds
 * itself; the manifest's own claims are not proof. Every condition must hold, and
 * any one that does not selects a fresh session, never a block and never a
 * resume:
 *
 * - the manifest asked for an exact resume and its safe boundary, as the
 *   server computed it, is true;
 * - every external effect of the step is settled (confirmed or failed);
 * - the source session is still the one the manifest names and is active;
 * - the session row's `resume_ref` (written by the adapter that owns the native
 *   session) names five things: the native session id, which only has to be
 *   present; the checkpoint, which must equal the manifest's checkpoint digest;
 *   the worktree revision, which must equal the manifest's commit; the harness
 *   version, which must equal the manifest's; and the host, which must equal the
 *   worker host the source attempt ran on;
 * - the history the native session saw is still authorized: the person the run
 *   acts for is still an active member, every artifact the manifest cites is
 *   live with the digest the server holds.
 *
 * A harness also checks its own exact match (session, revision, checkpoint and
 * version) before any model turn; this decision is the server's half. The
 * history is checked once, when the continuation is admitted; the claim does not
 * repeat it.
 */

export type FreshReason =
  | "exact_resume_not_requested"
  | "boundary_unsafe"
  | "effects_unresolved"
  | "session_changed"
  | "no_native_evidence"
  | "native_evidence_mismatch"
  | "history_revoked";

/** The record written to the job's checkpoints for a harness to match. */
export type HandoffCheckpoint = Readonly<{
  schemaVersion: 1;
  source: "handoff";
  manifestId: string;
  manifestDigest: string;
  agentSessionId: string;
  nativeSessionId: string;
  checkpointId: string;
  worktreeRevision: string;
  harnessVersion: string;
  workerHostId: string;
  eligible: true;
}>;

export type ResumeDecision =
  | Readonly<{ mode: "exact_harness_resume"; checkpoint: HandoffCheckpoint }>
  | Readonly<{ mode: "fresh_session"; reason: FreshReason }>;

export type SourceSession = Readonly<{
  id: string;
  status: string;
  resumeRef: unknown;
}>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The decision, pure so every branch is tested without a database. `manifest`
 * is the manifest as the server stored it, with its own safe boundary. The
 * session and the history answer are only read when the manifest asks for an
 * exact resume, so a caller whose manifest does not may pass `null` and `false`.
 */
export function decideResume(input: {
  manifestId: string;
  manifestDigest: string;
  manifest: HandoffManifest;
  session: SourceSession | null;
  sourceHostId: string;
  historyAuthorized: boolean;
  /** No external effect of the step is still prepared, submitted or uncertain. */
  effectsSettled: boolean;
}): ResumeDecision {
  const { manifest, session } = input;
  const fresh = (reason: FreshReason): ResumeDecision => ({
    mode: "fresh_session",
    reason,
  });
  if (manifest.mode !== "exact_harness_resume") {
    return fresh("exact_resume_not_requested");
  }
  if (manifest.checkpoint.safeBoundary !== true) {
    return fresh("boundary_unsafe");
  }
  // An uncertain effect means the native history describes work whose outcome
  // nobody knows; it is never reused, and the continuation parks until the
  // effect is reconciled.
  if (!input.effectsSettled) return fresh("effects_unresolved");
  if (
    session === null || session.id !== manifest.sourceSessionId ||
    session.status !== "active"
  ) return fresh("session_changed");
  const ref = session.resumeRef;
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    return fresh("no_native_evidence");
  }
  const record = ref as Record<string, unknown>;
  const nativeSessionId = text(record.nativeSessionId);
  const checkpointId = text(record.checkpointId);
  const worktreeRevision = text(record.worktreeRevision);
  const harnessVersion = text(record.harnessVersion);
  const workerHostId = text(record.workerHostId);
  if (
    nativeSessionId === null || checkpointId === null ||
    worktreeRevision === null || harnessVersion === null ||
    workerHostId === null
  ) return fresh("no_native_evidence");
  if (
    checkpointId !== manifest.checkpoint.digest ||
    worktreeRevision !== manifest.repository.commitSha ||
    harnessVersion !== manifest.harnessVersion ||
    workerHostId !== input.sourceHostId
  ) return fresh("native_evidence_mismatch");
  if (!input.historyAuthorized) return fresh("history_revoked");
  return {
    mode: "exact_harness_resume",
    checkpoint: {
      schemaVersion: 1,
      source: "handoff",
      manifestId: input.manifestId,
      manifestDigest: input.manifestDigest,
      agentSessionId: manifest.sourceSessionId,
      nativeSessionId,
      checkpointId,
      worktreeRevision,
      harnessVersion,
      workerHostId,
      eligible: true,
    },
  };
}

/**
 * Whether the history a native session saw is still authorized now: the person
 * the run acts for is an active member, every cited artifact version is live with
 * the digest the server holds. The conversation needs no check: the source
 * session is loaded first, and its row keeps the conversation from being deleted.
 * A read only.
 */
export async function historyIsAuthorized(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    taskId: string;
    runId: string;
    manifest: HandoffManifest;
  },
): Promise<boolean> {
  const requester = await transaction.query<{ principal_id: string }>(
    `select m.principal_id
       from bakery.workflow_runs wr
       join bakery.organization_memberships m
         on m.organization_id = wr.organization_id
        and m.principal_id = wr.requested_by
        and m.status = 'active'
      where wr.organization_id = $1 and wr.id = $2`,
    [input.organizationId, input.runId],
  );
  if (requester.rows.length === 0) return false;
  const refs = manifestArtifactRefs(input.manifest);
  if (refs.length === 0) return true;
  const ids = [...new Set(refs.map((ref) => ref.versionId))];
  const versions = await transaction.query<
    { id: string; artifact_id: string; sha256: string }
  >(
    `select v.id, v.artifact_id, v.sha256
       from bakery.artifact_versions v
      where v.organization_id = $1 and v.task_id = $2
        and v.purged_at is null and v.id = any($3::uuid[])`,
    [input.organizationId, input.taskId, ids],
  );
  const known = new Map(versions.rows.map((row) => [row.id, row]));
  return refs.every((ref) => {
    const row = known.get(ref.versionId);
    return row !== undefined && row.artifact_id === ref.artifactId &&
      row.sha256 === ref.sha256;
  });
}

/** The source session row the decision reads. */
export async function loadSourceSession(
  transaction: PgTransactionClient,
  organizationId: string,
  sessionId: string,
): Promise<SourceSession | null> {
  const result = await transaction.query<
    { id: string; status: string; resume_ref: unknown }
  >(
    `select id, status, resume_ref from bakery.agent_sessions
      where organization_id = $1 and id = $2`,
    [organizationId, sessionId],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, status: row.status, resumeRef: row.resume_ref }
    : null;
}

export async function decideManifestResume(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    runId: string;
    runStepId: string;
    manifestId: string;
    manifestDigest: string;
    manifest: HandoffManifest;
    sourceHostId: string;
  },
): Promise<{ decision: ResumeDecision; effectsSettled: boolean }> {
  const unsettledEffects = await transaction.query(
    `select 1 from bakery.external_effects
      where organization_id = $1 and run_step_id = $2 and status = any($3::text[])
      limit 1`,
    [input.organizationId, input.runStepId, [...NON_REPLAY_SAFE_EFFECT_STATES]],
  );
  const effectsSettled = unsettledEffects.rows.length === 0;
  const wantsExact = input.manifest.mode === "exact_harness_resume";
  const decision = decideResume({
    manifestId: input.manifestId,
    manifestDigest: input.manifestDigest,
    manifest: input.manifest,
    session: wantsExact
      ? await loadSourceSession(
        transaction,
        input.organizationId,
        input.manifest.sourceSessionId,
      )
      : null,
    sourceHostId: input.sourceHostId,
    effectsSettled,
    historyAuthorized: wantsExact
      ? await historyIsAuthorized(transaction, {
        organizationId: input.organizationId,
        taskId: input.manifest.taskId,
        runId: input.runId,
        manifest: input.manifest,
      })
      : false,
  });
  return { decision, effectsSettled };
}
