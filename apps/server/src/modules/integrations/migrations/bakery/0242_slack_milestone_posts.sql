-- Every milestone Bakery posts to Slack, so a reply in that thread can be
-- resolved back to the run it belongs to (issue #415, owner decision O21).
--
-- A post is written before Slack is called and completed with the message
-- timestamp Slack answers, so a delivery that fails leaves a row with no
-- message_ts rather than a message nobody can find again. The decision state of
-- a "waiting on you" post lives here too: the buttons in a thread stay bright
-- for as long as Slack keeps the message, and the row is what makes a stale
-- press refuse instead of deciding twice.
--
-- The workspace and channel are Slack identifiers, not Bakery ones; run_id is
-- the Bakery fact a reply steers. Structure only: which milestone(s) a run
-- posts, who may press a button and what a reply is allowed to steer are
-- enforced in TypeScript.
create table bakery.slack_milestone_posts (
  id uuid primary key,
  organization_id uuid not null
    references bakery.organizations (id) on delete cascade,
  installation_team_id text not null,
  channel_id text not null,
  -- Slack's own message identifier, null until the post succeeded.
  message_ts text,
  -- Set when the message is itself a reply in an earlier post's thread.
  thread_ts text,
  run_id uuid not null,
  step_key text,
  milestone text not null,
  -- 'open', 'approved' or 'rejected' for a post that carries buttons; null for
  -- every other milestone.
  decision_state text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint slack_milestone_posts_message_unique
    unique (channel_id, message_ts)
);

-- A thread reply arrives with the thread's root timestamp and nothing else that
-- identifies a Bakery run.
create index slack_milestone_posts_thread
  on bakery.slack_milestone_posts (channel_id, thread_ts);

-- The run page asks which milestones a run has already announced.
create index slack_milestone_posts_run
  on bakery.slack_milestone_posts (organization_id, run_id, created_at desc);
