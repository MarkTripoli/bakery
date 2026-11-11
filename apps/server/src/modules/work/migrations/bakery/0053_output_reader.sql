alter table bakery.session_output_streams
  add column created_at timestamptz not null default now();

create index session_output_streams_discovery_idx
  on bakery.session_output_streams (organization_id, created_at, id);
