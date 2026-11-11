-- bakery:migration-mode: non-transactional
drop index concurrently if exists bakery.outbox_expired_lease_idx;
drop index concurrently if exists bakery.outbox_sending_dispatch_idx;
create index concurrently outbox_sending_dispatch_idx
  on bakery.outbox (lease_until, created_at, id)
  include (attempt_count, replay_deadline_at)
  where status = 'sending';
