alter table bakery.worker_commands
  add column idempotency_key text,
  add column request_digest text;

create unique index worker_commands_control_replay_unique
  on bakery.worker_commands (organization_id, attempt_id, idempotency_key)
  where idempotency_key is not null;


grant insert (idempotency_key, request_digest)
  on bakery.worker_commands
  to bakery_app;
