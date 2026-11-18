-- The durable inbox: one row per recipient, per event, per target.
--
-- Chapter 24 of the design keeps two things apart on purpose. The notification
-- is what a person is told about (this table); the unread position inside a
-- conversation is a separate concern that lives with the conversation. Merging
-- them would make "mark all read" mean "clear every chat", which is not what
-- anyone wants.
--
-- A row is a claim that a specific event concerns a specific person and points
-- at a specific destination. It is never a copy of the destination: the target
-- is stored as a typed reference and reauthorized when the item is opened, so a
-- notification can go stale or become inaccessible without ever leaking a title
-- the recipient is no longer allowed to see.
--
-- The closed kind and target_kind vocabularies are owned by TypeScript, not by
-- CHECK constraints: the contract's Zod schemas and the target resolver are the
-- one place that decides what a kind means, matching the questions table.
--
-- Two fields exist only to make the item safe to render from a server response:
-- kind is a stable code rather than an English sentence, and arguments holds
-- bounded localization inputs (a task title, a step name) rather than a
-- pre-rendered string or a message body. Copy is composed on the client.
create table bakery.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  recipient_id uuid not null,
  kind text not null,
  target_kind text not null,
  target_id uuid not null,
  target_anchor text,
  conversation_id uuid,
  run_id uuid,
  task_id uuid,
  actor_id uuid,
  source_event_id uuid not null,
  source_version integer not null,
  arguments jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  constraint notifications_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint notifications_recipient_fk
    foreign key (recipient_id)
    references bakery.principals (id) on delete cascade,
  constraint notifications_actor_fk
    foreign key (actor_id)
    references bakery.principals (id) on delete set null,
  constraint notifications_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete cascade,
  constraint notifications_run_fk
    foreign key (organization_id, run_id)
    references bakery.workflow_runs (organization_id, id) on delete cascade,
  constraint notifications_task_fk
    foreign key (organization_id, task_id)
    references bakery.tasks (organization_id, id) on delete cascade,
  constraint notifications_source_event_fk
    foreign key (source_event_id)
    references bakery.domain_events (id) on delete cascade,
  constraint notifications_organization_id_unique
    unique (organization_id, id)
);

-- The dedupe key. A replayed domain event, a duplicated outbox delivery, a
-- dispatcher restart or a browser that was offline all try to write the same
-- fact; the second write is a no-op rather than a second badge. source_version
-- is part of the key so a rerun or a later outcome is honestly a new row
-- instead of overwriting the history of the first.
create unique index notifications_dedupe_unique
  on bakery.notifications (
    organization_id, recipient_id, kind, source_event_id, source_version
  );

-- The read path: one recipient's newest first, and the unread count.
create index notifications_inbox_idx
  on bakery.notifications (organization_id, recipient_id, created_at desc, id desc);

-- The unread badge and mark-all-read sweep touch only unread rows.
create index notifications_unread_idx
  on bakery.notifications (organization_id, recipient_id, created_at)
  where read_at is null;

-- The mentions tab is the same list narrowed by kind.
create index notifications_mentions_idx
  on bakery.notifications (organization_id, recipient_id, kind, created_at desc, id desc)
  where kind in ('mention', 'comment_mention');

-- Rows are written by the projection that owns the source event and read by
-- the recipient. read_at, revision and the presentation arguments are the only
-- mutable columns; the identity of the item never changes once written.
grant select, insert on bakery.notifications to bakery_app;
grant update (read_at, revision) on bakery.notifications to bakery_app;