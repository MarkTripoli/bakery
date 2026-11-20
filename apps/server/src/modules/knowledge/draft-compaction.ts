import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "@bakery/persistence";
import { sha256Bytes } from "./bytes.ts";
import { DRAFT_LIMITS } from "./drafts.ts";

/** What one compaction pass removed from a draft epoch. */
export type DraftCompaction = {
  receipts: number;
  updates: number;
  checkpoints: number;
};

/** Bounds of one pass; every field defaults to the matching DRAFT_LIMITS value. */
export type DraftCompactionOptions = {
  receiptRetrySeconds?: number;
  keptCheckpoints?: number;
  batchRows?: number;
};

/**
 * Bytes one draft epoch retains: every checkpoint's state and frontiers plus
 * every update row. The chapter 20 cap (16 MiB per epoch) is measured on this.
 */
export async function measureDraftEpochBytes(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  epoch: number,
): Promise<number> {
  const result = await transaction.query<{ bytes: string }>(
    `select (
       coalesce((select sum(octet_length(state)+octet_length(frontiers))
                   from bakery.artifact_draft_checkpoints
                  where organization_id=$1 and draft_id=$2 and epoch=$3),0) +
       coalesce((select sum(octet_length(update_bytes))
                   from bakery.artifact_draft_updates
                  where organization_id=$1 and draft_id=$2 and epoch=$3),0)
     )::text as bytes`,
    [organizationId, draftId, epoch],
  );
  return Number(result.rows[0]?.bytes ?? 0);
}

/**
 * One bounded compaction pass over a draft epoch. The caller holds the draft
 * row lock, so the current checkpoint cannot move underneath it. The current
 * checkpoint is verified first (its digest is recomputed from its text);
 * nothing is removed when that fails. Then, in order: receipts past the retry
 * window, update rows, and checkpoints that are neither among the newest few
 * nor named by a publication, a comment, a comment publication, a reference or
 * a waiting suggestion. A pass removes at most one batch per table, so a draft
 * that stays over its cap is refused by the caller instead of compacted again.
 */
export async function compactDraftEpoch(
  transaction: PgTransactionClient,
  organizationId: string,
  draftId: string,
  epoch: number,
  options: DraftCompactionOptions = {},
): Promise<DraftCompaction> {
  const retrySeconds = options.receiptRetrySeconds ??
    DRAFT_LIMITS.receiptRetrySeconds;
  const kept = options.keptCheckpoints ?? DRAFT_LIMITS.keptCheckpoints;
  const batch = options.batchRows ?? DRAFT_LIMITS.compactionBatchRows;
  const current = (await transaction.query<{
    id: string;
    text_content: string;
    text_digest: string;
    state_bytes: number;
  }>(
    `select c.id,c.text_content,c.text_digest,octet_length(c.state) as state_bytes
       from bakery.artifact_drafts d
       join bakery.artifact_draft_checkpoints c
         on c.organization_id=d.organization_id and c.id=d.current_checkpoint_id
      where d.organization_id=$1 and d.id=$2 and d.epoch=$3 and c.epoch=$3`,
    [organizationId, draftId, epoch],
  )).rows[0];
  if (!current || current.state_bytes === 0) {
    throw new StandardError({ code: "INTERNAL" });
  }
  const digest = await sha256Bytes(
    new TextEncoder().encode(current.text_content),
  );
  if (digest !== current.text_digest) {
    throw new StandardError({ code: "INTERNAL" });
  }
  const receipts = await transaction.query(
    `delete from bakery.artifact_draft_receipts
      where id in (
        select id from bakery.artifact_draft_receipts
         where organization_id=$1 and draft_id=$2 and epoch=$3
           and committed_at < clock_timestamp() - make_interval(secs => $4)
         order by server_sequence
         limit $5)`,
    [organizationId, draftId, epoch, retrySeconds, batch],
  );
  const updates = await transaction.query(
    `delete from bakery.artifact_draft_updates
      where id in (
        select id from bakery.artifact_draft_updates
         where organization_id=$1 and draft_id=$2 and epoch=$3
           and server_sequence < (
             select server_sequence from bakery.artifact_draft_checkpoints
              where organization_id=$1 and id=$5)
         order by server_sequence
         limit $4)`,
    [organizationId, draftId, epoch, batch, current.id],
  );
  const checkpoints = await transaction.query(
    `delete from bakery.artifact_draft_checkpoints
      where id in (
        select c.id from bakery.artifact_draft_checkpoints c
         where c.organization_id=$1 and c.draft_id=$2 and c.epoch=$3
           and c.id <> $4
           and c.id not in (
             select k.id from bakery.artifact_draft_checkpoints k
              where k.organization_id=$1 and k.draft_id=$2 and k.epoch=$3
              order by k.server_sequence desc limit $5)
           and not exists (select 1 from bakery.artifact_draft_publications p
                            where p.organization_id=c.organization_id
                              and p.checkpoint_id=c.id)
           and not exists (select 1 from bakery.artifact_draft_comments m
                            where m.organization_id=c.organization_id
                              and m.creation_checkpoint_id=c.id)
           and not exists (select 1 from bakery.artifact_draft_comment_publications q
                            where q.organization_id=c.organization_id
                              and q.source_checkpoint_id=c.id)
           and not exists (select 1 from bakery.artifact_draft_references r
                            where r.organization_id=c.organization_id
                              and r.checkpoint_id=c.id)
           and not exists (select 1 from bakery.artifact_draft_suggestions s
                            where s.organization_id=c.organization_id
                              and s.source_checkpoint_id=c.id
                              and s.state='waiting')
         order by c.server_sequence
         limit $6)`,
    [organizationId, draftId, epoch, current.id, kept, batch],
  );
  return {
    receipts: receipts.rowCount ?? 0,
    updates: updates.rowCount ?? 0,
    checkpoints: checkpoints.rowCount ?? 0,
  };
}
