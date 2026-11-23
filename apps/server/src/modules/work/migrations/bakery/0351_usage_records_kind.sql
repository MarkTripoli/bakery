-- The usage ledger accepts a compute kind beside model usage (chapter 25
-- section 8, O22). A compute record has no model and no provider call, so both
-- columns stop being required; the model path is the only writer today and it
-- always supplies both. No rule lives in the database.
alter table bakery.usage_records
  add column kind text not null default 'model';

alter table bakery.usage_records
  alter column model drop not null,
  alter column provider_call_id drop not null;

grant insert (kind) on bakery.usage_records to bakery_app;
