-- Run admission creates the harness session a worker result must reference,
-- so the application role may insert exactly the columns admission supplies.
-- Sessions stay immutable to the application role afterwards.
grant insert (
    organization_id, run_step_id, conversation_id, agent_version_id,
    harness, status
  )
  on bakery.agent_sessions
  to bakery_app;
