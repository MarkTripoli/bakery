-- Capability bindings on seats, and bindings an Admin can withdraw (#436,
-- docs/technical-design/25-one-engine.md 15.4 and 15.5).
--
-- A seat is the role a step runs as. It is addressed as a workflow version plus
-- the seat's name, so a seat binding is a workflow-version binding with
-- seat_key set; it reaches every step of that version that runs as the seat.
-- The application checks that a seat key comes with a workflow version, the
-- same way it checks step_key.
alter table bakery.capability_bindings
  add column seat_key text;

-- The gateway's read for one session: the bindings of its workflow version,
-- narrowed to its step and its seat.
create index capability_bindings_workflow_version_seat_idx
  on bakery.capability_bindings (organization_id, workflow_version_id, seat_key)
  where seat_key is not null;

-- Keyset order of capabilityBindings.list.
create index capability_bindings_organization_created_idx
  on bakery.capability_bindings (organization_id, created_at desc, id desc);

-- An Admin withdraws a binding they made on an agent version
-- (capabilityBindings.delete). Bindings stay select-and-insert only, so no pin
-- can be changed or removed; a withdrawal is its own append-only row, and every
-- read of a grant skips a withdrawn binding. A pin a workflow version wrote at
-- publish is never withdrawn: the application refuses it, and a changed pin is
-- a new version.
create table bakery.capability_binding_revocations (
  organization_id uuid not null,
  binding_id uuid not null,
  revoked_by uuid not null,
  revoked_at timestamptz not null default now(),
  constraint capability_binding_revocations_pkey
    primary key (organization_id, binding_id),
  constraint capability_binding_revocations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint capability_binding_revocations_binding_fk
    foreign key (organization_id, binding_id)
    references bakery.capability_bindings (organization_id, id)
    on delete cascade
);

grant select, insert on bakery.capability_binding_revocations to bakery_app;

-- One row per call a session made through its tool gateway
-- (worker.invokeTool): the audit of the call and the at-most-once record of a
-- write. The row is written before the call is sent and settled after, so a
-- replay of the same Idempotency-Key finds what happened instead of sending
-- again, and a call whose outcome is not known stays 'sent' for a person to
-- settle rather than being retried.
create table bakery.tool_gateway_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  attempt_id uuid not null,
  idempotency_key uuid not null,
  mcp_connection_id uuid not null,
  tool_name text not null,
  snapshot_digest text not null,
  -- The digest of the canonical request (connection, tool name as asked and
  -- arguments), so a replay that differs in any of them under the same key is
  -- refused rather than answered with this call's result.
  arguments_digest text not null,
  read_only boolean not null,
  -- sent, completed, failed or refused. Only 'sent' is ever updated.
  status text not null,
  result jsonb,
  failure_code text,
  acting_for_principal_id uuid,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint tool_gateway_calls_status_check
    check (status in ('sent', 'completed', 'failed', 'refused')),
  constraint tool_gateway_calls_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint tool_gateway_calls_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint tool_gateway_calls_connection_fk
    foreign key (organization_id, mcp_connection_id)
    references bakery.mcp_connections (organization_id, id) on delete cascade,
  constraint tool_gateway_calls_key_unique
    unique (organization_id, attempt_id, idempotency_key)
);

-- An attempt's calls in order, for the feed and the audit.
create index tool_gateway_calls_attempt_idx
  on bakery.tool_gateway_calls (organization_id, attempt_id, created_at, id);

grant select, insert on bakery.tool_gateway_calls to bakery_app;
grant update (status, result, failure_code, settled_at)
  on bakery.tool_gateway_calls to bakery_app;
