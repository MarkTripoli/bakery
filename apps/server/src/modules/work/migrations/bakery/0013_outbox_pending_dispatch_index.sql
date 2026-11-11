-- bakery:migration-mode: non-transactional
drop index concurrently if exists bakery.outbox_pending_dispatch_idx;
create index concurrently outbox_pending_dispatch_idx
  on bakery.outbox (next_attempt_at, created_at, id)
  include (attempt_count, replay_deadline_at)
  where status = 'pending';
