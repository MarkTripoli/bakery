-- Discussion threads on a collaborative draft (#28, chapter 20 "Comments on
-- a moving document"). They are separate from the version-pinned
-- artifact_comments and keep the same moderation, flat-reply, resolution and
-- row_version guards. A root is anchored by two encoded Loro cursors, the
-- coordinate encoding they were made with, the quoted text and the checkpoint
-- it was created at. Bodies and resolution live only here, never in the
-- editable Loro text. Status, actor kind and anchor rules are validated by the
-- server, not the database. The client mutation id makes a retried create
-- answer with the same comment.
create table bakery.artifact_draft_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  draft_id uuid not null,
  epoch integer not null,
  -- Null for a root, the root comment for a flat reply.
  parent_comment_id uuid,
  author_id uuid not null,
  -- 'person' or 'agent' (O50).
  actor_kind text not null,
  access_token_id uuid,
  body text not null,
  -- Encoded Loro cursors as canonical base64, roots only.
  start_cursor text,
  end_cursor text,
  coordinate_encoding text,
  quote text,
  creation_checkpoint_id uuid not null,
  client_mutation_id uuid not null,
  request_digest text not null,
  request_id text not null,
  trace_id text not null,
  -- open or resolved for a root, null for a reply.
  status text,
  resolved_by uuid,
  resolved_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid,
  row_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint artifact_draft_comments_draft_fk
    foreign key (organization_id, draft_id)
    references bakery.artifact_drafts (organization_id, id) on delete cascade,
  constraint artifact_draft_comments_checkpoint_fk
    foreign key (organization_id, creation_checkpoint_id)
    references bakery.artifact_draft_checkpoints (organization_id, id),
  constraint artifact_draft_comments_author_fk
    foreign key (author_id) references bakery.principals (id)
    on delete restrict,
  constraint artifact_draft_comments_resolver_fk
    foreign key (resolved_by) references bakery.principals (id),
  constraint artifact_draft_comments_deleter_fk
    foreign key (deleted_by) references bakery.principals (id),
  constraint artifact_draft_comments_org_id_unique
    unique (organization_id, id),
  constraint artifact_draft_comments_draft_id_unique
    unique (organization_id, draft_id, id),
  constraint artifact_draft_comments_parent_fk
    foreign key (organization_id, draft_id, parent_comment_id)
    references bakery.artifact_draft_comments (organization_id, draft_id, id),
  constraint artifact_draft_comments_mutation_unique
    unique (organization_id, draft_id, client_mutation_id)
);

create index artifact_draft_comments_page_idx
  on bakery.artifact_draft_comments
  (organization_id, draft_id, parent_comment_id, created_at, id);

grant select, insert on bakery.artifact_draft_comments to bakery_app;
grant update (body, status, resolved_by, resolved_at, deleted_at, deleted_by,
  row_version, updated_at)
  on bakery.artifact_draft_comments to bakery_app;
