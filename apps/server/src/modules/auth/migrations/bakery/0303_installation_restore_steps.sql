-- The ordered re-enable of a restored installation (issue #64 slice E3).
--
-- A restore leaves one unreleased installation_restores row and every door
-- closed. An installation administrator opens the doors in a fixed order, one
-- step at a time: intake (new work is admitted), dispatch (background consumers
-- run again), workers (workers claim work again). The step that opens the last
-- doors also sets released_at, which ends the hold.
--
-- Each step records when it was taken. The order is also a constraint, so no
-- code path can open a later door while an earlier one is still closed. The
-- application role may set only these columns: the fence's own counts and the
-- set's name stay as the owner wrote them.
alter table bakery.installation_restores
  add column intake_enabled_at timestamptz,
  add column dispatch_enabled_at timestamptz,
  add column workers_enabled_at timestamptz,
  add constraint installation_restores_step_order check (
    (dispatch_enabled_at is null or intake_enabled_at is not null)
    and (workers_enabled_at is null or dispatch_enabled_at is not null)
    and (released_at is null or workers_enabled_at is not null)
  );

grant update (
  intake_enabled_at, dispatch_enabled_at, workers_enabled_at, released_at
) on bakery.installation_restores to bakery_app;
