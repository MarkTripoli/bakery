-- Pull request reads (issue #57). run_id ties a tracked pull request to the
-- workflow run that opened it, so check runs and review cycles of that run
-- can name the pull request whose head they judged (joined on run and head
-- SHA at read time; neither evidence table stores the pull request). Null for
-- a pull request registered without a run. A run delete is refused while a
-- pull request names it, like the task reference.
--
-- created_at and updated_at back the PullRequest projection. Rows that exist
-- before this migration take the migration time; updated_at moves only with
-- an observation that changes the stored state, alongside version.
alter table bakery.pull_requests
  add column run_id uuid,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add constraint pull_requests_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id);

create index pull_requests_run_head
  on bakery.pull_requests (organization_id, run_id, head_sha)
  where run_id is not null;
create index pull_requests_organization_keyset
  on bakery.pull_requests (organization_id, created_at, id);

grant update (updated_at) on bakery.pull_requests to bakery_app;
