create index audit_events_run_end_recent_idx
  on bakery.audit_events
    (organization_id, resource_type, resource_id, created_at desc, id desc)
  where operation in ('workflow.plan_failed', 'runs.reopen');
