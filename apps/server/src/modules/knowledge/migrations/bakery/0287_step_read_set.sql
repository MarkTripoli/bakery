-- The step read set (chapter 25 section 17.6, O46, issue #448 S6): one row per
-- storage read an agent made from a session, in the same transaction as the
-- read. It is a record only; nothing here enforces a rule.
--   attempt_id           the job attempt the session call came from;
--   agent_session_id     the agent session that made the call, when it has
--                        one (the same id the audit and write set rows name);
--   entry_id             the file opened or the folder listed;
--   version_id           for a working-area file, the storage version served;
--   artifact_version_id  for a record-area file (an artifact projected into
--                        the tree), the artifact version served. Exactly one
--                        of the two is set for a file read; both are null for
--                        a folder listing, which lists the latest entries and
--                        has no version of its own;
--   sha256               the digest of the bytes served, or for a folder
--                        listing the digest of the page it returned (each
--                        entry's id, kind and current version), so the row
--                        still says what the agent saw;
--   pinned               true when the read was served from the run's
--                        admission pin of a declared input
--                        (bakery.run_input_pins), false for a latest read;
--   created_at           clock_timestamp(), so two reads in one transaction
--                        still order.
-- A version a retention sweep deletes leaves the row with a null version, and
-- each set null below names only its own column, never organization_id.
create table bakery.step_read_set (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  attempt_id uuid not null,
  agent_session_id uuid,
  entry_id uuid not null,
  version_id uuid,
  artifact_version_id uuid,
  sha256 text not null,
  pinned boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  constraint step_read_set_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint step_read_set_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id) on delete cascade,
  constraint step_read_set_session_fk
    foreign key (organization_id, agent_session_id)
    references bakery.agent_sessions (organization_id, id)
    on delete set null (agent_session_id),
  constraint step_read_set_entry_fk
    foreign key (organization_id, entry_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  constraint step_read_set_version_fk
    foreign key (organization_id, version_id)
    references bakery.storage_file_versions (organization_id, id)
    on delete set null (version_id),
  constraint step_read_set_artifact_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id)
    on delete set null (artifact_version_id)
);

-- A step's reads, in order.
create index step_read_set_attempt_idx
  on bakery.step_read_set (organization_id, attempt_id, created_at, id);

grant select, insert on bakery.step_read_set to bakery_app;
