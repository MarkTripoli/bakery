-- GHI-431: a workflow copied somewhere a personal skill does not come with it
-- keeps an open slot for the step that named it: the original skill name and the
-- step, never the skill itself. Publishing refuses while a slot is open; the
-- author resolves it by choosing another skill or removing the step's skill.
create table bakery.workflow_skill_slots (
  id uuid primary key,
  organization_id uuid not null,
  workflow_id uuid not null,
  step_path text not null,
  original_name text not null,
  created_at timestamptz not null default now(),
  constraint workflow_skill_slots_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint workflow_skill_slots_workflow_fk
    foreign key (organization_id, workflow_id)
    references bakery.workflow_definitions (organization_id, id)
    on delete cascade,
  constraint workflow_skill_slots_one_per_step
    unique (organization_id, workflow_id, step_path)
);

revoke all on bakery.workflow_skill_slots from bakery_app;
grant select, insert, delete on bakery.workflow_skill_slots to bakery_app;
