-- What an automation run is made for (issue #36, slice 4). A run needs a task,
-- and a task needs an application (and, for repository work, a repository), a
-- title and a budget; an automation version carried none of that, and its
-- strict trigger cannot, so the version now pins its target:
-- * application_id and repository_id: same-organization foreign keys. Nullable
--   because versions written before this migration have no target; the create
--   route requires an application, and a firing of a version without one is
--   marked failed (`target_missing`) when it is started.
-- * budget_limit_usd: the per-run budget, as on a run (0 by default).
-- * brief: optional text that becomes the task description.
-- A firing that cannot start for a reason that will not change (an input the
-- workflow refuses, an actor who no longer holds the permissions) is marked
-- failed with a stable code instead of being retried forever; failure_code
-- holds it. Structure only: the vocabulary of codes is enforced in TypeScript.
alter table bakery.automation_versions
  add column application_id uuid,
  add column repository_id uuid,
  add column budget_limit_usd numeric(14, 6) not null default 0,
  add column brief text,
  add constraint automation_versions_application_fk
    foreign key (organization_id, application_id)
    references bakery.applications (organization_id, id),
  add constraint automation_versions_repository_fk
    foreign key (organization_id, repository_id)
    references bakery.repositories (organization_id, id);

alter table bakery.automation_firings
  add column failure_code text;

grant update (failure_code)
  on bakery.automation_firings
  to bakery_app;
