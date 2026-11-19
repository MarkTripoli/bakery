-- Writer grants for the provider probe (#26 slice 3).
--
-- 0210 granted what the route commands use and nothing about circuit state. The
-- probe is the one writer that moves it, and these are exactly the columns and
-- tables it writes, in the slice that adds the code that needs them:
--
--   - a route's circuit state and current incident, its probe times and its
--     inference proof (`provider_routes`), still column-level so identity stays
--     unwritable;
--   - one health row per route, inserted on first probe and updated after;
--   - one incident per route and generation, inserted on open and updated while
--     open and on recovery.
--
-- There is no DELETE grant on any of them.

grant update (
  health, incident_id, incident_generation, last_probe_at, inference_verified_at
) on bakery.provider_routes to bakery_app;

grant insert, update on bakery.provider_route_health to bakery_app;
grant insert, update on bakery.provider_incidents to bakery_app;
