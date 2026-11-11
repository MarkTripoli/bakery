-- Deterministic check results bound to the exact candidate (issue #83). One
-- immutable row per observed check: a fixed policy command run against a
-- detached worktree of the head commit, or a commit, title, description or
-- merge message rule evaluated against trusted pull request metadata. The row
-- stores the identities the result depends on (head, base, profile, effective
-- policy, subject, checker, title, body, merge message, commit selection) so a
-- later change to any of them is detectable without re-running the check.
-- Command rows keep attempt and fence provenance; metadata rows leave job_id,
-- attempt_id and fence null. result (pending, passed, failed, unavailable,
-- canceled) and reason are vocabulary enforced in TypeScript, never here.
-- pull_request_id is omitted until pull_requests has a table. No update or
-- delete grant exists, so evidence cannot be rewritten after it is recorded.
-- Structure only.
create table bakery.check_runs (
  id uuid primary key,
  organization_id uuid not null,
  run_id uuid not null,
  run_step_id uuid,
  job_id uuid,
  attempt_id uuid,
  fence bigint,
  check_id text not null,
  kind text not null,
  rule_key text,
  result text not null,
  reason text not null,
  exit_code integer,
  duration_ms integer,
  output_digest text,
  evidence_version_id uuid,
  provider_run_id text,
  head_sha text not null,
  base_sha text,
  profile_digest text,
  policy_digest text not null,
  subject_digest text not null,
  checker_digest text,
  title_digest text,
  body_digest text,
  merge_message_digest text,
  commit_selection_digest text,
  created_at timestamptz not null default now(),
  constraint check_runs_organization_id_unique
    unique (organization_id, id),
  constraint check_runs_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete cascade,
  constraint check_runs_evidence_version_fk
    foreign key (organization_id, evidence_version_id)
    references bakery.artifact_versions (organization_id, id)
);

create index check_runs_run_idx
  on bakery.check_runs (organization_id, run_id, created_at, id);
create index check_runs_job_attempt_idx
  on bakery.check_runs (organization_id, job_id, attempt_id);

-- A job attempt records each check id once per fence. Metadata rows carry no
-- job, so the index is partial.
create unique index check_runs_job_fence_check_unique
  on bakery.check_runs (organization_id, job_id, fence, check_id)
  where job_id is not null;

grant select, insert on bakery.check_runs to bakery_app;
