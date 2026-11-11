-- Durable questions. A question is raised by a coordinator turn (or, from
-- phase 5, an approval) and answered once by compare-and-swap on status and
-- version. TypeScript owns the closed kind, status and audience vocabularies;
-- the PostgreSQL boundary rail forbids CHECK constraints in new migrations.
create table bakery.questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  kind text not null default 'question',
  conversation_id uuid not null,
  task_id uuid not null,
  run_id uuid,
  turn_id uuid,
  generation integer not null,
  prompt text not null,
  options jsonb,
  allow_free_text boolean not null default false,
  audience jsonb not null default '{"type":"task_participants"}'::jsonb,
  expires_at timestamptz,
  status text not null default 'open',
  answer jsonb,
  answered_by uuid,
  answered_at timestamptz,
  answer_digest text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint questions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint questions_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete restrict,
  constraint questions_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete restrict,
  constraint questions_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete restrict,
  constraint questions_turn_fk
    foreign key (organization_id, turn_id)
    references bakery.conversation_turns (organization_id, id)
    on delete restrict,
  constraint questions_answered_by_fk
    foreign key (answered_by)
    references bakery.principals (id) on delete restrict,
  constraint questions_organization_id_unique unique (organization_id, id)
);

create index questions_conversation_idx
  on bakery.questions (organization_id, conversation_id, created_at desc, id desc);
create index questions_task_idx
  on bakery.questions (organization_id, task_id, created_at desc, id desc);
-- The expiry sweep scans only open questions that carry a deadline.
create index questions_expiry_idx
  on bakery.questions (expires_at, id)
  where status = 'open' and expires_at is not null;

grant select on bakery.questions to bakery_app;
grant insert (
  organization_id, kind, conversation_id, task_id, run_id, turn_id,
  generation, prompt, options, allow_free_text, audience, expires_at
)
  on bakery.questions
  to bakery_app;
-- Identity, prompt, options and audience stay immutable after creation.
grant update (
  status, answer, answered_by, answered_at, answer_digest, updated_at, version
)
  on bakery.questions
  to bakery_app;
