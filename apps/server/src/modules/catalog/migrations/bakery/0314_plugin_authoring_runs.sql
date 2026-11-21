-- Authoring runs for prompt-to-private-plugin backend authoring (#45, B14.04).
--
-- A person describes a backend plugin and authorizes the capabilities it may
-- hold; a generator writes the package, the host checks it, and only a package
-- that passes every check is published as a private version and installed for
-- that person. A run records what it was given (the request, the authorized
-- capabilities, the budget, the kit digest, the SDK and the model) and every
-- attempt it made, with the diagnostics each one was refused for, so a version
-- can be traced to the exact instructions and checks that produced it.
--
-- Plain tables written by the one runner in short transactions: generation,
-- the typecheck and the preview hold no transaction. A run records the phase it
-- is in and the version and install it has published but not yet previewed, so
-- a run a crash left behind can be settled truthfully later.
-- The boundary rail forbids CHECK constraints and triggers in new migrations;
-- the runner validates statuses and bounds.

create table bakery.plugin_authoring_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  actor_principal_id uuid not null,
  status text not null,
  request_text text not null,
  request_digest text not null,
  authorized_capabilities jsonb not null,
  budget_usd numeric(14, 6) not null,
  spent_usd numeric(14, 6) not null default 0,
  max_attempts integer not null,
  kit_digest text not null,
  sdk_version text not null,
  model_id text not null,
  base_plugin_install_id uuid,
  plugin_package_id uuid,
  plugin_version_id uuid,
  plugin_install_id uuid,
  failure jsonb,
  phase text not null default 'generating',
  pending_plugin_version_id uuid,
  pending_plugin_install_id uuid,
  pending_first_install boolean,
  pending_state_digest text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint plugin_authoring_runs_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint plugin_authoring_runs_actor_fk
    foreign key (actor_principal_id)
    references bakery.principals (id) on delete cascade,
  constraint plugin_authoring_runs_package_fk
    foreign key (organization_id, plugin_package_id)
    references bakery.plugin_packages (organization_id, id)
    on delete set null (plugin_package_id),
  constraint plugin_authoring_runs_version_fk
    foreign key (organization_id, plugin_version_id)
    references bakery.plugin_versions (organization_id, id)
    on delete set null (plugin_version_id),
  constraint plugin_authoring_runs_install_fk
    foreign key (organization_id, plugin_install_id)
    references bakery.plugin_installs (organization_id, id)
    on delete set null (plugin_install_id),
  constraint plugin_authoring_runs_base_install_fk
    foreign key (organization_id, base_plugin_install_id)
    references bakery.plugin_installs (organization_id, id)
    on delete set null (base_plugin_install_id),
  constraint plugin_authoring_runs_organization_id_unique
    unique (organization_id, id)
);

create index plugin_authoring_runs_actor_idx
  on bakery.plugin_authoring_runs (organization_id, actor_principal_id, created_at desc);

create table bakery.plugin_authoring_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plugin_authoring_run_id uuid not null,
  attempt_number integer not null,
  outcome text not null,
  files_digest text,
  check_report jsonb,
  diagnostics jsonb not null,
  cost_usd numeric(14, 6) not null,
  plugin_version_id uuid,
  preview_result jsonb,
  created_at timestamptz not null default now(),
  constraint plugin_authoring_attempts_run_fk
    foreign key (organization_id, plugin_authoring_run_id)
    references bakery.plugin_authoring_runs (organization_id, id)
    on delete cascade,
  constraint plugin_authoring_attempts_version_fk
    foreign key (organization_id, plugin_version_id)
    references bakery.plugin_versions (organization_id, id)
    on delete set null (plugin_version_id),
  constraint plugin_authoring_attempts_number_unique
    unique (organization_id, plugin_authoring_run_id, attempt_number)
);

create table bakery.plugin_authoring_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plugin_authoring_run_id uuid not null,
  kind text not null,
  detail jsonb not null,
  created_at timestamptz not null default now(),
  constraint plugin_authoring_events_run_fk
    foreign key (organization_id, plugin_authoring_run_id)
    references bakery.plugin_authoring_runs (organization_id, id)
    on delete cascade
);

create index plugin_authoring_events_run_idx
  on bakery.plugin_authoring_events (organization_id, plugin_authoring_run_id);

grant select, insert, update on bakery.plugin_authoring_runs to bakery_app;
grant select, insert, update on bakery.plugin_authoring_attempts to bakery_app;
grant select, insert on bakery.plugin_authoring_events to bakery_app;
