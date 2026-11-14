-- The GitHub App's bot account id (issue #20). Invoked effects need it in a
-- github.repository resource binding (botUserId): reconciliation matches the
-- comments the App itself authored. GitHub assigns it to the App's
-- "<slug>[bot]" user; it is looked up once after registration and backfilled
-- by the installation reconcile for Apps registered before this column.
-- Null means not looked up yet: no snapshot is built, so nothing dispatches.
alter table bakery.integration_app_registrations
  add column bot_user_id bigint;

grant update (bot_user_id) on bakery.integration_app_registrations
  to bakery_app;
