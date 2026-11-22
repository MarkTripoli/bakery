-- One-paste machine link (#70). A link code is a second, short way to name an
-- existing enrollment row: ten minutes, one use, bound to the row's
-- organization, name, slots and capabilities, and kept only as a hash. The
-- Admin may leave the name to the machine's host name and the system to what
-- the machine reports, so those three columns become nullable until the
-- machine registers.
--
-- A link request is a machine with no code asking to be linked. It is created
-- unauthenticated, so it has no organization until an Admin approves it; the
-- user code and the device secret are stored only as hashes. Decision rules
-- (decided once, ten-minute expiry, the approving organization) live in the
-- transaction code, not in CHECK constraints or triggers.
alter table bakery.worker_enrollments
  alter column name drop not null,
  alter column os drop not null,
  alter column architecture drop not null,
  add column link_code_hash text;

-- The app role writes the link code's hash when it issues one, and records
-- the name and system the machine reported when a link code is used.
grant insert (link_code_hash) on bakery.worker_enrollments to bakery_app;
grant update (link_code_hash, name, os, architecture)
  on bakery.worker_enrollments to bakery_app;

create unique index worker_enrollments_link_code_idx
  on bakery.worker_enrollments (link_code_hash)
  where link_code_hash is not null;

create table bakery.worker_link_requests (
  id uuid primary key default gen_random_uuid(),
  user_code_hash text not null,
  device_secret_hash text not null,
  hostname text not null,
  os text not null,
  architecture text not null,
  supported boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  organization_id uuid,
  decision text,
  decided_at timestamptz,
  decided_by uuid,
  decision_idempotency_key text,
  decision_request_digest text,
  enrollment_id uuid,
  version integer not null default 1,
  constraint worker_link_requests_user_code_unique unique (user_code_hash),
  constraint worker_link_requests_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint worker_link_requests_decided_by_fk
    foreign key (decided_by)
    references bakery.principals (id) on delete restrict,
  constraint worker_link_requests_enrollment_fk
    foreign key (organization_id, enrollment_id)
    references bakery.worker_enrollments (organization_id, id)
    on delete cascade
);

create index worker_link_requests_expires_idx
  on bakery.worker_link_requests (expires_at);
create index worker_link_requests_enrollment_idx
  on bakery.worker_link_requests (enrollment_id)
  where enrollment_id is not null;

grant select, insert, update, delete on bakery.worker_link_requests
  to bakery_app;
