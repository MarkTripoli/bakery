-- GHI-739 slice 3b: when Bakery sends an alert.
-- There are five fixed rules (service down, worker lost, queue age, route
-- incident, export loss). An installation turns each on or off and may set the
-- limit of the ones that have one. A rule with no row has never been changed and uses
-- its default; the server writes the row the first time someone changes it.
-- The server checks the rule names, kinds and non-negative limits; the DB only stores.
-- alert_states holds what is firing right now, one row per rule and subject, so
-- one trouble is one alert however many times it is checked, and a restart does
-- not forget it. alert_events is the short history a person reads: what fired,
-- what resolved, and what a test sent. No business logic lives here.
create table bakery.alert_rules (
  rule text primary key,
  enabled boolean not null default true,
  threshold integer,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint alert_rules_updated_by_fk
    foreign key (updated_by) references bakery.principals (id)
);

create table bakery.alert_states (
  rule text not null,
  subject text not null,
  text text not null,
  fired_at timestamptz not null default now(),
  clean_checks integer not null default 0,
  primary key (rule, subject)
);

create table bakery.alert_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  rule text,
  subject text,
  text text not null,
  occurred_at timestamptz not null default now(),
  channels_ok integer not null default 0,
  channels_failed integer not null default 0
);
create index alert_events_occurred_idx
  on bakery.alert_events (occurred_at desc, id desc);

revoke all on bakery.alert_rules, bakery.alert_states, bakery.alert_events
  from bakery_app;
grant select, insert on bakery.alert_rules to bakery_app;
grant update (enabled, threshold, updated_by, updated_at, version)
  on bakery.alert_rules to bakery_app;
grant select, insert, delete on bakery.alert_states to bakery_app;
grant update (text, clean_checks) on bakery.alert_states to bakery_app;
grant select, insert on bakery.alert_events to bakery_app;
