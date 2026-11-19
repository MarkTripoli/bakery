-- Writer grants for provider routes, their health and their incidents
-- (#26 slice 2, writes).
--
-- 0203 granted SELECT only and said the writers would bring their own INSERT and
-- UPDATE grants, so a grant never exists without the code that needs it. These
-- are those grants, and they are no wider than the two writers use:
--
--   - the route commands insert a route and change its status and region,
--   - the probe writer moves a route's circuit state, its current incident and
--     its probe times, and keeps one health row and one incident per generation.
--
-- The route's UPDATE is column-level on purpose. Provider, endpoint, model,
-- harness, billing route, credential location, account and binding are what an
-- incident and a probe result were made about, so they are immutable. The
-- application refuses to change them, and the missing grant is the second wall:
-- a future writer that tried would fail with "permission denied" instead of
-- quietly rewriting history. There is no DELETE grant, because a route is
-- disabled or revoked and never removed.
--
-- No CHECK constraint, trigger or policy: which transitions are allowed is the
-- application's rule.

grant insert on bakery.provider_routes to bakery_app;
grant update (
  status, region, health, incident_id, incident_generation, last_probe_at,
  next_probe_at, inference_verified_at, updated_at, version
) on bakery.provider_routes to bakery_app;

grant insert, update on bakery.provider_route_health to bakery_app;
grant insert, update on bakery.provider_incidents to bakery_app;
