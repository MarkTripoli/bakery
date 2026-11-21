-- The ordered re-enable of a restored installation (issue #64 slice E3).
--
-- A restore leaves one unreleased installation_restores row and every door
-- closed. An installation administrator opens the doors in a fixed order, one
-- step at a time: intake (new work is admitted), dispatch (background consumers
-- run again), workers (workers claim work again). The step that opens the last
-- doors also sets released_at, which ends the hold.
--
-- Each step records when it was taken. The order is enforced by the server
-- (restore-release.ts), not by the database. The application role may set only these columns: the fence's own counts and the
-- set's name stay as the owner wrote them.
alter table bakery.installation_restores
  add column intake_enabled_at timestamptz,
  add column dispatch_enabled_at timestamptz,
  add column workers_enabled_at timestamptz;

grant update (
  intake_enabled_at, dispatch_enabled_at, workers_enabled_at, released_at
) on bakery.installation_restores to bakery_app;
