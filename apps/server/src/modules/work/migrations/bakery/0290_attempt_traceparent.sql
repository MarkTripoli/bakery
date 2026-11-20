-- GHI-739 slice 1b: the W3C span context of one attempt, as handed to its worker.
-- A claim mints a child of the run's own span (domain_events.traceparent, 0151),
-- and this column keeps it, so the events a later request emits for the attempt
-- (a renewal, a result, settled usage) join the same trace, and a retried attempt
-- can name the first attempt's span as a link. Identifiers and a sampling flag
-- only, never content. Null for an attempt claimed before this column existed.
alter table bakery.job_attempts add column traceparent text;

grant update (traceparent) on bakery.job_attempts to bakery_app;
