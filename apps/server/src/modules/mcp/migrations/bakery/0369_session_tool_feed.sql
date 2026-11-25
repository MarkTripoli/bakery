create table bakery.conversation_feed_sequences (
  organization_id uuid not null,
  conversation_id uuid not null,
  last_sequence bigint not null,
  constraint conversation_feed_sequences_pkey
    primary key (organization_id, conversation_id),
  constraint conversation_feed_sequences_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete cascade
);

grant select, insert on bakery.conversation_feed_sequences to bakery_app;
grant update (last_sequence)
  on bakery.conversation_feed_sequences to bakery_app;

alter table bakery.tool_gateway_calls
  add column effective_name text,
  add constraint tool_gateway_calls_organization_id_unique
    unique (organization_id, id);

create table bakery.session_tool_feed_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  agent_session_id uuid not null,
  tool_gateway_call_id uuid not null,
  sequence bigint not null,
  phase text not null,
  ok boolean,
  occurred_at timestamptz not null default now(),
  constraint session_tool_feed_events_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint session_tool_feed_events_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete cascade,
  constraint session_tool_feed_events_session_fk
    foreign key (organization_id, conversation_id, agent_session_id)
    references bakery.agent_sessions (organization_id, conversation_id, id)
    on delete cascade,
  constraint session_tool_feed_events_call_fk
    foreign key (organization_id, tool_gateway_call_id)
    references bakery.tool_gateway_calls (organization_id, id) on delete cascade,
  constraint session_tool_feed_events_session_sequence_unique
    unique (organization_id, agent_session_id, sequence),
  constraint session_tool_feed_events_call_phase_unique
    unique (organization_id, tool_gateway_call_id, phase)
);

create index session_tool_feed_events_conversation_sequence_idx
  on bakery.session_tool_feed_events
  (organization_id, conversation_id, sequence, id);

grant select, insert on bakery.session_tool_feed_events to bakery_app;
