-- The step write set (chapter 25 section 17.6, issue #448): one row per write
-- an agent made to Bakery Files from a session, in the same transaction as the
-- write and its audit row. It is a record only: the step write limits and the
-- undo of a step's writes read it; nothing here enforces a rule.
--   attempt_id           the job attempt the session call came from;
--   agent_session_id     the agent session that made the call, when it has
--                        one (the same id the audit row names);
--   entry_id             the file or folder written;
--   op                   put | mkdir | copy | move | trash (TypeScript
--                        vocabulary in agent-file-scope.ts, not a CHECK
--                        constraint: the PostgreSQL boundary rail forbids
--                        them);
--   previous_version_id  the entry's current version before the write, null
--                        for a new entry or a folder;
--   new_version_id       its current version after the write, null for a
--                        folder. A move or trash leaves the version as it was,
--                        so both name the same one;
--   bytes_written        the size of the bytes the write stored (a put or a
--                        copy), else 0. Kept on the row so the step's byte
--                        limit still counts a version retention later deletes;
--   previous_parent_id,  for a move only: the folder and name the entry had
--   previous_name        before it, so the undo can move it back;
--   entry_version_before the entry's row version before the write, null when
--                        the write created the entry;
--   entry_version_after  its row version after the write. The undo compares
--                        these with the entry now, so a later change by
--                        anyone else is refused, never overwritten;
--   created_at           clock_timestamp(), so two writes in one transaction
--                        still order newest first;
--   reverted_at,         when a person undid this write, and who (#448 S5).
--   reverted_by_principal_id  Null until undone; an undone write is never
--                        undone again.
-- A version a retention sweep deletes leaves the row with a null version, and
-- the set null below names only that column, never organization_id.
create table bakery.step_write_set (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  attempt_id uuid not null,
  agent_session_id uuid,
  entry_id uuid not null,
  op text not null,
  previous_version_id uuid,
  new_version_id uuid,
  bytes_written bigint not null default 0,
  previous_parent_id uuid,
  previous_name text,
  entry_version_before bigint,
  entry_version_after bigint not null,
  reverted_at timestamptz,
  reverted_by_principal_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  constraint step_write_set_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint step_write_set_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint step_write_set_reverted_by_fk
    foreign key (reverted_by_principal_id)
    references bakery.principals (id) on delete restrict,
  constraint step_write_set_previous_parent_fk
    foreign key (organization_id, previous_parent_id)
    references bakery.storage_entries (organization_id, id)
    on delete set null (previous_parent_id),
  constraint step_write_set_session_fk
    foreign key (organization_id, agent_session_id)
    references bakery.agent_sessions (organization_id, id)
    on delete set null (agent_session_id),
  constraint step_write_set_entry_fk
    foreign key (organization_id, entry_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  constraint step_write_set_previous_version_fk
    foreign key (organization_id, previous_version_id)
    references bakery.storage_file_versions (organization_id, id)
    on delete set null (previous_version_id),
  constraint step_write_set_new_version_fk
    foreign key (organization_id, new_version_id)
    references bakery.storage_file_versions (organization_id, id)
    on delete set null (new_version_id)
);

-- A step's writes, in order, for its limits and its undo.
create index step_write_set_attempt_idx
  on bakery.step_write_set (organization_id, attempt_id, created_at, id);
-- The version read finds the agent write that made a version.
create index step_write_set_new_version_idx
  on bakery.step_write_set (organization_id, new_version_id)
  where new_version_id is not null;

-- The writes of a step not yet undone, for the undo.
create index step_write_set_unreverted_idx
  on bakery.step_write_set (organization_id, attempt_id)
  where reverted_at is null;

grant select, insert on bakery.step_write_set to bakery_app;
grant update (reverted_at, reverted_by_principal_id)
  on bakery.step_write_set to bakery_app;
