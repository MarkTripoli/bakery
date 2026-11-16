-- One durable record per merge dispatch (#40, B10.04). A merge is dispatched
-- against an exact expected head and base, and the row records what Bakery knew
-- when it sent it and what the provider answered. `unknown` is a real state: a
-- lost answer may still mean GitHub merged, so the row is settled by a
-- reconciliation read instead of by a second dispatch. The state values are
-- validated by the server, not by the database.
create table bakery.pull_request_merge_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  pull_request_id uuid not null,
  repository_id uuid not null,
  provider_number integer not null,
  base_branch text not null,
  expected_head_sha text not null,
  expected_base_sha text,
  merge_method text not null,
  -- 'merged', 'refused' or 'unknown' until a reconciliation settles it.
  state text not null default 'unknown',
  -- The provider's status for a refused or merged answer; null while unknown.
  provider_status integer,
  merged_sha text,
  requested_by_id uuid not null,
  request_id text not null,
  trace_id text not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint pull_request_merge_attempts_pr_fk
    foreign key (organization_id, pull_request_id)
    references bakery.pull_requests (organization_id, id) on delete cascade,
  constraint pull_request_merge_attempts_org_id_unique
    unique (organization_id, id),
  constraint pull_request_merge_attempts_requester_fk
    foreign key (requested_by_id) references bakery.principals (id)
    on delete restrict
);

-- The serialization key: one merge at a time per repository and target branch,
-- which is what makes "the verified candidate" mean anything across concurrent
-- callers.
create index pull_request_merge_attempts_target_idx
  on bakery.pull_request_merge_attempts
  (organization_id, repository_id, base_branch, created_at desc, id desc);

-- The reconciliation read: attempts still unknown, oldest first, so a lost
-- answer is resolved before another merge is sent for the same pull request.
create index pull_request_merge_attempts_unknown_idx
  on bakery.pull_request_merge_attempts
  (organization_id, pull_request_id, created_at)
  where state = 'unknown';

grant select, insert, update on bakery.pull_request_merge_attempts to bakery_app;
