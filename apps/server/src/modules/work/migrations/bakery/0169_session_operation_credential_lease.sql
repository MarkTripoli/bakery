-- The lease a session credential was issued against.
--
-- Liveness is delegated to `assertActiveLease`, which compares the attempt's
-- current lease token against the one the caller claims. A credential that did
-- not record its own lease could only be compared against the attempt's own
-- value, which is trivially equal and proves nothing: the check exists to
-- notice that the lease was re-taken since the credential was issued, and that
-- is only visible if the credential remembers what it was issued under.
--
-- The column was declared in the row type and never created, so every resolved
-- claim carried `undefined` and every call was refused as fence-stale. The
-- table is new and holds no rows, so the default is only there to satisfy
-- `not null` while the column is added; it is dropped immediately after.
alter table bakery.session_operation_credentials
  add column lease_token_hash text not null default '';

alter table bakery.session_operation_credentials
  alter column lease_token_hash drop default;
