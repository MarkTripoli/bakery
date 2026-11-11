-- GitHub setup and OAuth callbacks on auth attempts (issue #481). The setup
-- redirect records its installation hint once (setup_received_at). The OAuth
-- callback exchanges the code, lists the installations the user token can
-- access and keeps only their ids (verified_installation_ids, cleared on
-- completion); the user token itself is never stored. exchanged_at marks
-- that the listing finished. Also adds the composite foreign keys 0130
-- deferred until organization connections existed. Structure only.
alter table bakery.integration_auth_attempts
  add column setup_installation_id text,
  add column setup_received_at timestamptz,
  add column exchanged_at timestamptz,
  add column verified_installation_ids jsonb,
  add constraint integration_auth_attempts_reconnect_connection_fk
    foreign key (organization_id, reconnect_connection_id)
    references bakery.integration_connections (organization_id, id),
  add constraint integration_auth_attempts_result_connection_fk
    foreign key (organization_id, result_connection_id)
    references bakery.integration_connections (organization_id, id);

grant update (setup_installation_id, setup_received_at, exchanged_at,
  verified_installation_ids)
  on bakery.integration_auth_attempts to bakery_app;
