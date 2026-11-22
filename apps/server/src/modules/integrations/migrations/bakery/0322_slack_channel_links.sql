-- One Slack thread, one conversation (issue #27, design 09-integrations
-- "Bindings"): the row that lets a mention start a conversation exactly once
-- and lets a linked reply find it again.
--
-- The thread is named by the ids Slack gives and nothing a person can choose:
-- the app, the workspace (team), the channel and the thread's first message
-- timestamp, which stays a string because Slack's "ts" is not a number. The
-- unique key is the whole point: two first mentions that arrive together find
-- one row, so one conversation is opened, never two.
--
-- Only the application role's insert and select are granted: a link is never
-- edited or deleted, because an unlinked thread would let the next message open
-- a second conversation for the same thread. The server checks every id before
-- it writes (slack-bindings.ts); the database keeps no rule of its own.
create table bakery.channel_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  provider text not null,
  app_id text not null,
  team_id text not null,
  channel_id text not null,
  thread_ts text not null,
  conversation_id uuid not null,
  -- The linked person whose mention started the conversation.
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint channel_links_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint channel_links_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete restrict,
  constraint channel_links_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict,
  constraint channel_links_thread_unique
    unique (provider, app_id, team_id, channel_id, thread_ts)
);

create index channel_links_conversation_idx
  on bakery.channel_links (organization_id, conversation_id);

grant select, insert on bakery.channel_links to bakery_app;
