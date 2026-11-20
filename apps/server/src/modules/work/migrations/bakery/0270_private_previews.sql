-- Private previews (issue #19): the app a worker runs for an attempt, shown
-- on a separate preview origin. A preview belongs to one attempt (its id,
-- fence and lease decide whether it may still register or be read as live),
-- not to a workspace: no workspace table exists. Structure only: expiry,
-- one-use consumption, fencing and authority are enforced in TypeScript.
create table bakery.previews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null,
  head_sha text not null,
  route_key text not null,
  upstream_port integer not null,
  status text not null default 'ready',
  stop_reason text,
  stopped_by uuid,
  stopped_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint previews_route_key_unique unique (route_key),
  constraint previews_org_id_unique unique (organization_id, id),
  constraint previews_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete cascade,
  constraint previews_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id)
    on delete cascade
);
create index previews_run_idx
  on bakery.previews (organization_id, run_id, created_at desc, id desc);
create index previews_attempt_idx
  on bakery.previews (organization_id, attempt_id);
create index previews_job_idx
  on bakery.previews (organization_id, job_id, status);

-- One-use grants. The secret is 32 random bytes; only its sha256 is stored.
-- A grant can be exchanged for seconds; the session it opens lasts
-- session_seconds, a separate value chosen by the person who asked.
create table bakery.preview_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  preview_id uuid not null,
  principal_id uuid not null,
  token_hash text not null,
  session_seconds integer not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint preview_grants_token_hash_unique unique (token_hash),
  constraint preview_grants_org_id_unique unique (organization_id, id),
  constraint preview_grants_preview_fk
    foreign key (organization_id, preview_id)
    references bakery.previews (organization_id, id)
    on delete cascade,
  constraint preview_grants_principal_fk
    foreign key (principal_id) references bakery.principals (id)
    on delete cascade
);
create index preview_grants_expiry_idx on bakery.preview_grants (expires_at);
create index preview_grants_preview_idx
  on bakery.preview_grants (organization_id, preview_id);

create table bakery.preview_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  grant_id uuid not null,
  session_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint preview_sessions_hash_unique unique (session_hash),
  constraint preview_sessions_grant_fk
    foreign key (organization_id, grant_id)
    references bakery.preview_grants (organization_id, id)
    on delete cascade
);
create index preview_sessions_expiry_idx on bakery.preview_sessions (expires_at);
create index preview_sessions_grant_idx
  on bakery.preview_sessions (organization_id, grant_id);

grant select, insert on bakery.previews to bakery_app;
grant update (status, stop_reason, stopped_by, stopped_at, expires_at,
  updated_at, version) on bakery.previews to bakery_app;
grant select, insert on bakery.preview_grants to bakery_app;
grant update (consumed_at, revoked_at) on bakery.preview_grants to bakery_app;
grant select, insert on bakery.preview_sessions to bakery_app;
grant update (revoked_at) on bakery.preview_sessions to bakery_app;
grant delete on bakery.preview_grants, bakery.preview_sessions to bakery_app;
