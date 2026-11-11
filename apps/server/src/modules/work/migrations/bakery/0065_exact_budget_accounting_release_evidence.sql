create table bakery.budget_release_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  installation_reservation_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null,
  effect_id text not null,
  kind text not null,
  digest text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint budget_release_evidence_reservation_unique
    unique (installation_reservation_id),
  constraint budget_release_evidence_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint budget_release_evidence_reservation_fk
    foreign key (installation_reservation_id)
    references bakery.budget_reservations (id) on delete restrict,
  constraint budget_release_evidence_job_fk
    foreign key (organization_id, job_id)
    references bakery.jobs (organization_id, id) on delete restrict,
  constraint budget_release_evidence_attempt_job_fk
    foreign key (organization_id, job_id, attempt_id)
    references bakery.job_attempts (organization_id, job_id, id) on delete restrict
);

create index budget_release_evidence_pending_idx
  on bakery.budget_release_evidence (observed_at, id);

create table bakery.budget_reconciliation_failures (
  candidate_kind text not null,
  organization_id uuid not null,
  installation_reservation_id uuid not null,
  candidate_id uuid not null,
  error_code text not null,
  attempts integer not null default 1,
  observed_at timestamptz not null,
  constraint budget_reconciliation_failure_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint budget_reconciliation_failure_reservation_fk
    foreign key (installation_reservation_id)
    references bakery.budget_reservations (id) on delete restrict,
  primary key (candidate_kind, organization_id, candidate_id)
);

revoke all on
  bakery.budget_release_evidence,
  bakery.budget_reconciliation_failures
from public, bakery_app;

grant select on
  bakery.budget_release_evidence,
  bakery.budget_reconciliation_failures
to bakery_app;

grant select, insert, update, delete
  on bakery.budget_reconciliation_failures
  to bakery_app;
