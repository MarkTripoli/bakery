-- Bakery-owned revocation epoch for connected OAuth clients. Revoking a
-- connected client deletes the consent and tokens, but a signed access token
-- cannot be un-issued, so the MCP guard also refuses any token issued at or
-- before the latest `revoked_at` for its (person, client, organization). A
-- later re-consent therefore never revives a token minted before the revoke.
-- Identifiers are plain values: the provider owns the OAuth tables and the
-- client may be deleted independently of this history.
create table bakery.oauth_grant_revocations (
  user_id uuid not null,
  client_id text not null,
  organization_id uuid not null,
  revoked_at timestamptz not null,
  primary key (user_id, client_id, organization_id)
);

grant select, insert, update on bakery.oauth_grant_revocations to bakery_app;
