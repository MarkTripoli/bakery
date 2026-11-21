-- Version provenance (chapter 25 section 17.6, O50, issue #448 S8a): each
-- stored file version an agent step produced names, from the moment of the
-- write, the run, step, attempt and agent session that made it and the person
-- the run acts for. A version read names these instead of looking them up
-- later, so a step's later session (a retry, a continuation) never becomes the
-- maker of a version an earlier session wrote.
--   run_id                   the run the producing step belongs to;
--   run_step_id              the producing step (artifact_versions already has
--                            this column: a step that published the version);
--   attempt_id               the job attempt the write came from;
--   agent_session_id         the agent session of that attempt, when it has one
--                            (the same id its audit and write set rows name);
--   acting_for_principal_id  the person the run acts for: the principal of the
--                            session credential, or the run's requester when the
--                            attempt minted none.
-- All are null for a version a person or a service wrote outside a step, and
-- for every version written before this migration: there is no backfill. Old
-- working-area versions an agent wrote still read their session from
-- bakery.step_write_set, which recorded it at the write; old record-area
-- versions a step published name the step and run but no session or attempt.
-- Each column is written once, by the insert that makes the version, and the
-- application role gets no update on it. A set null names only its own
-- column, never organization_id.
alter table bakery.storage_file_versions
  add column run_id uuid,
  add column run_step_id uuid,
  add column attempt_id uuid,
  add column agent_session_id uuid,
  add column acting_for_principal_id uuid;

alter table bakery.storage_file_versions
  add constraint storage_file_versions_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete set null (run_id),
  add constraint storage_file_versions_run_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id)
    on delete set null (run_step_id),
  add constraint storage_file_versions_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id)
    on delete set null (attempt_id),
  add constraint storage_file_versions_agent_session_fk
    foreign key (organization_id, agent_session_id)
    references bakery.agent_sessions (organization_id, id)
    on delete set null (agent_session_id),
  add constraint storage_file_versions_acting_for_fk
    foreign key (acting_for_principal_id)
    references bakery.principals (id) on delete restrict;

alter table bakery.artifact_versions
  add column run_id uuid,
  add column attempt_id uuid,
  add column agent_session_id uuid,
  add column acting_for_principal_id uuid;

alter table bakery.artifact_versions
  add constraint artifact_versions_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id)
    on delete set null (run_id),
  add constraint artifact_versions_attempt_fk
    foreign key (organization_id, attempt_id)
    references bakery.job_attempts (organization_id, id)
    on delete set null (attempt_id),
  add constraint artifact_versions_agent_session_fk
    foreign key (organization_id, agent_session_id)
    references bakery.agent_sessions (organization_id, id)
    on delete set null (agent_session_id),
  add constraint artifact_versions_acting_for_fk
    foreign key (acting_for_principal_id)
    references bakery.principals (id) on delete restrict;

-- The versions one run produced, for a reviewer's provenance filter (S8b).
create index storage_file_versions_run_idx
  on bakery.storage_file_versions (organization_id, run_id)
  where run_id is not null;
create index artifact_versions_run_idx
  on bakery.artifact_versions (organization_id, run_id)
  where run_id is not null;
