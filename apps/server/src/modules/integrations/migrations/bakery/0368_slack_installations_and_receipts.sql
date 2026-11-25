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

create table bakery.slack_event_receipts (
  id uuid primary key,
  app_id text not null,
  event_id text not null,
  installation_id uuid not null,
  payload_digest text not null,
  outcome text not null,
  processing_intent text,
  channel_id text,
  user_id text,
  event_ts text,
  thread_ts text,
  message_text text,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint slack_event_receipts_delivery_unique unique (app_id, event_id),
  constraint slack_event_receipts_installation_fk
    foreign key (app_id, installation_id)
    references bakery.slack_installations (app_id, id) on delete cascade,
  constraint slack_event_receipts_outcome_check
    check (outcome in ('accepted', 'ignored')),
  constraint slack_event_receipts_work_check
    check (
      (
        outcome = 'accepted' and
        processing_intent in ('mention', 'thread_reply') and
        channel_id is not null and user_id is not null and
        event_ts is not null and thread_ts is not null and
        message_text is not null
      ) or (
        outcome = 'ignored' and processing_intent is null and
        channel_id is null and user_id is null and event_ts is null and
        thread_ts is null and message_text is null
      )
    )
);
create index slack_event_receipts_expiry
  on bakery.slack_event_receipts (expires_at);
create index slack_event_receipts_installation_idx
  on bakery.slack_event_receipts (installation_id);

grant select, insert on bakery.slack_installations to bakery_app;
grant update (signing_secret_id, status, updated_at, version)
  on bakery.slack_installations to bakery_app;

grant select, insert, delete on bakery.slack_event_receipts to bakery_app;
grant update (outcome) on bakery.slack_event_receipts to bakery_app;
