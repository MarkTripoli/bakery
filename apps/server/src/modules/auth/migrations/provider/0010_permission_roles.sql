-- Role validity (admin|developer|viewer|guest) is enforced by the application;
-- the PostgreSQL boundary rail forbids new CHECK constraints.
alter table public.member
  drop constraint member_role_supported;
