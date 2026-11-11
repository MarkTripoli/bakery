-- Steering capabilities a worker session's harness adapters advertise. The
-- worker reports them with its session heartbeat; TypeScript owns the closed
-- vocabulary (stream, resume, steer, follow_up, interrupt) because the
-- PostgreSQL boundary rail forbids CHECK constraints in new migrations.
alter table bakery.worker_hosts
  add column adapter_capabilities jsonb not null default '[]'::jsonb;

grant update (adapter_capabilities)
  on bakery.worker_hosts
  to bakery_app;
