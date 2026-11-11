-- bakery:migration-mode: non-transactional
drop index concurrently if exists bakery.domain_events_organization_id_replacement_uidx;
create unique index concurrently domain_events_organization_id_replacement_uidx
  on bakery.domain_events (organization_id, id);
drop index concurrently if exists bakery.outbox_organization_event_idx;
create index concurrently outbox_organization_event_idx
  on bakery.outbox (organization_id, event_id);
