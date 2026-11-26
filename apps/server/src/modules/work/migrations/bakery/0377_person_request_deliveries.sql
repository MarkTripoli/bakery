create table bakery.person_request_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_id uuid not null,
  channel text not null,
  state text not null,
  attempts integer not null default 1,
  external_ref text,
  failure_code text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint person_request_deliveries_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint person_request_deliveries_request_fk
    foreign key (organization_id, request_id)
    references bakery.person_requests (organization_id, id) on delete cascade,
  constraint person_request_deliveries_channel_unique
    unique (request_id, channel)
);

create index person_requests_open_created_idx
  on bakery.person_requests (created_at, id)
  where status = 'open';

grant select, insert on bakery.person_request_deliveries to bakery_app;
grant update (state, attempts, external_ref, failure_code, delivered_at,
  updated_at, version)
  on bakery.person_request_deliveries to bakery_app;
