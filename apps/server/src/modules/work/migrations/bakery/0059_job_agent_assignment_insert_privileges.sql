-- GHI-299 permits job producers to persist frozen agent assignments while
-- preserving column-level INSERT restrictions on billing and reservations.
grant insert (agent_version_id, agent_config, skill_refs)
  on bakery.jobs
  to bakery_app;
