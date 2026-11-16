-- One serialized merge-queue entry per pull request (#40, B10.04). An entry
-- names the exact candidate it admits: the head, the base and the policy digest
-- the check and review evidence was gathered under. The partial unique indexes
-- are the serialization: at most one active entry per repository and target
-- branch, and at most one active entry per pull request, so two callers cannot
-- both advance the same repository and target toward merging. Status values are
-- validated by the server, not by the database.
create table bakery.merge_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pull_request_id uuid not null,
  repository_id uuid not null,
  target_branch text not null,
  expected_head_sha text not null,
  expected_base_sha text not null,
  -- queued, validating, merging, merged, blocked or canceled.
  status text not null default 'queued',
  external_effect_id uuid,
  run_id uuid not null,
  policy_digest text not null,
  review_cycle_id uuid not null,
  requested_by_id uuid not null,
  request_id text not null,
  trace_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint merge_entries_organization_id_unique
    unique (organization_id, id),
  constraint merge_entries_pull_request_fk
    foreign key (organization_id, pull_request_id)
    references bakery.pull_requests (organization_id, id) on delete cascade,
  constraint merge_entries_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete cascade,
  constraint merge_entries_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint merge_entries_review_cycle_fk
    foreign key (organization_id, review_cycle_id)
    references bakery.review_cycles (organization_id, id) on delete cascade,
  constraint merge_entries_requester_fk
    foreign key (requested_by_id) references bakery.principals (id)
    on delete restrict
);

-- The serialization the design promises: one active entry per repository and
-- target branch, so the target merges one candidate at a time.
create unique index merge_entries_active_target_unique
  on bakery.merge_entries (organization_id, repository_id, target_branch)
  where status in ('queued', 'validating', 'merging');

-- One active entry per pull request too: a second admission of the same pull
-- request answers with the entry already advancing it.
create unique index merge_entries_active_pull_request_unique
  on bakery.merge_entries (organization_id, pull_request_id)
  where status in ('queued', 'validating', 'merging');

create index merge_entries_list_idx
  on bakery.merge_entries (organization_id, created_at desc, id desc);

-- The check runs one entry relies on. Each linked run must share the entry's
-- exact head, base and policy digest; that is verified when the entry is
-- written and re-verified before the merge is dispatched.
create table bakery.merge_entry_check_runs (
  organization_id uuid not null,
  merge_entry_id uuid not null,
  check_run_id uuid not null,
  primary key (organization_id, merge_entry_id, check_run_id),
  constraint merge_entry_check_runs_entry_fk
    foreign key (organization_id, merge_entry_id)
    references bakery.merge_entries (organization_id, id) on delete cascade,
  constraint merge_entry_check_runs_run_fk
    foreign key (organization_id, check_run_id)
    references bakery.check_runs (organization_id, id) on delete cascade
);

grant select, insert, update on bakery.merge_entries to bakery_app;
grant select, insert on bakery.merge_entry_check_runs to bakery_app;
