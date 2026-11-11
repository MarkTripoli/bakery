grant insert (created_at, updated_at, version)
  on bakery.usage_records to bakery_app;
grant update (occurred_at, reconciled_canonical_digest, overrun_usd)
  on bakery.usage_records to bakery_app;
