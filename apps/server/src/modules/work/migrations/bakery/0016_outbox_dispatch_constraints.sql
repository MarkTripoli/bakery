alter table bakery.domain_events
  add constraint domain_events_organization_id_unique
  unique using index domain_events_organization_id_replacement_uidx;

alter table bakery.outbox
  drop constraint outbox_event_fk,
  add constraint outbox_organization_event_fk
    foreign key (organization_id, event_id)
    references bakery.domain_events (organization_id, id)
    on delete restrict not valid;
