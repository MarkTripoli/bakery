-- Version-pinned roots and flat replies retain their original evidence.
create table bakery.artifact_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  artifact_version_id uuid not null,
  parent_comment_id uuid,
  author_id uuid not null references bakery.principals(id),
  body text not null,
  anchor jsonb,
  status text,
  resolved_by uuid references bakery.principals(id),
  resolved_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid references bakery.principals(id),
  row_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, artifact_version_id, id),
  constraint artifact_comments_organization_id_artifact_version_id_fkey
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions(organization_id, id),
  foreign key (organization_id, artifact_version_id, parent_comment_id)
    references bakery.artifact_comments(organization_id, artifact_version_id, id)
);
create index artifact_comments_page_idx on bakery.artifact_comments
  (organization_id, artifact_version_id, parent_comment_id, created_at, id);
create index artifact_comments_unresolved_idx on bakery.artifact_comments
  (artifact_version_id) where parent_comment_id is null and status = 'open' and deleted_at is null;
grant select, insert on bakery.artifact_comments to bakery_app;
grant update (body, status, resolved_by, resolved_at, deleted_at, deleted_by, row_version, updated_at)
  on bakery.artifact_comments to bakery_app;
