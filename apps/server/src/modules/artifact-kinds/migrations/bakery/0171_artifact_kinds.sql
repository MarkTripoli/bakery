-- Artifact kinds: what a document of a given kind must contain and which facts
-- the engine may read from it (chapter 25 §4 E2, §6 O6; slice 11 "the kind
-- definition API for organizations, rule types, facts and validation at
-- publication").
--
-- A kind identity is stable and an organization's kinds are unique by key, so a
-- workflow author who writes `kind: brief` names exactly one thing. A version is
-- immutable: it is published once and never updated or deleted, so a run that
-- pinned it reads the same rules a year later.
--
-- There is deliberately no column holding code, a script or a URL. A kind
-- composes platform rule types by name with bounded options; that is the whole
-- content of the "no validator code" guarantee (O6), and a schema that cannot
-- express a validator is a stronger guarantee than one that refuses them.
create table bakery.artifact_kinds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  key text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint artifact_kinds_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint artifact_kinds_created_by_fk
    foreign key (created_by) references bakery.principals (id),
  -- One live kind per key per organization. Two kinds both called brief would
  -- make `kind: brief` ambiguous for every author and every template.
  constraint artifact_kinds_org_key_unique unique (organization_id, key),
  constraint artifact_kinds_organization_id_unique unique (organization_id, id)
);

-- Immutable published versions of a kind. Insert only: bakery_app gets no
-- update or delete privilege, and publication serializes per kind so two
-- publishers cannot both claim revision n.
create table bakery.artifact_kind_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  kind_id uuid not null,
  revision integer not null,
  definition jsonb not null,
  digest text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint artifact_kind_versions_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint artifact_kind_versions_kind_fk
    foreign key (organization_id, kind_id)
    references bakery.artifact_kinds (organization_id, id)
    on delete cascade,
  constraint artifact_kind_versions_created_by_fk
    foreign key (created_by) references bakery.principals (id),
  constraint artifact_kind_versions_revision_unique
    unique (organization_id, kind_id, revision),
  constraint artifact_kind_versions_organization_id_unique
    unique (organization_id, id)
);

-- Publication reads the newest revision of one kind, so the index carries the
-- organization and kind first and the revision descending: the lookup is a
-- single row, not a scan of the organization's whole kind history.
create index artifact_kind_versions_latest_idx
  on bakery.artifact_kind_versions (organization_id, kind_id, revision desc);

-- Listing an organization's kinds is keyset by (created_at, id).
create index artifact_kinds_org_created_idx
  on bakery.artifact_kinds (organization_id, created_at, id);

-- Insert and read only. A kind version that could be updated would make a
-- pinned revision stop meaning what it meant, which is the one property the
-- whole versioning scheme exists to provide.
grant select, insert on bakery.artifact_kinds to bakery_app;
grant select, insert on bakery.artifact_kind_versions to bakery_app;