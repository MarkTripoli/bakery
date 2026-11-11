-- The task repository binding command updates only role, required and
-- provenance (plus the row clock). Organization, application, task and
-- repository identity stay immutable for the application role, matching the
-- column-scoped grants on coordination plans and lanes.
revoke update on bakery.task_repositories from bakery_app;
grant update (role, required, provenance, updated_at, version)
  on bakery.task_repositories
  to bakery_app;
