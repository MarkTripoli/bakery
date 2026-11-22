-- Who stopped a ticket request (#61): the request read looks up the latest
-- stop on one resource (the request's ticketRequests.cancel, or the cancel of
-- its run through runs.control). This index serves that lookup by resource,
-- newest first, and holds only the stop operations it reads.
create index audit_events_stop_resource_recent_idx
  on bakery.audit_events
    (organization_id, resource_type, resource_id, created_at desc, id desc)
  where operation in (
    'ticketRequests.cancel', 'runs.control', 'runs.control.agent'
  );
