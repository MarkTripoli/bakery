-- bakery:migration-mode: non-transactional
drop index concurrently if exists bakery.domain_events_pending_organization_sequence_idx;
