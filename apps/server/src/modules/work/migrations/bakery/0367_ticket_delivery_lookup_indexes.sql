create index pull_requests_task_created_idx
  on bakery.pull_requests
  (organization_id, task_id, created_at desc, id desc)
  include (repository_id, provider_number, status);

create index pull_request_merge_attempts_merged_idx
  on bakery.pull_request_merge_attempts
  (organization_id, pull_request_id, created_at desc, id desc)
  include (base_branch)
  where state = 'merged';

create index deployments_run_created_idx
  on bakery.deployments
  (organization_id, run_id, created_at desc, id desc)
  include (environment, status);

create index batch_issues_ticket_request_idx
  on bakery.batch_issues
  (organization_id, ticket_request_id)
  include (batch_id)
  where ticket_request_id is not null;
