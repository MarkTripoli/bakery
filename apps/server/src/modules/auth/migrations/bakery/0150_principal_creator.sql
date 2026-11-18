-- Who created a service account. A member manages the service accounts they
-- created; an Admin manages every one in the organization (issue 233,
-- owner-directed split). Nullable because every principal that existed before
-- this column has no recorded creator, and a human principal is never created
-- by another member.
alter table bakery.principals
  add column created_by_principal_id uuid
    references bakery.principals (id) on delete set null;

create index principals_created_by_idx
  on bakery.principals (created_by_principal_id)
  where created_by_principal_id is not null;
