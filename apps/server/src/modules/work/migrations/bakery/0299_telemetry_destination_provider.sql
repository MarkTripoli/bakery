-- The provider a telemetry destination was added for (grafana, datadog,
-- honeycomb, ...), chosen in the Add destination chooser so the page can show
-- its mark. A label, never read back from the name or address. A row saved
-- before it existed has none and reads as its kind's default provider, so there
-- is nothing to backfill.
alter table bakery.telemetry_destinations add column provider text;
