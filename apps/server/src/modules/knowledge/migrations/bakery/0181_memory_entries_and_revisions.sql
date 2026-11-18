-- Repository-scoped memory and its revision history (#22, B12.06).
--
-- Memory is a projection of accepted evidence, never a source of policy. Two
-- tables carry that: an entry is the stable topic a reader searches for, and a
-- revision is one sourced statement about it. Content never changes in place -
-- a correction is a new revision that supersedes the old one - so the history
-- is the table, not an audit log bolted onto it.
--
-- The entry's current_revision_id is the compare-and-swap pointer. It advances
-- only to a revision that passed promotion, which is why it is nullable: an
-- entry whose first revision was refused stays proposed with no current
-- revision rather than pointing at something unaccepted.
create table bakery.memory_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  repository_id uuid not null,
  topic text not null,
  tags jsonb not null default '[]'::jsonb,
  current_revision_id uuid,
  -- proposed, active or retired. A refused promotion leaves the entry
  -- proposed; it never becomes active by omission.
  status text not null default 'proposed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint memory_entries_organization_id_unique
    unique (organization_id, id),
  constraint memory_entries_topic_not_blank
    check (btrim(topic) <> ''),
  constraint memory_entries_status_known
    check (status in ('proposed', 'active', 'retired')),
  constraint memory_entries_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id) on delete cascade
  -- The current-revision foreign key is added below, after memory_revisions
  -- exists: the two tables point at each other, so the cycle cannot be
  -- declared inline in either direction.
);

-- One versioned, sourced statement about a memory entry.
create table bakery.memory_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  memory_id uuid not null,
  revision integer not null,
  body text not null,
  reason text,
  -- The exact artifact version whose evidence justifies this statement. Not
  -- nullable: a revision with no evidence is not a memory, it is an opinion,
  -- and the promotion path refuses it before it is stored.
  source_artifact_version_id uuid not null,
  supersedes_id uuid,
  -- Model judgment, not factual proof (17-context-and-handoffs.md). Bounded so
  -- a caller cannot store a value outside the probability it claims to be.
  confidence numeric not null,
  expires_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint memory_revisions_organization_id_unique
    unique (organization_id, id),
  constraint memory_revisions_memory_revision_unique
    unique (memory_id, revision),
  constraint memory_revisions_revision_positive
    check (revision > 0),
  constraint memory_revisions_body_not_blank
    check (btrim(body) <> ''),
  constraint memory_revisions_confidence_range
    check (confidence >= 0 and confidence <= 1),
  constraint memory_revisions_memory_fk
    foreign key (organization_id, memory_id)
    references bakery.memory_entries (organization_id, id) on delete cascade,
  constraint memory_revisions_source_fk
    foreign key (organization_id, source_artifact_version_id)
    references bakery.artifact_versions (organization_id, id)
    on delete restrict,
  -- A superseded revision must be one of this entry's own revisions; a chain
  -- that jumps to another entry's history would make the history unreadable.
  constraint memory_revisions_supersedes_fk
    foreign key (organization_id, supersedes_id)
    references bakery.memory_revisions (organization_id, id)
    on delete restrict,
  constraint memory_revisions_author_fk
    foreign key (created_by) references bakery.principals (id)
    on delete restrict
);

-- The entry's current revision must belong to that same entry. Added after
-- both tables exist because the reference is circular - memory_revisions names
-- its memory, and the memory names its current revision. Deferred so a revision
-- and the pointer that names it can be written in one transaction in either
-- order, while a pointer to another entry's revision still fails at commit.
alter table bakery.memory_entries
  add constraint memory_entries_current_revision_fk
  foreign key (organization_id, current_revision_id)
  references bakery.memory_revisions (organization_id, id)
  deferrable initially deferred;

-- Search is repository-scoped by design: there is no global cross-repository
-- retrieval, so every read index leads with organization and repository.
create index memory_entries_scope_idx
  on bakery.memory_entries (organization_id, repository_id, status, updated_at desc, id desc);

create index memory_entries_topic_idx
  on bakery.memory_entries (organization_id, repository_id, topic);

create index memory_revisions_history_idx
  on bakery.memory_revisions (organization_id, memory_id, revision desc);

-- A revision that has been superseded is still readable history, so the
-- supersedes pointer is indexed for the "what replaced this" walk.
create index memory_revisions_supersedes_idx
  on bakery.memory_revisions (organization_id, supersedes_id)
  where supersedes_id is not null;
