-- #38 slice 1: compaction of collaborative draft state.
-- Every committed edit stores a full checkpoint, an update row and a receipt,
-- and nothing removed them, so a draft epoch could only grow. Compaction
-- (apps/server/src/modules/knowledge/draft-compaction.ts) removes the
-- superseded ones after the current checkpoint is verified. Two changes let it:
-- the app role may delete these rows, and a receipt no longer pins the
-- checkpoint and update it names. A receipt is a small fact kept for the retry
-- window, and a retry is answered from the receipt alone. Checkpoints that a
-- publication, comment, reference or waiting suggestion names stay pinned by
-- their own foreign keys and by the compaction query.
alter table bakery.artifact_draft_receipts
  drop constraint artifact_draft_receipts_checkpoint_fk,
  drop constraint artifact_draft_receipts_update_fk;

grant delete on bakery.artifact_draft_checkpoints to bakery_app;
grant delete on bakery.artifact_draft_updates to bakery_app;
grant delete on bakery.artifact_draft_receipts to bakery_app;
