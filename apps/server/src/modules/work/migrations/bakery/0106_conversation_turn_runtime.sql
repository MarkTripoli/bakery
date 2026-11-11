-- Coordinator turn runtime. A turn pins the scoped agent version it will run,
-- and the application role may move a turn through its lifecycle without
-- gaining write access to identity columns. TypeScript owns the closed
-- intent, message type and status vocabularies; the PostgreSQL boundary rail
-- forbids CHECK constraints in new migrations.
alter table bakery.conversation_turns
  add column agent_version_id uuid,
  add column output_message_id uuid,
  add column lease_expires_at timestamptz,
  add column cancel_requested_at timestamptz,
  add column started_at timestamptz,
  add constraint conversation_turns_agent_version_fk
  foreign key (organization_id, agent_version_id)
  references bakery.agent_versions (organization_id, id) on delete restrict,
  add constraint conversation_turns_output_message_scope_fk
  foreign key (organization_id, conversation_id, output_message_id)
  references bakery.messages (organization_id, conversation_id, id)
  on delete restrict;

-- Recovery scans only non-terminal turns whose lease is missing or expired.
create index conversation_turns_recovery_idx
  on bakery.conversation_turns (status, lease_expires_at, id)
  where status in ('queued', 'active', 'cancel_requested');

-- Lifecycle columns only: organization, conversation, trigger message and
-- admission pins (cutoff, agent version) stay immutable after admission.
grant update (
  status, agent_session_id, finished_at, failure, output_message_id,
  lease_expires_at, cancel_requested_at, started_at, updated_at, version
)
  on bakery.conversation_turns
  to bakery_app;
