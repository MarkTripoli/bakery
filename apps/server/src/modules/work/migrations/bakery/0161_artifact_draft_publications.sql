-- One durable record per published draft checkpoint (#71). The checkpoint is
-- the frozen cutoff; the artifact version is written by the shared
-- artifact-version service. The unique checkpoint and key constraints make a
-- retried publish answer with the same version instead of a second one.
-- A removed version removes its publication record; the checkpoint reference
-- is checked at statement end so a draft removal cascades in one statement.
create table bakery.artifact_draft_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  draft_id uuid not null,
  epoch integer not null,
  checkpoint_id uuid not null,
  server_sequence bigint not null,
  text_digest text not null,
  artifact_id uuid not null,
  artifact_version_id uuid not null,
  version_number integer not null,
  idempotency_key text,
  publisher_id uuid not null,
  actor_kind text not null check (actor_kind in ('person', 'agent')),
  access_token_id uuid,
  published_at timestamptz not null default now(),
  constraint artifact_draft_publications_draft_fk
    foreign key (organization_id, draft_id)
    references bakery.artifact_drafts (organization_id, id) on delete cascade,
  constraint artifact_draft_publications_checkpoint_fk
    foreign key (organization_id, checkpoint_id)
    references bakery.artifact_draft_checkpoints (organization_id, id),
  constraint artifact_draft_publications_version_fk
    foreign key (organization_id, artifact_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, artifact_id, id)
    on delete cascade,
  constraint artifact_draft_publications_publisher_fk
    foreign key (publisher_id) references bakery.principals (id)
    on delete restrict,
  constraint artifact_draft_publications_checkpoint_unique
    unique (organization_id, draft_id, checkpoint_id),
  constraint artifact_draft_publications_key_unique
    unique (organization_id, draft_id, idempotency_key),
  constraint artifact_draft_publications_version_unique
    unique (organization_id, artifact_version_id)
);

create index artifact_draft_publications_draft_sequence_idx
  on bakery.artifact_draft_publications
  (organization_id, draft_id, epoch desc, server_sequence desc);

grant select, insert on bakery.artifact_draft_publications to bakery_app;
