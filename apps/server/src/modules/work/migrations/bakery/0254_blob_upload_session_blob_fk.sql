-- A completed upload session names the blob row it produced, and collection
-- deletes that row when nothing holds it any more. The original constraint is
-- `on delete set null` over `(organization_id, completed_blob_id)`, and a
-- composite SET NULL nulls every column in the list - including
-- `organization_id`, which is not null. The delete therefore failed instead of
-- collecting the blob, which is how a completed session made its blob
-- permanently uncollectable.
--
-- PostgreSQL 15 added the column list to SET NULL, so the reference can keep
-- pointing at the tenant-scoped key while only clearing the blob: the session
-- stays in its organization and stops claiming bytes that are gone.
alter table bakery.blob_upload_sessions
  drop constraint blob_upload_sessions_blob_fk;

alter table bakery.blob_upload_sessions
  add constraint blob_upload_sessions_blob_fk
    foreign key (organization_id, completed_blob_id)
    references bakery.blobs (organization_id, id)
    on delete set null (completed_blob_id);
