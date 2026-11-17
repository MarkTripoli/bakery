-- The credential an agent inside a session presents to call Bakery's own
-- operations (chapter 25 §18.1; O50).
--
-- Only the digest is stored. The token itself is handed to the session once and
-- never persisted, so a reader of this table cannot reconstruct a usable
-- credential — the same rule the worker_hosts credential follows.
--
-- The row is a record of what was granted, not a second source of authority:
-- liveness is always re-checked against the attempt, so a row outliving its
-- lease confers nothing. It exists so a presented token can be resolved to a
-- claim at all, and so an audit can say which credential made a call.
create table bakery.session_operation_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  attempt_id uuid not null,
  -- The principal the agent acts for, which is the audit's subject (O50). It is
  -- not the host's principal: an agent acting for a person is that person's
  -- action, labelled as an agent's.
  acts_for_principal_id uuid not null,
  worker_session_id uuid not null,
  worker_session_generation bigint not null,
  fence bigint not null,
  token_hash text not null,
  scopes text[] not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint session_operation_credentials_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint session_operation_credentials_attempt_fk
    foreign key (attempt_id) references bakery.job_attempts (id)
    on delete cascade,
  constraint session_operation_credentials_principal_fk
    foreign key (acts_for_principal_id) references bakery.principals (id)
    on delete restrict,
  constraint session_operation_credentials_org_id_unique
    unique (organization_id, id),
  -- One live credential per digest. A digest collision across organizations is
  -- already impossible for an honest 256-bit token, but scoping the index by
  -- organization keeps the tenancy structural rather than probabilistic.
  constraint session_operation_credentials_org_token_unique
    unique (organization_id, token_hash)
);

-- Resolution is by digest alone, because the caller presents a token before
-- naming anything else. Organizations are not in the predicate, so the index
-- leads with the digest.
create unique index session_operation_credentials_token_idx
  on bakery.session_operation_credentials (token_hash);

-- An attempt's credentials die with it, so a sweep can find them by attempt.
create index session_operation_credentials_attempt_idx
  on bakery.session_operation_credentials (organization_id, attempt_id);

-- Every call an agent makes with one of these is recorded with both identities:
-- the principal it acted for and the session that made the call.
create table bakery.session_operation_audits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  credential_id uuid not null,
  attempt_id uuid not null,
  acts_for_principal_id uuid not null,
  worker_session_id uuid not null,
  operation text not null,
  scope text not null,
  outcome text not null,
  recorded_at timestamptz not null default now(),
  constraint session_operation_audits_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint session_operation_audits_credential_fk
    foreign key (credential_id) references bakery.session_operation_credentials (id)
    on delete cascade,
  constraint session_operation_audits_principal_fk
    foreign key (acts_for_principal_id) references bakery.principals (id)
    on delete restrict
);

-- The audit is read by attempt and by principal, most recent first.
create index session_operation_audits_attempt_idx
  on bakery.session_operation_audits (organization_id, attempt_id, recorded_at);
create index session_operation_audits_principal_idx
  on bakery.session_operation_audits (organization_id, acts_for_principal_id, recorded_at);

-- A credential is issued, resolved and revoked; it is never deleted, so a
-- revoked row still explains a past call. The audit is append-only: no update
-- and no delete, because a record that can be edited is not a record.
grant select, insert, update on bakery.session_operation_credentials to bakery_app;
grant select, insert on bakery.session_operation_audits to bakery_app;
