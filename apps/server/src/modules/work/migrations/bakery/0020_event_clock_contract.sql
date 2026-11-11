alter table bakery.domain_events
  alter column organization_sequence set not null;

alter table bakery.domain_events
  add constraint domain_events_organization_sequence_unique
  unique using index domain_events_organization_sequence_unique_idx;
