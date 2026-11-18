-- Project scope profiles (issue #433, one-engine §15.1, O23 and O32): the step
-- defaults a run inherits come from a scope profile at project level, of which
-- a repository profile is the code form. One row per project (application)
-- holds the published profile; no row is the empty baseline at revision 0.
--
-- `revision` is the published revision and the If-Match precondition: a save
-- writes the next revision only when the caller names the current one.
-- `digest` is the SHA-256 of the canonical content, so a run pins exactly the
-- defaults it was admitted with. `check_commands` and `rules` are JSON arrays
-- whose shape the described contract validates in TypeScript.
--
-- Structure only: validation, authorization and the compare-and-swap rule are
-- enforced in TypeScript. No CHECK constraints, triggers or row-level security.
create table bakery.project_scope_profiles (
  organization_id uuid not null,
  application_id uuid not null,
  revision integer not null,
  digest text not null,
  check_commands jsonb not null,
  rules jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  primary key (organization_id, application_id),
  constraint project_scope_profiles_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id) on delete cascade,
  constraint project_scope_profiles_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
);

grant select, insert, update (revision, digest, check_commands, rules,
  updated_at, updated_by)
  on bakery.project_scope_profiles to bakery_app;
