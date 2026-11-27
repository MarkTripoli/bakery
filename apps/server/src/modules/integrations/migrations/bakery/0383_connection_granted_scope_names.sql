alter table bakery.integration_connections
  add column granted_scope_names text[];

grant update (granted_scope_names)
  on bakery.integration_connections to bakery_app;
