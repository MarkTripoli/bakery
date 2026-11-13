-- Single-use Sign in with Slack attempts (issue #12). An attempt binds one round
-- trip to the Bakery member and browser session that began it, to the Slack app
-- and workspace (and Enterprise Grid organization, if any) being linked, and to
-- a state and a nonce. Only the SHA-256 hash of the state is stored. The nonce
-- is AES-GCM ciphertext bound to organization, attempt, state hash and key id
-- (secrets/crypto.ts), so it cannot be read as a PKCE verifier or the reverse.
-- Structure only: the pending/exchanging/completed/failed lifecycle, the expiry
-- and the single-use claim are enforced in TypeScript. The application role may
-- insert and select, and may change only the lifecycle columns; everything an
-- attempt was bound to is immutable to it, and it cannot delete.
create table bakery.slack_identity_attempts (
  id uuid primary key,
  organization_id uuid not null,
  initiating_principal_id uuid not null,
  session_id text not null,
  state_hash text not null,
  nonce_ciphertext bytea not null,
  nonce_iv bytea not null,
  nonce_key_id text not null,
  app_id text not null,
  client_id text not null,
  team_id text not null,
  enterprise_id text,
  expires_at timestamptz not null,
  status text not null,
  failure_code text,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint slack_identity_attempts_state_hash_unique unique (state_hash),
  constraint slack_identity_attempts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  -- Removing a member removes the attempts they started.
  constraint slack_identity_attempts_membership_fk
    foreign key (organization_id, initiating_principal_id)
    references bakery.organization_memberships (organization_id, principal_id)
    on delete cascade
);

-- A member starting again for the same workspace supersedes their pending one.
create index slack_identity_attempts_pending_idx
  on bakery.slack_identity_attempts
  (organization_id, initiating_principal_id, app_id, team_id)
  where status = 'pending';

grant select, insert on bakery.slack_identity_attempts to bakery_app;
grant update (status, failure_code, consumed_at, updated_at, version)
  on bakery.slack_identity_attempts to bakery_app;
