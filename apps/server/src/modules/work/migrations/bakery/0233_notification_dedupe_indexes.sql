-- One announcement per fact, enforced by the database.
--
-- The base dedupe key (0173) keeps a replayed event from writing twice, but a
-- run's outcome and a step's failure are announced by events that differ from
-- one another: several events follow a run reaching a terminal state, and a
-- step can fail on more than one attempt. Without a constraint, two requests
-- racing to announce the same run both pass an "already told?" check and both
-- write. These partial unique indexes make the second insert a no-op, because
-- the projection inserts with ON CONFLICT DO NOTHING.
--
-- A rerun of a run is a new run with its own id, so it is honestly a new row.
create unique index notifications_run_outcome_unique
  on bakery.notifications (organization_id, recipient_id, kind, run_id)
  where kind in ('run_completed', 'run_failed');

create unique index notifications_step_failed_unique
  on bakery.notifications (organization_id, recipient_id, target_id)
  where kind = 'step_failed';
