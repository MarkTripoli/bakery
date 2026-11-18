-- Frozen references a draft is sent to an agent with (#28, chapter 20 "Send
-- draft to agent"). One reference names an exact committed checkpoint of a
-- draft (epoch, server sequence and canonical content digest) and the exact
-- discussion threads chosen with it, captured under compare-and-swap against
-- each root's row_version. Turn and workflow admission may later consume the
-- reference; nothing here changes how they run. Both tables are insert only:
-- later edits of the draft text or of a comment, or resolving it, never
-- alter what a reference recorded. The client mutation id makes a retried
-- send answer with the same reference.
create table bakery.artifact_draft_references (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  draft_id uuid not null,
  epoch integer not null,
  checkpoint_id uuid not null,
  server_sequence bigint not null,
  content_digest text not null,
  created_by uuid not null,
  -- 'person' or 'agent' (O50).
  actor_kind text not null,
  access_token_id uuid,
  client_mutation_id uuid not null,
  request_digest text not null,
  request_id text not null,
  trace_id text not null,
  created_at timestamptz not null default now(),
  constraint artifact_draft_references_draft_fk
    foreign key (organization_id, draft_id)
    references bakery.artifact_drafts (organization_id, id) on delete cascade,
  constraint artifact_draft_references_checkpoint_fk
    foreign key (organization_id, checkpoint_id)
    references bakery.artifact_draft_checkpoints (organization_id, id),
  constraint artifact_draft_references_creator_fk
    foreign key (created_by) references bakery.principals (id)
    on delete restrict,
  constraint artifact_draft_references_org_id_unique
    unique (organization_id, id),
  constraint artifact_draft_references_mutation_unique
    unique (organization_id, draft_id, client_mutation_id)
);

-- One captured comment of a reference: a chosen root or one of its retained
-- replies, frozen as it was at capture (version, body, quote and cursors).
-- The body is copied, not pointed at, so a later edit, deletion or
-- resolution of the live comment leaves the reference as it was.
create table bakery.artifact_draft_reference_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  reference_id uuid not null,
  -- Order of the comment in the reference: roots as requested, each followed
  -- by its replies oldest first.
  position integer not null,
  draft_comment_id uuid not null,
  -- Null for a root, the captured root for a reply.
  parent_comment_id uuid,
  row_version integer not null,
  author_id uuid not null,
  actor_kind text not null,
  body text not null,
  body_digest text not null,
  start_cursor text,
  end_cursor text,
  coordinate_encoding text,
  quote text,
  -- open or resolved for a root at capture, null for a reply.
  status text,
  comment_created_at timestamptz not null,
  constraint artifact_draft_reference_comments_reference_fk
    foreign key (organization_id, reference_id)
    references bakery.artifact_draft_references (organization_id, id)
    on delete cascade,
  constraint artifact_draft_reference_comments_comment_fk
    foreign key (organization_id, draft_comment_id)
    references bakery.artifact_draft_comments (organization_id, id)
    on delete cascade,
  constraint artifact_draft_reference_comments_once
    unique (organization_id, reference_id, draft_comment_id),
  constraint artifact_draft_reference_comments_position_unique
    unique (organization_id, reference_id, position)
);

grant select, insert on bakery.artifact_draft_references to bakery_app;
grant select, insert on bakery.artifact_draft_reference_comments
  to bakery_app;
