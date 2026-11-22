-- What Bakery does when an update does not become healthy, and the history of
-- updates (issue #59 slice 3, server asks 2, 3, 7 and 12 to 14).
--
-- The launcher (scripts/deploy/release.mjs) has to read the policy without
-- Bakery running, so it lives next to the other installation policy and the
-- launcher reads it through the owner-role "update" task, the way it counts
-- waiting work. go_back is the default: an update that is not healthy is
-- undone by itself. ask leaves the choice to whoever is at the server.
alter table bakery.installation_settings
  add column update_failure_policy text not null default 'go_back';

grant update (update_failure_policy) on bakery.installation_settings
  to bakery_app;

-- One row per thing that happened to the installed version: an install, an
-- update, a going back, a refusal, an answer given at the terminal, a switch
-- that was interrupted. The launcher writes it as the database owner (the
-- "update" task), because the web app may be the broken part; Bakery reads it
-- for the Updates page. The id is made by the launcher, so an event it could
-- not record at once is sent again later without being doubled. Words and
-- release ids only: never a path, a secret or a task title. The update task
-- validates every value before it writes (update-task.ts); the database keeps
-- no rule of its own.
--
--   installed         to_release is the first release
--   updated           from_release was replaced by to_release
--   rolled_back       from_release was replaced by the earlier to_release, by hand
--   went_back         the update to from_release did not become ready; Bakery
--                     went back to to_release by itself (by_name is null)
--   refused           the update to to_release was refused; detail says why
--   decided_go_back   a person chose to go back from from_release to to_release
--   decided_stay      a person chose to stay on the release that was not healthy
--   interrupted       a switch to from_release did not finish; recover put
--                     to_release back
create table bakery.installation_update_history (
  id uuid primary key,
  kind text not null,
  occurred_at timestamptz not null,
  -- The operating-system user at the terminal, or null when Bakery did it by itself.
  by_name text,
  from_release text,
  to_release text,
  -- The launcher's first line for a refusal; null for the rest.
  detail text,
  -- A person dismissed the notice about this event; it stays in the history.
  dismissed_at timestamptz,
  dismissed_by_principal_id uuid references bakery.principals (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index installation_update_history_recent_idx
  on bakery.installation_update_history (occurred_at desc, id desc);

grant select on bakery.installation_update_history to bakery_app;
grant update (dismissed_at, dismissed_by_principal_id)
  on bakery.installation_update_history to bakery_app;
