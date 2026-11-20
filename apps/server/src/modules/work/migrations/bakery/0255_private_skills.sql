-- GHI-431: a skill has an owner and a scope, and a person can let one shared
-- workflow use a personal skill.
--
-- scope is global (comes with Bakery, shown as Shared by Bakery), organization
-- or personal (belongs to one person, shown as Private). Every existing skill
-- stays an organization skill. The vocabulary and the rule that a personal skill
-- has exactly one owner are validated in TypeScript at the writer. Scope and
-- owner are immutable after insert: bakery_app's update on bakery.skills is
-- column-scoped (0055) and names neither column, and this migration adds none.
alter table bakery.skills
  add column scope text not null default 'organization',
  add column owner_principal_id uuid,
  add constraint skills_owner_principal_fk
    foreign key (owner_principal_id) references bakery.principals (id)
    on delete restrict;

-- A personal slug is unique per owner, so creating one never reveals that
-- somebody else holds the same slug privately.
alter table bakery.skills drop constraint skills_slug_unique;
create unique index skills_shared_slug_unique
  on bakery.skills (organization_id, slug)
  where scope <> 'personal';
create unique index skills_personal_slug_unique
  on bakery.skills (organization_id, owner_principal_id, slug)
  where scope = 'personal';

-- One row is one use grant: the owner of a personal skill let the workflow use
-- this exact version at this step. step_path is the JSON Pointer of the step in
-- the authored definition. A grant lives until the owner stops it; stopping
-- deletes the row and the audit log keeps the grant and the stop.
create table bakery.skill_use_grants (
  id uuid primary key,
  organization_id uuid not null,
  skill_id uuid not null,
  skill_version_id uuid not null,
  workflow_id uuid not null,
  step_path text not null,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint skill_use_grants_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint skill_use_grants_skill_fk
    foreign key (organization_id, skill_id)
    references bakery.skills (organization_id, id) on delete restrict,
  constraint skill_use_grants_version_fk
    foreign key (organization_id, skill_version_id)
    references bakery.skill_versions (organization_id, id) on delete restrict,
  constraint skill_use_grants_workflow_fk
    foreign key (organization_id, workflow_id)
    references bakery.workflow_definitions (organization_id, id)
    on delete cascade,
  constraint skill_use_grants_granted_by_fk
    foreign key (granted_by) references bakery.principals (id)
    on delete restrict,
  constraint skill_use_grants_organization_id_unique
    unique (organization_id, id),
  constraint skill_use_grants_one_per_step
    unique (organization_id, workflow_id, skill_version_id, step_path)
);
create index skill_use_grants_skill_created_idx
  on bakery.skill_use_grants (organization_id, skill_id, created_at desc, id desc);

revoke all on bakery.skill_use_grants from bakery_app;
grant select, insert, delete on bakery.skill_use_grants to bakery_app;
