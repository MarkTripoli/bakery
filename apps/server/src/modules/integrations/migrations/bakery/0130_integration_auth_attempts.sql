-- Organization-owned, single-use provider authorization attempts (issue #479).
-- Only the SHA-256 hash of the state is stored. The PKCE verifier is AES-GCM
-- ciphertext bound to organization, attempt, state hash and key id
-- (secrets/crypto.ts). idempotency_key_hash lets a same-key retry rotate the
-- state and verifier on the same row, so no replayable response is stored.
-- reconnect_connection_id and result_connection_id gain their composite
-- foreign keys when organization connections exist. Structure only: the
-- pending/exchanging/completed/failed lifecycle and single-use claims are
-- enforced in TypeScript.
create table bakery.integration_auth_attempts (
  id uuid primary key,
  organization_id uuid not null,
  initiating_principal_id uuid not null,
  session_id text not null,
  provider text not null,
  reconnect_connection_id uuid,
  return_path text,
  state_hash text not null,
  pkce_verifier_ciphertext bytea not null,
  pkce_verifier_nonce bytea not null,
  pkce_key_id text not null,
  idempotency_key_hash text not null,
  request_digest text not null,
  expires_at timestamptz not null,
  status text not null,
  result_connection_id uuid,
  failure_code text,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint integration_auth_attempts_state_hash_unique unique (state_hash),
  constraint integration_auth_attempts_organization_id_unique
    unique (organization_id, id),
  constraint integration_auth_attempts_idempotency_unique
    unique (organization_id, initiating_principal_id, idempotency_key_hash),
  constraint integration_auth_attempts_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  -- Removing a member removes the attempts they started.
  constraint integration_auth_attempts_membership_fk
    foreign key (organization_id, initiating_principal_id)
    references bakery.organization_memberships (organization_id, principal_id)
    on delete cascade
);

grant select, insert on bakery.integration_auth_attempts to bakery_app;
grant update (state_hash, pkce_verifier_ciphertext, pkce_verifier_nonce,
  pkce_key_id, status, result_connection_id, failure_code, consumed_at,
  updated_at, version)
  on bakery.integration_auth_attempts to bakery_app;
