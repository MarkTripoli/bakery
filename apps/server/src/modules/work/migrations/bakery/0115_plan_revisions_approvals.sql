-- Plan revisions, typed approvals and the stage policy (E06 #160). TypeScript
-- owns the status, decision, subject and policy vocabularies and the digest
-- computation; the PostgreSQL boundary rail forbids CHECK constraints in new
-- migrations, so the database enforces identity, tenancy and immutability only.
--
-- A plan revision is immutable evidence: bakery_app may insert it and move its
-- status, never rewrite its body or digest.
create table bakery.plan_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  conversation_id uuid not null,
  revision integer not null,
  body jsonb not null,
  digest text not null,
  status text not null default 'proposed',
  proposed_by_turn_id uuid,
  supersedes_revision integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint plan_revisions_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint plan_revisions_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete restrict,
  constraint plan_revisions_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete restrict,
  constraint plan_revisions_turn_fk
    foreign key (organization_id, proposed_by_turn_id)
    references bakery.conversation_turns (organization_id, id)
    on delete restrict,
  constraint plan_revisions_organization_id_unique
    unique (organization_id, id),
  -- Revisions are numbered per task; two turns cannot both claim revision N.
  constraint plan_revisions_task_revision_unique
    unique (organization_id, task_id, revision)
);

create index plan_revisions_task_idx
  on bakery.plan_revisions (organization_id, task_id, revision desc);

grant select, insert on bakery.plan_revisions to bakery_app;
grant update (status, updated_at, version)
  on bakery.plan_revisions
  to bakery_app;

-- Approvals are questions of kind 'approval'. The subject, its digest, the
-- stage scope and the policy digest are bound at creation and never change.
alter table bakery.questions
  add column subject_type text,
  add column subject_id uuid,
  add column subject_digest text,
  add column scope jsonb,
  add column policy_digest text,
  add column decision text,
  add column decision_comment text,
  add column decided_by uuid,
  add column decided_at timestamptz,
  add column consumed_at timestamptz,
  add column consumed_by_run_id uuid,
  add column revoked_at timestamptz,
  add column revoked_by uuid,
  add constraint questions_decided_by_fk
    foreign key (decided_by)
    references bakery.principals (id) on delete restrict,
  add constraint questions_revoked_by_fk
    foreign key (revoked_by)
    references bakery.principals (id) on delete restrict,
  -- Deferred: run admission consumes the approval with the new run's id before
  -- the run row is inserted, inside one transaction.
  add constraint questions_consumed_run_fk
    foreign key (organization_id, consumed_by_run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete restrict deferrable initially deferred;

create index questions_approval_subject_idx
  on bakery.questions (organization_id, task_id, subject_type, subject_id)
  where kind = 'approval';

grant insert (
  subject_type, subject_id, subject_digest, scope, policy_digest
)
  on bakery.questions
  to bakery_app;
grant update (
  decision, decision_comment, decided_by, decided_at, consumed_at,
  consumed_by_run_id, revoked_at, revoked_by
)
  on bakery.questions
  to bakery_app;

-- Stage policy. A null policy reads as the legacy policy: the plan stage is
-- automatic, so tasks created before this migration start runs as before.
alter table bakery.tasks
  add column approval_policy jsonb,
  add column planning_only boolean not null default false;
