-- Immutable worker-published artifact identities and versions.
create table bakery.artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  artifact_type text not null,
  name text not null,
  current_version_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint artifacts_organization_fk foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint artifacts_task_fk foreign key (organization_id, task_id) references bakery.tasks (organization_id, id) on delete cascade,
  constraint artifacts_identity_unique unique (organization_id, task_id, artifact_type, name),
  constraint artifacts_organization_id_unique unique (organization_id, id)
);

create table bakery.artifact_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  artifact_id uuid not null,
  task_id uuid not null,
  run_step_id uuid,
  author_id uuid not null,
  revision integer not null,
  subject_head_sha text,
  subject_base_sha text,
  step_key text,
  metadata jsonb not null default '{}'::jsonb,
  content bytea not null,
  sha256 text not null,
  size_bytes integer not null,
  media_type text not null,
  lock_permission boolean generated always as (false) stored,
  created_at timestamptz not null default now(),
  constraint artifact_versions_organization_fk foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint artifact_versions_artifact_fk foreign key (organization_id, artifact_id) references bakery.artifacts (organization_id, id) on delete cascade,
  constraint artifact_versions_task_fk foreign key (organization_id, task_id) references bakery.tasks (organization_id, id) on delete cascade,
  constraint artifact_versions_run_step_fk foreign key (organization_id, run_step_id) references bakery.run_steps (organization_id, id) on delete cascade,
  constraint artifact_versions_author_fk foreign key (author_id) references bakery.principals (id) on delete restrict,
  constraint artifact_versions_organization_id_unique unique (organization_id, id),
  constraint artifact_versions_identity_unique unique (organization_id, artifact_id, id),
  constraint artifact_versions_revision_unique unique (artifact_id, revision)
  -- Metadata shape and byte-length consistency are validated by the
  -- application before insertion and again at the read boundary.
);

alter table bakery.artifacts add constraint artifacts_task_identity_unique unique (organization_id, id, task_id);
alter table bakery.artifact_versions add constraint artifact_versions_artifact_task_fk
  foreign key (organization_id, artifact_id, task_id)
  references bakery.artifacts (organization_id, id, task_id) on delete cascade;

alter table bakery.artifacts add constraint artifacts_current_version_fk
  foreign key (organization_id, id, current_version_id)
  references bakery.artifact_versions (organization_id, artifact_id, id)
    on delete set null (current_version_id);

create index artifacts_org_created_idx
  on bakery.artifacts (organization_id, created_at desc, id desc);
create index artifacts_task_created_idx
  on bakery.artifacts (organization_id, task_id, created_at desc, id desc);
create index artifact_versions_artifact_created_idx
  on bakery.artifact_versions (organization_id, artifact_id, created_at desc, id desc);
create index artifact_versions_task_idx on bakery.artifact_versions (organization_id, task_id, id);
create index artifact_versions_run_step_idx on bakery.artifact_versions (organization_id, run_step_id, id);

grant select, insert on bakery.artifact_versions to bakery_app;
grant update (lock_permission) on bakery.artifact_versions to bakery_app;
grant select, insert on bakery.artifacts to bakery_app;
grant update (current_version_id, updated_at, version, revision) on bakery.artifacts to bakery_app;
grant select, insert on bakery.domain_events to bakery_app;
grant select, insert on bakery.outbox to bakery_app;

create table bakery.artifact_publication_replays (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  attempt_id uuid not null,
  worker_host_id uuid not null,
  idempotency_key text not null,
  request_digest text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint artifact_replays_organization_fk foreign key (organization_id) references bakery.organizations (id) on delete cascade,
  constraint artifact_replays_attempt_fk foreign key (organization_id, attempt_id) references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint artifact_replays_host_fk foreign key (organization_id, worker_host_id) references bakery.worker_hosts (organization_id, id) on delete cascade,
  constraint artifact_replays_unique unique (organization_id, attempt_id, worker_host_id, idempotency_key)
);
grant select, insert on bakery.artifact_publication_replays to bakery_app;
