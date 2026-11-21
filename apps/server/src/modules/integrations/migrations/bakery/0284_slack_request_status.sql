-- What Slack has said to Bakery lately, so the settings screen can report it (#415).
--
-- The design asks for two rows: whether Slack accepted the app's sign-in details
-- when they were last checked, and when a request from Slack last passed or failed
-- the signature check. None of that is derivable from the receipts table -- it holds
-- only the deliveries that verified, and only for as long as the window lasts -- so
-- the settings row itself keeps the last word.
--
-- Times are nullable and mean "never": a screen shows "Not checked yet." and "No
-- request from Slack yet." rather than a date nobody recorded. The outcome of a check
-- is a small closed vocabulary, and the code that writes it is the only writer, so the
-- vocabulary is enforced there rather than by a constraint a migration may not state.
alter table bakery.slack_app_settings
  add column details_checked_at timestamptz,
  add column details_check_result text,
  add column last_request_at timestamptz,
  add column last_request_failed_at timestamptz;

comment on column bakery.slack_app_settings.details_checked_at is
  'When the client ID and secret were last checked with Slack.';
comment on column bakery.slack_app_settings.details_check_result is
  'What Slack answered to that check; null before the first one.';
comment on column bakery.slack_app_settings.last_request_at is
  'When a request from Slack last passed the signature check.';
comment on column bakery.slack_app_settings.last_request_failed_at is
  'When a request from Slack last failed it, so the screen can say the secret is wrong.';
