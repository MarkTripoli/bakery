-- Agent edits to a collaborative draft arrive as suggestions (#71, chapter 20
-- and chapter 25 O50 to O52). A suggestion keeps the anchored range, the text
-- it replaces and the proposed text. A person accepts it through the normal
-- draft edit path, so the applied change is an ordinary receipt. The state,
-- actor kind and refusal reason are validated by the server, not the
-- database. The client mutation id makes a retried request answer with the
-- same suggestion.
create table bakery.artifact_draft_suggestions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  draft_id uuid not null,
  epoch integer not null,
  source_checkpoint_id uuid not null,
  start_cursor text not null,
  end_cursor text not null,
  expected_text text not null,
  expected_digest text not null,
  replacement text not null,
  client_mutation_id uuid not null,
  request_digest text not null,
  requested_by_id uuid not null,
  -- 'person' or 'agent' (O50).
  actor_kind text not null,
  access_token_id uuid,
  request_id text not null,
  trace_id text not null,
  -- waiting, accepted, rejected or no_longer_fits.
  state text not null default 'waiting',
  -- text_changed or draft_moved_on, only for no_longer_fits.
  refusal_reason text,
  decided_by_id uuid,
  decided_at timestamptz,
  applied_server_sequence bigint,
  created_at timestamptz not null default now(),
  constraint artifact_draft_suggestions_draft_fk
    foreign key (organization_id, draft_id)
    references bakery.artifact_drafts (organization_id, id) on delete cascade,
  constraint artifact_draft_suggestions_requester_fk
    foreign key (requested_by_id) references bakery.principals (id)
    on delete restrict,
  constraint artifact_draft_suggestions_decider_fk
    foreign key (decided_by_id) references bakery.principals (id)
    on delete restrict,
  constraint artifact_draft_suggestions_org_id_unique
    unique (organization_id, id),
  constraint artifact_draft_suggestions_mutation_unique
    unique (organization_id, draft_id, client_mutation_id)
);

create index artifact_draft_suggestions_draft_created_idx
  on bakery.artifact_draft_suggestions
  (organization_id, draft_id, created_at, id);

grant select, insert, update on bakery.artifact_draft_suggestions to bakery_app;
