-- The writer's W3C span context for a domain event, next to trace_id. trace_id
-- stays the run's correlation key, shared by every event of the run; this is
-- the span of the operation (or the engine step) that wrote the event, so the
-- work that reads the event later can continue or link to it. A version-00
-- traceparent: identifiers and a sampling flag, never content.
-- Additive and nullable: events written before this migration, and by writers
-- that do not carry a context yet, keep null. The table stays append-only and
-- the table-level insert grant already covers the column.
alter table bakery.domain_events
  add column traceparent text;
