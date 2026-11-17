-- An artifact version may name a blob instead of carrying its bytes
-- (chapter 25 §17.1: a version is digest, size, media type and a pointer; the
-- bytes live once per organization under their SHA-256).
--
-- Both columns are nullable and exactly one is set. That is a shape, not a
-- policy: it says a version has one home for its bytes, which is true of every
-- version that will ever exist, so it belongs in the database. Which home a
-- writer chooses is the server's rule and is not expressed here.
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

-- Exactly one home for the bytes. A version with neither is a version whose
-- content cannot be read; a version with both is two copies that can disagree,
-- and the disagreement would be discovered by whoever reads the wrong one.
alter table bakery.artifact_versions
  add constraint artifact_versions_one_content_home
    check ((content is null) <> (blob_id is null));

-- Reading a version's bytes by blob is a lookup by the blob it names, so the
-- index carries the organization first: deduplication never crosses
-- organizations (O43), and a lookup that could reach another organization's
-- blob would be a cross-tenant read.
create index artifact_versions_org_blob_idx
  on bakery.artifact_versions (organization_id, blob_id)
  where blob_id is not null;
