-- GHI-739 slice 3a: an alert channel is somewhere Bakery sends an alert message.
-- This slice has signed webhooks; Slack channels come later and use the same row.
-- Non-secret settings (the https address) are in `settings`; the signing secret
-- is an installation-owned secret sealed under the installation key, and the row
-- holds only its id. The secret is shown once, when it is made or replaced, and
-- is never returned again. What a channel last answered is kept on the row so the
-- page can say Working or Failing; the application role may write only that and
-- the editable columns. Removing a channel deletes the row; the application role
-- cannot delete the sealed secret record, which nothing references afterwards.
create table bakery.alert_channels (
  id uuid primary key,
  kind text not null,
  name text not null,
  enabled boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  secret_id uuid not null,
  secret_created_at timestamptz not null default now(),
  last_answer_at timestamptz,
  last_answer_ok boolean,
  last_answer_status integer,
  last_answer_reason text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint alert_channels_secret_fk
    foreign key (secret_id) references bakery.secrets (id),
  constraint alert_channels_created_by_fk
    foreign key (created_by) references bakery.principals (id),
  constraint alert_channels_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
);

-- A name is unique ignoring case, so two channels cannot look alike in an alert.
create unique index alert_channels_name_unique
  on bakery.alert_channels (lower(name));
create index alert_channels_created_idx
  on bakery.alert_channels (created_at, id);

revoke all on bakery.alert_channels from bakery_app;
grant select, insert, delete on bakery.alert_channels to bakery_app;
grant update (name, enabled, settings, secret_id, secret_created_at,
  last_answer_at, last_answer_ok, last_answer_status, last_answer_reason,
  updated_by, updated_at, version)
  on bakery.alert_channels to bakery_app;
