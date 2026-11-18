-- Private plugin packages and their immutable versions (#15, B14.01).
--
-- A package is an identity an organization publishes. A version is one build of
-- it: an archive the host can verify, the SDK versions that archive accepts, and
-- the manifest declaring what it wants. Two tables because the invariants are
-- different - a package's name is unique within its publisher, and a version is
-- written once and never changes.
--
-- Neither table stores plugin source. The bundle lives in the object store
-- (`bundle_object_ref`) and only its digest and evidence live here, so Postgres
-- never becomes a script host and no row can be edited into different code
-- without the digest moving.
create table bakery.plugin_packages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  -- Stable identifier a version and an install refer to. Unique per publisher
  -- so two organizations may publish the same name without colliding.
  name text not null,
  display_name text not null,
  license text not null,
  provenance jsonb not null,
  -- private or public. Creation is private; the catalog declares no update
  -- action in this issue, so a row cannot be flipped to public by an omission.
  -- The vocabulary, the non-blank rules and the digest format are validated in
  -- TypeScript (packages/contracts/src/plugin-sdk.ts), not by CHECK
  -- constraints: docs/engineering-rules.md gives PostgreSQL storage structure
  -- and relational integrity only, and keeps domain validation in the app.
  visibility text not null default 'private',
  -- unlisted, listed or withdrawn. Same reasoning as visibility: not settable
  -- from the create input, so it cannot be raised by a caller.
  listing_status text not null default 'unlisted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint plugin_packages_organization_id_unique
    unique (organization_id, id),
  constraint plugin_packages_organization_name_unique
    unique (organization_id, name),
  constraint plugin_packages_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade
);

-- One immutable release of a package.
create table bakery.plugin_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  plugin_package_id uuid not null,
  -- Version label, unique per package. Kept as text rather than parsed
  -- components because the host compares it against sdk_range, not ordering.
  version_name text not null,
  -- Range of plugin SDK versions this release accepts. Checked at version
  -- create and again at install, so an incompatible release cannot be
  -- activated even if it slipped past one of the two.
  sdk_range text not null,
  -- The immutable manifest: UI entry points, server/skill references and the
  -- capabilities this release requests. Bounded at the contract layer
  -- (maxBytes 131072) and stored whole so an install enforces exactly what was
  -- published.
  manifest jsonb not null,
  -- Storage key of the bundle archive in R2 or the filesystem. The archive is
  -- never copied into this row.
  bundle_object_ref text not null,
  -- SHA-256 of the archive at bundle_object_ref. Unique per package: two
  -- versions of one package cannot ship identical bytes under different labels,
  -- which is what makes "the digest identifies the content" true rather than
  -- nominal.
  bundle_digest text not null,
  source_evidence jsonb not null,
  build_evidence jsonb not null,
  -- Set when a version is published; null while a version is still a draft.
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint plugin_versions_organization_id_unique
    unique (organization_id, id),
  constraint plugin_versions_package_version_name_unique
    unique (plugin_package_id, version_name),
  constraint plugin_versions_package_digest_unique
    unique (plugin_package_id, bundle_digest),
  constraint plugin_versions_package_fk
    foreign key (organization_id, plugin_package_id)
    references bakery.plugin_packages (organization_id, id) on delete cascade
);

-- Listing reads lead with the publisher and order by recency, matching the
-- package list's keyset cursor.
create index plugin_packages_scope_idx
  on bakery.plugin_packages (organization_id, updated_at desc, id desc);

-- Version listings are per package and newest-first by publication.
create index plugin_versions_package_idx
  on bakery.plugin_versions (organization_id, plugin_package_id, created_at desc, id desc);

-- The application role publishes and reads. It gets no update or delete on
-- plugin_versions: a published version is immutable, and moving a version is a
-- new row rather than an edit.
grant select, insert, update on bakery.plugin_packages to bakery_app;
grant select, insert on bakery.plugin_versions to bakery_app;
