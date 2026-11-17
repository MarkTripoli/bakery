-- A call refused before its credential resolved.
--
-- The audit table requires a credential, an attempt, a principal and a session,
-- because every row in it is a call that was attributed to a real session. A
-- credential that never resolves has none of those, so it cannot be recorded
-- there without making every column nullable and weakening the record for the
-- one case that has the least to say.
--
-- It is still a fact worth keeping: a presented token that names no live
-- credential is either a stale client or a probe, and both are worth being able
-- to count. So it gets its own table, holding exactly what is known at the
-- moment of refusal and nothing invented to fill the gaps.
create table bakery.session_operation_refusals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  -- The attempt the caller asked about. Not a foreign key: the refusal happens
  -- before the attempt is claimed, so the id may name nothing at all, and a
  -- constraint would turn a recorded refusal into a failed insert.
  attempt_id uuid not null,
  -- The hash of the token that was presented, which is the same value the
  -- lookup used. It correlates repeated attempts without storing the bearer.
  presented_token_hash text not null,
  operation text not null,
  outcome text not null,
  recorded_at timestamptz not null default now(),
  constraint session_operation_refusals_organization_fk
    foreign key (organization_id) references bakery.organizations (id)
    on delete cascade
);

-- Read the same way the audit is: by attempt, most recent first.
create index session_operation_refusals_attempt_idx
  on bakery.session_operation_refusals (organization_id, attempt_id, recorded_at);

-- Append-only, like the audit: a record that can be edited is not a record.
grant select, insert on bakery.session_operation_refusals to bakery_app;
