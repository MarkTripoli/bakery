-- The exact-grant delete grant is retained after RLS removal so application
-- adapters can still delete a membership's permission grants.
grant delete on bakery.permission_grants to bakery_app;
