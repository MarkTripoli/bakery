-- More repair tries for a run whose loop stopped for lack of them (issue #62).
-- One insert-only row per allowance, like the other evidence of the loop
-- (0147): the application role may insert and select, never update or delete,
-- so what a person allowed cannot be edited afterwards. The frozen policy in the
-- run's snapshot is never rewritten; the effective bound is that policy plus the
-- rows here, read together.
--   answers_decision_ordinal  the stop decision (reason repair_cycles_exhausted)
--                             this allowance answers; unique per run, so asking
--                             twice for the same stop is one allowance.
--   decision_ordinal          the repair decision recorded with the allowance,
--                             which is what lets the run go on.
--   repeat_key                step key of the repeat the review sits in, whose
--                             bound the interpreter raises by added_tries.
--   max_repair_cycles         the effective bound after this allowance.
--   requested_by              the person who allowed it; a principal, not a
--                             foreign key, as in review_cycles.
-- Structure only: vocabulary and bounds are enforced in TypeScript.
create table bakery.repair_allowances (
  id uuid primary key,
  organization_id uuid not null,
  run_id uuid not null,
  answers_decision_ordinal integer not null,
  decision_ordinal integer not null,
  repeat_key text not null,
  added_tries integer not null,
  max_repair_cycles integer not null,
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  constraint repair_allowances_organization_id_unique
    unique (organization_id, id),
  constraint repair_allowances_run_answers_unique
    unique (organization_id, run_id, answers_decision_ordinal),
  constraint repair_allowances_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete cascade
);

grant select, insert on bakery.repair_allowances to bakery_app;
