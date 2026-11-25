create index job_attempts_worker_host_created_idx
  on bakery.job_attempts (organization_id, worker_host_id, created_at desc, id desc);
