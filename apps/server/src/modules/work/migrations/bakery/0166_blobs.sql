-- Blobs a run or a person uploaded, stored once per organization under their
-- SHA-256 (chapter 25 §17.1, §17.5; O43). The row is the server's record of a
-- blob it has verified: the object itself lives in the configured store under
-- organizations/{organization}/blobs/sha256/{sha256}, so this table carries the
-- size and media type a reader needs before it fetches bytes, and a reference
-- count that says whether collection may remove the object.
--
-- Deduplication is within one organization and never across (O43): the unique
-- key starts with organization_id, so the same bytes uploaded by two
-- organizations are two rows and two objects.
create table bakery.blobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  sha256 text not null,
  size_bytes bigint not null,
  media_type text not null,
  created_by_id uuid not null,
  created_at timestamptz not null default now(),
  constraint blobs_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint blobs_creator_fk
    foreign key (created_by_id) references bakery.principals (id)
    on delete restrict,
  constraint blobs_org_id_unique unique (organization_id, id),
  -- One object per organization per digest: a second upload of the same bytes
  -- is the same blob, not a second row.
  constraint blobs_org_digest_unique unique (organization_id, sha256)
);

-- Listing a repository's blobs is keyset by (created_at, id), so the index
-- carries the same columns in the same order.
create index blobs_org_created_idx
  on bakery.blobs (organization_id, created_at, id);

-- A resumable upload in progress (chapter 25 §17.5). The session names the
-- digest and size the client promises up front, so the server can refuse a
-- completion whose assembled bytes are not what was declared rather than
-- discovering it after charging usage.
--
-- state is validated by the server, not the database, and only ever moves
-- forward: pending -> completed, or pending -> abandoned by expiry.
create table bakery.blob_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  created_by_id uuid not null,
  sha256 text not null,
  size_bytes bigint not null,
  media_type text not null,
  state text not null default 'pending',
  expires_at timestamptz not null,
  completed_blob_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blob_upload_sessions_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint blob_upload_sessions_creator_fk
    foreign key (created_by_id) references bakery.principals (id)
    on delete restrict,
  constraint blob_upload_sessions_blob_fk
    foreign key (organization_id, completed_blob_id)
    references bakery.blobs (organization_id, id) on delete set null,
  constraint blob_upload_sessions_org_id_unique unique (organization_id, id)
);

-- Parts of a resumable upload. A part is identified by its ordinal, so a
-- retried part replaces rather than appends: the unique key is what makes
-- resuming idempotent instead of additive.
create table bakery.blob_upload_parts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  session_id uuid not null,
  part_number integer not null,
  sha256 text not null,
  size_bytes bigint not null,
  content bytea not null,
  created_at timestamptz not null default now(),
  constraint blob_upload_parts_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade,
  constraint blob_upload_parts_session_fk
    foreign key (organization_id, session_id)
    references bakery.blob_upload_sessions (organization_id, id)
    on delete cascade,
  constraint blob_upload_parts_session_part_unique
    unique (organization_id, session_id, part_number)
);

create index blob_upload_parts_session_idx
  on bakery.blob_upload_parts (organization_id, session_id, part_number);

-- The application role may create uploads and read them back; it may not
-- delete a completed session or a blob, because collection owns removal.
grant select, insert, update on bakery.blobs to bakery_app;
grant select, insert, update on bakery.blob_upload_sessions to bakery_app;
grant select, insert, update, delete on bakery.blob_upload_parts to bakery_app;