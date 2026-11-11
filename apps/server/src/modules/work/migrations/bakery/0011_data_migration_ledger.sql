create table bakery.data_migrations (
  version text primary key,
  checksum text not null,
  completed_at timestamptz not null default now()
);

revoke all on bakery.data_migrations from public, bakery_app;
