-- The decisions ledger (chapter 25 §9 and §17.1): every decision and steer a work
-- item carries, recorded before it is delivered and never edited afterwards.
--
-- Why append-only: a decision can be reversed by a later decision, so the way to
-- show what actually happened is to keep both entries. §9: "Every steer is
-- recorded before delivery, in the session's inputs and in the work item's
-- decisions ledger." An edited ledger would let the record disagree with the
-- decisions the interpreter already acted on.
--
-- Rules for this table:
-- * The kind vocabulary, the requirement that accept_with_reason and stop carry a
--   reason, the text bounds and the refusal of NUL and lone surrogates are
--   enforced in TypeScript by @bakery/contracts/human-approval. The PostgreSQL
--   boundary rails forbid CHECK constraints, triggers and functions here.
-- * bakery_app gets SELECT and INSERT only. There is no UPDATE or DELETE grant:
--   an edit is a new entry, and a work item is never rewritten.
-- * subject_kind is bounded text, not an enum, because the subjects a decision
--   can name grow with the extension points (a run, a step, an approval, a
--   question, a document version). subject_id carries no foreign key for the
--   same reason: one column cannot reference five tables. Integrity for the
--   exact subject is checked by the writer, which knows which table it means.
-- * detail is kind-specific data (previous and new limit, the superseded
--   approval, and so on) and is never interpreted by the kernel.
-- * The ledger is not the approval record. An approval keeps its own decision,
--   decision_comment and revoked columns on bakery.questions (0115); the ledger
--   is the readable history of what people and agents decided across the item.
create table bakery.decisions_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  run_id uuid,
  kind text not null,
  subject_kind text not null,
  subject_id uuid not null,
  decided_by uuid not null,
  decided_at timestamptz not null default now(),
  reason text,
  text text,
  detail jsonb,
  created_at timestamptz not null default now(),
  constraint decisions_ledger_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint decisions_ledger_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete cascade,
  constraint decisions_ledger_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint decisions_ledger_decided_by_fk
    foreign key (decided_by)
    references bakery.principals (id) on delete restrict,
  constraint decisions_ledger_organization_id_unique
    unique (organization_id, id)
);

-- A work item's ledger is read oldest-first, which is the order the decisions
-- were made in; id breaks a timestamp tie so the page is stable.
create index decisions_ledger_task_idx
  on bakery.decisions_ledger (organization_id, task_id, decided_at, id);
-- A run's own decisions, for the run view and for the interpreter.
create index decisions_ledger_run_idx
  on bakery.decisions_ledger (organization_id, run_id, decided_at, id)
  where run_id is not null;
-- "what happened to this approval/step/document?" is a lookup by subject.
create index decisions_ledger_subject_idx
  on bakery.decisions_ledger (organization_id, subject_kind, subject_id, decided_at);

grant select, insert on bakery.decisions_ledger to bakery_app;