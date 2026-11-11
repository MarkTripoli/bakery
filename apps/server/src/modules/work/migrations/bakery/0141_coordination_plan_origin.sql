-- Coordination plan origin: where the plan came from (ad hoc conversation,
-- saved workflow node or ticket). Origin labels a plan; it is excluded from the
-- plan and lane digests, so existing rows stay valid and read as ad hoc.
--
-- The origin document shape is validated in TypeScript by Zod
-- (CoordinationPlanOriginSchema); the PostgreSQL boundary rails forbid CHECK
-- constraints. The column is insert-only: bakery_app already holds the
-- table-level insert grant and only the status columns are updatable.
alter table bakery.coordination_plans
  add column origin jsonb not null default '{"kind":"ad_hoc"}'::jsonb;
