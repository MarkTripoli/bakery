-- The grants the Slack app's own screens need (#415).
--
-- 0283 gave the application role SELECT on the settings row, which is enough to
-- read the section and not enough to use it: saving, removing and recording a
-- check all write it, and the settings row is the only row there is. The
-- receipts table (0281) already carried its own grants; the posts table (0242)
-- carried none, so a thread reply could not resolve its run and a delivery
-- could not record its message.
--
-- Removing an app revokes its two secrets rather than deleting them, so the role
-- needs to change the columns a save and a revocation write -- and no others:
-- a table-wide update would also let the application rename or re-scope any
-- secret. It never needs delete, on the secret or on its versions.

grant select, insert, update, delete on bakery.slack_app_settings to bakery_app;

grant update (
  active_version_id,
  active_version_revision,
  generation,
  invalidation_generation,
  revoked_at,
  version,
  updated_at
) on bakery.secrets to bakery_app;

grant select, insert, update on bakery.slack_milestone_posts to bakery_app;
