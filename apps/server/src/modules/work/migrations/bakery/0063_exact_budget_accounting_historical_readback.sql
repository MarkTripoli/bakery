alter table bakery.usage_records
  add column original_input_tokens bigint,
  add column original_output_tokens bigint,
  add column original_cost_usd numeric(14,6),
  add column original_measurement text,
  add column original_occurred_at timestamptz;

grant insert (
  original_input_tokens, original_output_tokens, original_cost_usd,
  original_measurement, original_occurred_at
) on bakery.usage_records to bakery_app;
