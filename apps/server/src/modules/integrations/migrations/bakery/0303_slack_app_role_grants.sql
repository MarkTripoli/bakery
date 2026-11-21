-- The grants the Slack app's own screens need (#415).
--
-- 0283 gave the application role SELECT on the settings row, which is enough to
-- read the section and not enough to use it: saving, removing and recording a
-- check all write it, and the settings row is the only row there is. The
-- receipts table (0281) already carried its own grants; the posts table (0242)
-- carried none, so a thread reply could not resolve its run and a delivery
-- could not record its message.
--
-- Secrets stay as 0050 left them: the application role may insert and read them
-- and may take one out of use, never delete one.

grant select, insert, update, delete on bakery.slack_app_settings to bakery_app;

grant select, insert, update on bakery.slack_milestone_posts to bakery_app;
