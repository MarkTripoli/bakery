-- Provenance of draft comments copied onto a published version (#28, chapter
-- 20 "Comments on a moving document"). A publication may project named open
-- draft threads: each root and its retained replies become version-pinned
-- artifact_comments, and one row here records which draft comment became
-- which artifact comment on which version, from which frozen checkpoint. The
-- draft comment itself is not changed. One draft comment is copied at most
-- once per version, so a replayed publication cannot duplicate a projection.
create table bakery.artifact_draft_comment_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  draft_id uuid not null,
  draft_comment_id uuid not null,
  artifact_version_id uuid not null,
  artifact_comment_id uuid not null,
  source_checkpoint_id uuid not null,
  created_at timestamptz not null default now(),
  constraint artifact_draft_comment_publications_comment_fk
    foreign key (organization_id, draft_id, draft_comment_id)
    references bakery.artifact_draft_comments (organization_id, draft_id, id)
    on delete cascade,
  constraint artifact_draft_comment_publications_artifact_comment_fk
    foreign key (organization_id, artifact_version_id, artifact_comment_id)
    references bakery.artifact_comments
      (organization_id, artifact_version_id, id)
    on delete cascade,
  constraint artifact_draft_comment_publications_checkpoint_fk
    foreign key (organization_id, source_checkpoint_id)
    references bakery.artifact_draft_checkpoints (organization_id, id),
  constraint artifact_draft_comment_publications_once_per_version
    unique (organization_id, draft_comment_id, artifact_version_id),
  constraint artifact_draft_comment_publications_artifact_comment_unique
    unique (organization_id, artifact_comment_id)
);

create index artifact_draft_comment_publications_comment_idx
  on bakery.artifact_draft_comment_publications
  (organization_id, draft_comment_id, created_at, id);

grant select, insert on bakery.artifact_draft_comment_publications
  to bakery_app;
