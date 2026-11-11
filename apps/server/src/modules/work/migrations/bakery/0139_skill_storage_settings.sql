-- Installation skill object storage (issue #49): the administrator configures
-- the R2 account, bucket and credentials in the product UI. The credential
-- pair is one AES-GCM payload in bakery.secrets / bakery.secret_versions with
-- organization_id and application_id null; this single-row table holds only
-- the non-secret settings and the secret id. `backend` names the active
-- adapter (filesystem or r2); only the paused copy, verify and switch procedure
-- writes it, as the database owner: bakery_app holds no UPDATE on backend.
-- `endpoint_override` is a loopback fixture endpoint honoured only when
-- BAKERY_ENV is test; the application never writes it.
-- `version` is the If-Match precondition and the resolver's cache key.
-- Structure only: validation, authorization and the singleton rule are
-- enforced in TypeScript.
create table bakery.skill_storage_settings (
  id text primary key,
  backend text not null default 'filesystem',
  account_id text,
  bucket text,
  secret_id uuid,
  endpoint_override text,
  credential_updated_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint skill_storage_settings_secret_fk
    foreign key (secret_id) references bakery.secrets (id),
  constraint skill_storage_settings_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
);

-- INSERT is column-scoped as well: the application cannot create the first row
-- with a chosen backend or endpoint_override. backend takes its default
-- ('filesystem'); both columns are written only by the owner role.
grant select on bakery.skill_storage_settings to bakery_app;
grant insert (id, account_id, bucket, secret_id, credential_updated_at,
  version, created_at, updated_at, updated_by)
  on bakery.skill_storage_settings to bakery_app;
grant update (account_id, bucket, secret_id, credential_updated_at,
  version, updated_at, updated_by)
  on bakery.skill_storage_settings to bakery_app;
