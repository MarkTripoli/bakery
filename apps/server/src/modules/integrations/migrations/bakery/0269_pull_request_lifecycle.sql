-- Pull request lifecycle facts for development metrics (chapter 18, issue #46).
--
-- The current row keeps the provider's own lifecycle times and the diff
-- totals of its latest read, all null until a read carries them:
--   opened_at      provider created_at; first known value is kept;
--   merged_at      provider merged_at; once set it is never cleared, so a late
--                  or reordered "closed" read cannot undo a confirmed merge;
--   closed_at      provider closed_at of the latest read (null while open);
--   additions, deletions, changed_files
--                  the provider's totals for the pull request's diff; null is
--                  unknown, never zero;
--   diff_coverage  how those totals were obtained (TypeScript vocabulary in
--                  pull-request-lifecycle.ts, not a CHECK constraint).
--
-- pull_request_transitions keeps each lifecycle fact once: a stable identity
-- (the pull request row: repository + provider number) plus kind and effective
-- provider time. A webhook delivered twice, or a sweep rereading the same
-- state, inserts nothing new. observed_at is when Bakery first saw the fact,
-- kept apart from the provider's effective time. Rows are never updated or
-- deleted by the application. Which facts a read implies, and every metric
-- computed from them, live in TypeScript; nothing here enforces a rule.
alter table bakery.pull_requests
  add column opened_at timestamptz,
  add column merged_at timestamptz,
  add column closed_at timestamptz,
  add column additions integer,
  add column deletions integer,
  add column changed_files integer,
  add column diff_coverage text;

grant update (opened_at, merged_at, closed_at, additions, deletions,
  changed_files, diff_coverage)
  on bakery.pull_requests to bakery_app;

-- Metric windows read pull requests of one organization by lifecycle time.
create index pull_requests_opened_idx
  on bakery.pull_requests (organization_id, opened_at, id);
create index pull_requests_merged_idx
  on bakery.pull_requests (organization_id, merged_at, id);
create index pull_requests_closed_idx
  on bakery.pull_requests (organization_id, closed_at, id);

create table bakery.pull_request_transitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pull_request_id uuid not null,
  kind text not null,
  effective_at timestamptz not null,
  observed_at timestamptz not null default now(),
  constraint pull_request_transitions_identity_unique
    unique (pull_request_id, kind, effective_at),
  constraint pull_request_transitions_pull_request_fk
    foreign key (organization_id, pull_request_id)
    references bakery.pull_requests (organization_id, id) on delete cascade
);

create index pull_request_transitions_window_idx
  on bakery.pull_request_transitions (organization_id, kind, effective_at, id);

grant select, insert on bakery.pull_request_transitions to bakery_app;
