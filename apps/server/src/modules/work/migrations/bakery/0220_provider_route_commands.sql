-- Command grants for provider routes (#26 slice 2, writes).
--
-- 0203 granted SELECT only and said a writer would bring its own INSERT and
-- UPDATE grants, so a grant never exists without the code that needs it. These
-- are the grants the two route commands use, and nothing wider:
--
--   - `providerRoutes.create` inserts a route,
--   - `providerRoutes.update` changes a route's status and region, and when a
--     route leaves `active` it clears the probe schedule on the route and on its
--     health row.
--
-- The route's UPDATE is column-level on purpose. Provider, endpoint, model,
-- harness, billing route, credential location, account and binding are what an
-- incident and a probe result are made about, so they are immutable. The
-- application refuses to change them, and the missing grant is the second wall:
-- a later writer that tried would fail with "permission denied" instead of
-- quietly rewriting history. Circuit state, the current incident and inference
-- proof are not granted either: nothing here may move them, and the probe slice
-- that does adds its own grants with its own code. There is no DELETE grant,
-- because a route is disabled or revoked and never removed.
--
-- No CHECK constraint, trigger or policy: which transitions are allowed is the
-- application's rule.

grant insert on bakery.provider_routes to bakery_app;
grant update (status, region, next_probe_at, updated_at, version)
  on bakery.provider_routes to bakery_app;

grant update (next_probe_at, probe_lease_expires_at, updated_at)
  on bakery.provider_route_health to bakery_app;
