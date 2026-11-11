alter table bakery.outbox
  add column lease_token uuid,
  add column delivered_at timestamptz,
  add column engine_event_id text;
