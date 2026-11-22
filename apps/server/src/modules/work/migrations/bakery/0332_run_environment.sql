-- Where a run may reach (issue #427 slice S1, chapter 25 section 14, O14).
--
-- `live` runs admit external effects and brokered integration credentials as
-- before. `offline` runs are refused both: the effect ledger blocks every
-- external effect with environment_offline and the broker denies every provider
-- request and credential. Metered model calls are not effects and stay allowed.
--
-- Rules for this column:
-- * Written once, by the transaction that admits the run, and never edited, so
--   the application role gets no update grant on it.
-- * Every existing run was live, which the default records.
-- * The value set (live, offline) and the inheritance rule (a run an offline
--   run spawns is offline) are TypeScript; the PostgreSQL boundary rail
--   forbids CHECK constraints and triggers.
alter table bakery.workflow_runs
  add column environment text not null default 'live';
