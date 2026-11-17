-- An artifact version may name a blob instead of carrying its bytes
-- (chapter 25 §17.1: a version is digest, size, media type and a pointer; the
-- bytes live once per organization under their SHA-256).
--
-- Both columns are nullable and at most one is set. A version with neither is
-- legitimate: retention collection purges a version by clearing its bytes, so
-- "no home" is what a purged version looks like.
--
-- Existing rows keep their bytes in `content` and are not touched. A backfill
-- is a separate, reversible job: doing it in the same migration would make this
-- one unrecoverable, because a failed backfill would leave the schema change
-- and the data change in one transaction that cannot be rolled back
-- independently.
alter table bakery.artifact_versions
  alter column content drop not null,
  add column blob_id uuid;

alter table bakery.artifact_versions
  add constraint artifact_versions_blob_fk
    foreign key (organization_id, blob_id)
    references bakery.blobs (organization_id, id)
    on delete restrict;

-- No CHECK constraint here, deliberately. The PostgreSQL boundary rail refuses
-- CHECK constraints in new migrations: the database holds structure, the server
-- holds rules, and a rule expressed as a constraint is a rule nobody can name
-- in an error. "At most one home for the bytes" is therefore enforced by the
-- write path, which sets exactly one of the two columns by construction, and
-- pinned by a test that reads the row back and asserts it.


-- Reading a version's bytes by blob is a lookup by the blob it names, so the
-- index carries the organization first: deduplication never crosses
-- organizations (O43), and a lookup that could reach another organization's
-- blob would be a cross-tenant read.
create index artifact_versions_org_blob_idx
  on bakery.artifact_versions (organization_id, blob_id)
  where blob_id is not null;
