create table bakery.event_clock (
  organization_id uuid not null references bakery.organizations(id) on delete cascade,
  stream text not null,
  next_seq bigint not null,
  retained_from_seq bigint not null default 1,
  primary key (organization_id, stream)
);

alter table bakery.domain_events
  add column organization_sequence bigint;

create table bakery.application_migration_drain (
  id text primary key,
  public_connect boolean not null,
  application_connect boolean not null,
  started_at timestamptz not null default now()
);

revoke all on bakery.application_migration_drain from public, bakery_app;
grant select on bakery.event_clock to bakery_app;
grant insert (organization_id, stream, next_seq), update (next_seq)
  on bakery.event_clock to bakery_app;
