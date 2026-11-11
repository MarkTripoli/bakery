-- Last time a connected OAuth client successfully called the MCP resource for
-- one (person, client, organization) grant. The guard refreshes it at most
-- once a minute per grant, so reading the connected-clients list shows
-- "last used" without a write on every call.
create table bakery.oauth_grant_activity (
  user_id uuid not null,
  client_id text not null,
  organization_id uuid not null,
  last_used_at timestamptz not null,
  primary key (user_id, client_id, organization_id)
);

grant select, insert, update, delete on bakery.oauth_grant_activity to bakery_app;
