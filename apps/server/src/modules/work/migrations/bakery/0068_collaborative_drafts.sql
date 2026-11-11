-- Durable, task-scoped Loro drafts and authenticated mutation receipts.
create table bakery.artifact_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  artifact_id uuid not null,
  task_id uuid not null,
  epoch integer not null,
  base_version_id uuid,
  current_checkpoint_id uuid,
  server_sequence bigint not null default 0,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint artifact_drafts_artifact_fk
    foreign key (organization_id, artifact_id, task_id)
    references bakery.artifacts (organization_id, id, task_id) on delete cascade,
  constraint artifact_drafts_base_version_fk
    foreign key (organization_id, artifact_id, base_version_id)
    references bakery.artifact_versions (organization_id, artifact_id, id)
    on delete restrict,
  constraint artifact_drafts_organization_id_unique
    unique (organization_id, id),
  constraint artifact_drafts_artifact_unique
    unique (organization_id, artifact_id)
);

create table bakery.artifact_draft_checkpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  draft_id uuid not null,
  epoch integer not null,
  server_sequence bigint not null,
  state bytea not null,
  frontiers bytea not null,
  text_content text not null,
  text_digest text not null,
  created_at timestamptz not null default now(),
  constraint artifact_draft_checkpoints_draft_fk
    foreign key (organization_id, draft_id)
    references bakery.artifact_drafts (organization_id, id) on delete cascade,
  constraint artifact_draft_checkpoints_organization_id_unique
    unique (organization_id, id),
  constraint artifact_draft_checkpoints_sequence_unique
    unique (organization_id, draft_id, epoch, server_sequence)
);

create table bakery.artifact_draft_updates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  draft_id uuid not null,
  epoch integer not null,
  server_sequence bigint not null,
  mutation_id uuid not null,
  actor_id uuid not null,
  update_bytes bytea not null,
  update_digest text not null,
  created_at timestamptz not null default now(),
  constraint artifact_draft_updates_draft_fk
    foreign key (organization_id, draft_id)
    references bakery.artifact_drafts (organization_id, id) on delete cascade,
  constraint artifact_draft_updates_actor_fk
    foreign key (actor_id) references bakery.principals (id) on delete restrict,
  constraint artifact_draft_updates_organization_id_unique
    unique (organization_id, id),
  constraint artifact_draft_updates_sequence_unique
    unique (organization_id, draft_id, epoch, server_sequence),
  constraint artifact_draft_updates_mutation_unique
    unique (organization_id, draft_id, mutation_id)
);

create table bakery.artifact_draft_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  draft_id uuid not null,
  mutation_id uuid not null,
  request_digest text not null,
  actor_id uuid not null,
  epoch integer not null,
  server_sequence bigint not null,
  checkpoint_id uuid not null,
  update_id uuid not null,
  update_digest text not null,
  text_digest text not null,
  committed_at timestamptz not null default now(),
  constraint artifact_draft_receipts_draft_fk
    foreign key (organization_id, draft_id)
    references bakery.artifact_drafts (organization_id, id) on delete cascade,
  constraint artifact_draft_receipts_checkpoint_fk
    foreign key (organization_id, checkpoint_id)
    references bakery.artifact_draft_checkpoints (organization_id, id)
    on delete restrict,
  constraint artifact_draft_receipts_update_fk
    foreign key (organization_id, update_id)
    references bakery.artifact_draft_updates (organization_id, id)
    on delete restrict,
  constraint artifact_draft_receipts_actor_fk
    foreign key (actor_id) references bakery.principals (id) on delete restrict,
  constraint artifact_draft_receipts_unique
    unique (organization_id, draft_id, mutation_id)
);

alter table bakery.artifact_drafts
  add constraint artifact_drafts_current_checkpoint_fk
  foreign key (organization_id, current_checkpoint_id)
  references bakery.artifact_draft_checkpoints (organization_id, id)
  on delete restrict;

create index artifact_draft_checkpoints_draft_created_idx
  on bakery.artifact_draft_checkpoints
  (organization_id, draft_id, created_at desc, id desc);
create index artifact_draft_receipts_draft_sequence_idx
  on bakery.artifact_draft_receipts
  (organization_id, draft_id, server_sequence desc);

grant select, insert on bakery.artifact_drafts to bakery_app;
grant update (current_checkpoint_id, server_sequence, updated_at, status)
  on bakery.artifact_drafts to bakery_app;
grant select, insert on bakery.artifact_draft_checkpoints to bakery_app;
grant select, insert on bakery.artifact_draft_updates to bakery_app;
grant select, insert on bakery.artifact_draft_receipts to bakery_app;
