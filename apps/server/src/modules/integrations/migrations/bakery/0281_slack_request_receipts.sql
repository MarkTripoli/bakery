-- One row per Slack request Bakery has already answered (#415).
--
-- Slack retries a webhook when it does not hear back in time, and a person can
-- press Approve twice. Both arrive as the same signed bytes, so they carry the
-- same signature, which is what this table keys on: the first insert wins and
-- every later copy is a duplicate the caller can recognise without re-running the
-- effect.
--
-- The key is the signature rather than a Slack-provided event id because not every
-- interaction carries one, and because the signature is the only field the MAC
-- covers together with the body. Both digests are checked in code before a row is
-- written: a migration states structure, not behaviour. `body_digest` is stored beside it so a receipt can
-- be explained later without keeping the body, which may name a channel or a
-- person.
--
-- Rows are worthless after the freshness window: a request outside it is refused
-- before it reaches this table. They are purged by a periodic task rather than a
-- trigger, because a delete on every insert is a cost paid for nothing on a busy
-- workspace and a sweep can be as coarse as it likes.
create table bakery.slack_request_receipts (
  id uuid primary key default gen_random_uuid(),
  replay_key text not null,
  body_digest text not null,
  -- The timestamp Slack signed, in Unix seconds. Kept as the integer Slack sent
  -- rather than a derived time, so a receipt and a log line agree exactly.
  requested_at integer not null,
  team_id text,
  received_at timestamptz not null default now()
);

create unique index slack_request_receipts_replay_unique
  on bakery.slack_request_receipts (replay_key);

-- The purge reads oldest first; without this it is a sequential scan each sweep.
create index slack_request_receipts_received_idx
  on bakery.slack_request_receipts (received_at);

grant select, insert on bakery.slack_request_receipts to bakery_app;
-- The purge task is the database owner and deletes; the ingress only claims.
grant delete on bakery.slack_request_receipts to bakery_app;

comment on column bakery.slack_request_receipts.replay_key is
  'The v0 signature Slack sent, hex only: unique per (body, timestamp), so a replay collides.';
comment on column bakery.slack_request_receipts.body_digest is
  'SHA-256 of the exact signed bytes, so a receipt can be explained without keeping the body.';
