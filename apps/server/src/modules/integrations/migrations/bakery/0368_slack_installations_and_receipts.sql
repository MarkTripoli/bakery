create table bakery.slack_installations (
  id uuid primary key,
  organization_id uuid not null,
  app_id text not null,
  team_id text not null,
  enterprise_id text,
  bot_user_id text not null,
  signing_secret_id uuid references bakery.secrets (id),
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint slack_installations_workspace_unique unique (app_id, team_id),
  constraint slack_installations_app_identity_unique unique (app_id, id),
  constraint slack_installations_organization_id_unique
    unique (organization_id, id),
  constraint slack_installations_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade
);

create table bakery.slack_thread_bindings (
  id uuid primary key,
  organization_id uuid not null,
  installation_id uuid not null,
  channel_id text not null,
  thread_ts text not null,
  conversation_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint slack_thread_bindings_thread_unique
    unique (installation_id, channel_id, thread_ts),
  constraint slack_thread_bindings_installation_fk
    foreign key (organization_id, installation_id)
    references bakery.slack_installations (organization_id, id)
    on delete cascade,
  constraint slack_thread_bindings_conversation_fk
    foreign key (organization_id, conversation_id)
    references bakery.conversations (organization_id, id) on delete restrict,
  constraint slack_thread_bindings_created_by_fk
    foreign key (created_by)
    references bakery.principals (id) on delete restrict
);
create index slack_thread_bindings_conversation_idx
  on bakery.slack_thread_bindings (organization_id, conversation_id);

create table bakery.slack_event_receipts (
  id uuid primary key,
  app_id text not null,
  event_id text not null,
  installation_id uuid not null,
  payload_digest text not null,
  outcome text not null,
  status text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  expires_at timestamptz not null,
  constraint slack_event_receipts_delivery_unique unique (app_id, event_id),
  constraint slack_event_receipts_installation_fk
    foreign key (app_id, installation_id)
    references bakery.slack_installations (app_id, id) on delete cascade
);
create index slack_event_receipts_terminal_expiry
  on bakery.slack_event_receipts (status, expires_at, id);
create index slack_event_receipts_installation_idx
  on bakery.slack_event_receipts (installation_id);

grant select, insert on bakery.slack_installations to bakery_app;
grant update (signing_secret_id, status, updated_at, version)
  on bakery.slack_installations to bakery_app;

grant select, insert on bakery.slack_thread_bindings to bakery_app;
grant select, insert, delete on bakery.slack_event_receipts to bakery_app;
grant update (outcome, status, processed_at, expires_at)
  on bakery.slack_event_receipts to bakery_app;
