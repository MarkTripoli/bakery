-- #68: 0124 granted the app role UPDATE on every provider-binding column a
-- PATCH writes except billing_route, so any route change failed with
-- "permission denied" (500). Grant that one column.
grant update (billing_route)
  on bakery.worker_provider_bindings
  to bakery_app;
