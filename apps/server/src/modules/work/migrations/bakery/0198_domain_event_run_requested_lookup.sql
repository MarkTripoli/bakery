-- Supports the claim's originating-trace and originating-principal lookups.
--
-- The claim candidate query and the attempt lifecycle query both resolve a job
-- back to the run that created it and read the run's `requested_by` and its
-- first `run.requested` event. That event lookup filters on exactly three
-- columns and orders by the event clock, so the index is written in that order:
-- a leading column the query does not filter on would make it useless.
--
-- No behaviour lives here. This is a lookup index on an append-only table, and
-- nothing about what may be read or written changes.
create index if not exists domain_events_run_requested_lookup_idx
  on bakery.domain_events (
    organization_id, aggregate_id, event_type, organization_sequence
  );
