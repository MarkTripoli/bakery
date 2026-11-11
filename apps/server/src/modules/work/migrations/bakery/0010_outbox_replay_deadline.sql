alter table bakery.outbox
  add column replay_deadline_at timestamptz;
