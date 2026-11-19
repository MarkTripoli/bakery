-- Ticket label routing (#31): versioned rules that route one provider label of
-- a ticket source to a repository role, and the per-repository targets an
-- admitted request pins, each run as a child task of a ticket-origin
-- coordination plan.
--
-- ticket_routing_rules is configuration owned by its source. A rule names the
-- provider's stable label id (matched, so a renamed label keeps routing), its
-- display name (shown only), the repository it routes to, the role that
-- repository plays and the preset the target runs. Replacing a source's rules
-- advances ticket_sources.policy_revision in the same transaction (TypeScript),
-- so a client that read the old revision gets 412 on its next admission. A
-- rule's version counts its own edits; an unchanged rule keeps id and version
-- across a replacement. The repository FK has no cascade: an archived or
-- otherwise unusable target stays visible and blocks admission with a reason
-- instead of disappearing.
--
-- ticket_request_targets are the scoped children of one admitted request: one
-- row per routed repository, deduplicated by (request, repository), each pinning
-- the role, the rule and rule version, the source policy revision and the
-- preset it was admitted under. bakery_app may only insert and read them, so a
-- later rule or policy edit cannot retarget an admitted request or rewrite a
-- child it already holds. routing_rule_id is a pinned value, not a foreign
-- key: deleting the rule later leaves every child exactly as admitted.
--
-- Vocabulary (role format, label key bounds, preset ids) and the resolution
-- outcomes live in TypeScript. Structure only: no CHECK, trigger or policy.
create table bakery.ticket_routing_rules (
  id uuid primary key,
  organization_id uuid not null,
  ticket_source_id uuid not null,
  provider_label_id text not null,
  label_name text not null,
  repository_id uuid not null,
  role text not null,
  preset_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint ticket_routing_rules_organization_id_unique
    unique (organization_id, id),
  constraint ticket_routing_rules_label_repository_unique
    unique (organization_id, ticket_source_id, provider_label_id, repository_id),
  constraint ticket_routing_rules_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint ticket_routing_rules_source_fk
    foreign key (organization_id, ticket_source_id)
    references bakery.ticket_sources (organization_id, id) on delete cascade,
  constraint ticket_routing_rules_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete no action
);

-- The rules of one source in their stable listing order; the unique key covers
-- the per-source lookup.
create index ticket_routing_rules_repository_idx
  on bakery.ticket_routing_rules (organization_id, repository_id);

create table bakery.ticket_request_targets (
  id uuid primary key,
  organization_id uuid not null,
  ticket_request_id uuid not null,
  repository_id uuid not null,
  role text not null,
  routing_rule_id uuid,
  routing_rule_version integer,
  source_policy_revision integer not null,
  pinned_preset jsonb not null,
  coordination_plan_id uuid,
  child_task_id uuid,
  created_at timestamptz not null default now(),
  constraint ticket_request_targets_organization_id_unique
    unique (organization_id, id),
  constraint ticket_request_targets_repository_unique
    unique (organization_id, ticket_request_id, repository_id),
  constraint ticket_request_targets_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint ticket_request_targets_request_fk
    foreign key (organization_id, ticket_request_id)
    references bakery.ticket_requests (organization_id, id) on delete cascade,
  constraint ticket_request_targets_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete no action,
  -- The ticket-origin coordination plan and the child task this target runs
  -- as; null for the fallback, which runs on the request's own task.
  constraint ticket_request_targets_plan_fk
    foreign key (organization_id, coordination_plan_id)
    references bakery.coordination_plans (organization_id, id)
    on delete no action,
  constraint ticket_request_targets_child_task_fk
    foreign key (organization_id, child_task_id)
    references bakery.tasks (organization_id, id) on delete no action
);

create index ticket_request_targets_child_task_idx
  on bakery.ticket_request_targets (organization_id, child_task_id)
  where child_task_id is not null;
create index ticket_request_targets_repository_idx
  on bakery.ticket_request_targets (organization_id, repository_id);

grant select, insert, delete on bakery.ticket_routing_rules to bakery_app;
grant update (label_name, role, preset_id, updated_at, version)
  on bakery.ticket_routing_rules to bakery_app;

grant select, insert on bakery.ticket_request_targets to bakery_app;
