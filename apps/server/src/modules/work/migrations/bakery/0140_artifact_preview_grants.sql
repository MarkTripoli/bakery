-- Artifact previews (issue #144): one-use 30 second handoff grants and the
-- short-lived sessions they exchange for, on a separate preview origin. Only
-- sha256 hashes of the grant and the session cookie are stored; neither secret
-- is ever persisted in clear. Artifact-scoped siblings of preview_grants
-- (docs/technical-design/01-data-model.md). Structure only: expiry, one-use
-- consumption and authority are enforced in TypeScript.
create table bakery.artifact_preview_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  artifact_id uuid not null,
  artifact_version_id uuid not null,
  principal_id uuid not null,
  token_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint artifact_preview_grants_token_hash_unique unique (token_hash),
  constraint artifact_preview_grants_org_id_unique
    unique (organization_id, id),
  constraint artifact_preview_grants_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id)
    on delete cascade,
  constraint artifact_preview_grants_artifact_fk
    foreign key (organization_id, artifact_id)
    references bakery.artifacts (organization_id, id)
    on delete cascade,
  constraint artifact_preview_grants_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id)
    on delete cascade,
  constraint artifact_preview_grants_principal_fk
    foreign key (principal_id) references bakery.principals (id)
    on delete cascade
);
create index artifact_preview_grants_expiry_idx
  on bakery.artifact_preview_grants (expires_at);
create index artifact_preview_grants_version_idx
  on bakery.artifact_preview_grants (organization_id, artifact_version_id);

create table bakery.artifact_preview_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  grant_id uuid not null,
  session_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint artifact_preview_sessions_hash_unique unique (session_hash),
  constraint artifact_preview_sessions_grant_fk
    foreign key (organization_id, grant_id)
    references bakery.artifact_preview_grants (organization_id, id)
    on delete cascade
);
create index artifact_preview_sessions_expiry_idx
  on bakery.artifact_preview_sessions (expires_at);
create index artifact_preview_sessions_grant_idx
  on bakery.artifact_preview_sessions (organization_id, grant_id);

grant select, insert on bakery.artifact_preview_grants to bakery_app;
grant update (consumed_at, revoked_at) on bakery.artifact_preview_grants
  to bakery_app;
grant select, insert on bakery.artifact_preview_sessions to bakery_app;
grant update (revoked_at) on bakery.artifact_preview_sessions to bakery_app;
-- The execution coordinator sweeps rows past expiry plus a grace period.
grant delete on bakery.artifact_preview_grants, bakery.artifact_preview_sessions
  to bakery_app;
