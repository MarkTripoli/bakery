alter table bakery.usage_records
  add column reconciled_canonical_digest text,
  add column overrun_usd numeric(14,6) not null default 0;

grant insert (overrun_usd)
  on bakery.usage_records to bakery_app;
grant update (reconciled_canonical_digest, overrun_usd)
  on bakery.usage_records to bakery_app;
