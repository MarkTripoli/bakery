-- Content collection is an owner-only TypeScript maintenance transaction.
alter table bakery.artifacts
  add column pinned_at timestamptz,
  add column pinned_by uuid references bakery.principals(id) on delete restrict,
  add column row_version integer not null default 1;
alter table bakery.artifact_versions
  alter column content drop not null,
  add column retention_class text not null default 'evidence',
  add column expires_at timestamptz,
  add column purged_at timestamptz,
  add column purge_policy text;
create index artifact_versions_collection_idx
  on bakery.artifact_versions (expires_at, id) where purged_at is null;
grant update (pinned_at, pinned_by, row_version) on bakery.artifacts to bakery_app;
