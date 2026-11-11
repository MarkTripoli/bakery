-- The authenticated control producer locks the current attempt/job and records
-- cancellation intent in the same transaction as the worker command.
grant insert (
  organization_id,
  attempt_id,
  message_id,
  command_type,
  payload
)
  on bakery.worker_commands
  to bakery_app;

grant update (cancel_requested_at, updated_at, version)
  on bakery.jobs
  to bakery_app;
