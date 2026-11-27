alter table bakery.slack_installations
  add column connected_at timestamptz not null default now();

grant update (connected_at) on bakery.slack_installations to bakery_app;
