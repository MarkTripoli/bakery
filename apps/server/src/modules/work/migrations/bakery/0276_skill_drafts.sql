-- GHI-74: a skill has one authoring draft: files an author edits and checks
-- before publishing a version. It is separate from published versions, which
-- stay immutable, and from workflows, which keep pinning the versions they have.
-- One draft per skill; "someone else changed this draft" is the version guard.
-- A draft starts from the skill's active version (base_version_id, null for an
-- empty one) and keeps that version's non-file manifest fields so a published
-- draft carries them on. File contents are held in the row: a draft is small
-- (10 MiB and 256 files, as an upload) and mutable, unlike a published object.
create table bakery.skill_drafts (
  id uuid primary key,
  organization_id uuid not null,
  skill_id uuid not null,
  base_version_id uuid,
  entry_path text not null default 'SKILL.md',
  license text,
  manifest_extra jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint skill_drafts_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint skill_drafts_skill_fk
    foreign key (organization_id, skill_id)
    references bakery.skills (organization_id, id) on delete restrict,
  constraint skill_drafts_base_version_fk
    foreign key (organization_id, base_version_id, skill_id)
    references bakery.skill_versions (organization_id, id, skill_id)
    on delete restrict,
  constraint skill_drafts_created_by_fk
    foreign key (created_by) references bakery.principals (id)
    on delete restrict,
  constraint skill_drafts_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
    on delete restrict,
  constraint skill_drafts_organization_id_unique unique (organization_id, id),
  constraint skill_drafts_one_per_skill unique (organization_id, skill_id)
);

create table bakery.skill_draft_files (
  id uuid primary key,
  organization_id uuid not null,
  draft_id uuid not null,
  path text not null,
  media_type text not null,
  is_executable boolean not null default false,
  content bytea not null,
  size_bytes integer not null,
  sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint skill_draft_files_draft_fk
    foreign key (organization_id, draft_id)
    references bakery.skill_drafts (organization_id, id) on delete cascade,
  constraint skill_draft_files_path_unique unique (draft_id, path)
);
create index skill_draft_files_draft_idx
  on bakery.skill_draft_files (organization_id, draft_id, path);

revoke all on bakery.skill_drafts, bakery.skill_draft_files from bakery_app;
grant select, insert, delete on bakery.skill_drafts, bakery.skill_draft_files
  to bakery_app;
grant update (entry_path, license, manifest_extra, updated_by, updated_at,
  version) on bakery.skill_drafts to bakery_app;
grant update (media_type, is_executable, content, size_bytes, sha256,
  updated_at) on bakery.skill_draft_files to bakery_app;
