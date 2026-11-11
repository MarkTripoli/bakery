-- Durable shared-conversation transcript and queued turn admission.
-- TypeScript owns lifecycle, content, and authorization validation. PostgreSQL
-- owns tenant-scoped relationships, replay identities, and active-turn shape.
create table bakery.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  author_id uuid,
  agent_session_id uuid,
  message_type text not null,
  body text not null,
  client_message_id text not null,
  reply_to_id uuid,
  sequence bigint not null,
  intent text not null,
  comment_context jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint messages_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint messages_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete restrict,
  constraint messages_author_fk
    foreign key (author_id)
    references bakery.principals (id) on delete restrict,
  constraint messages_organization_id_unique
    unique (organization_id, id),
  constraint messages_conversation_identity_unique
    unique (organization_id, conversation_id, id),
  constraint messages_conversation_sequence_unique
    unique (conversation_id, sequence),
  constraint messages_client_identity_unique
    unique nulls not distinct (
      conversation_id, author_id, client_message_id
    ),
  constraint messages_reply_scope_fk
    foreign key (organization_id, conversation_id, reply_to_id)
    references bakery.messages (organization_id, conversation_id, id)
    on delete restrict
);

alter table bakery.agent_sessions
  add constraint agent_sessions_conversation_identity_unique
  unique (organization_id, conversation_id, id);

alter table bakery.messages
  add constraint messages_agent_session_scope_fk
  foreign key (organization_id, conversation_id, agent_session_id)
  references bakery.agent_sessions (organization_id, conversation_id, id)
  on delete restrict;

create table bakery.conversation_turns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  trigger_message_id uuid not null,
  agent_session_id uuid,
  status text not null,
  context_through_sequence bigint,
  finished_at timestamptz,
  failure jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint conversation_turns_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint conversation_turns_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete restrict,
  constraint conversation_turns_trigger_scope_fk
    foreign key (organization_id, conversation_id, trigger_message_id)
    references bakery.messages (organization_id, conversation_id, id)
    on delete restrict,
  constraint conversation_turns_agent_session_scope_fk
    foreign key (organization_id, conversation_id, agent_session_id)
    references bakery.agent_sessions (organization_id, conversation_id, id)
    on delete restrict,
  constraint conversation_turns_organization_id_unique
    unique (organization_id, id),
  constraint conversation_turns_trigger_message_unique
    unique (trigger_message_id),
  constraint conversation_turns_agent_session_unique
    unique (agent_session_id)
);

create unique index conversation_turns_one_active_idx
  on bakery.conversation_turns (conversation_id)
  where status in ('active', 'cancel_requested');
create index messages_conversation_page_idx
  on bakery.messages (organization_id, conversation_id, sequence desc, id desc);
create index conversation_turns_queue_idx
  on bakery.conversation_turns (
    organization_id, conversation_id, status, trigger_message_id, id
  );

grant select, insert on bakery.messages, bakery.conversation_turns to bakery_app;
