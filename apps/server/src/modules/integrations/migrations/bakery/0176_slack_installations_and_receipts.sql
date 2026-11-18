-- Slack workspace installations and the events they deliver (issue #27).
-- * slack_installations: one Slack app installed in one workspace for one Bakery
--   organization. (app_id, team_id) is the key a verified delivery is resolved
--   by, so it is unique across organizations: a workspace cannot serve two
--   organizations through the same app. enterprise_id and bot_user_id are the
--   facts the installation response proved. signing_secret_id names the
--   app-level signing secret in bakery.secrets; the secret itself is never in
--   this table. A row with no signing secret refuses every delivery.
-- * slack_event_receipts: one committed receipt per delivered event. The
--   identity is (app_id, event_id); the same identity with a different digest
--   is refused in TypeScript. Only the digest and the outcome are kept: an
--   ignored event (a bot echo, an unlinked message) leaves a receipt with no
--   text, so a retry is recognised without its content ever being stored.
-- Structure only: the receipt and installation lifecycles and the retention
-- sweep are enforced in TypeScript. The application role may insert and
-- select, and may change only the lifecycle columns; nothing an installation or
-- a receipt was bound to can be rewritten, and installations are never deleted.
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
  installation_id uuid not null references bakery.slack_installations (id)
    on delete cascade,
  payload_digest text not null,
  outcome text not null,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint slack_event_receipts_delivery_unique unique (app_id, event_id)
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
