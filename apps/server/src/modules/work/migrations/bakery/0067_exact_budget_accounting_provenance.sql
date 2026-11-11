alter table bakery.usage_records
  add column provenance text not null default 'worker-unverified';

grant insert (provenance) on bakery.usage_records to bakery_app;
grant update (provenance) on bakery.usage_records to bakery_app;

alter table bakery.budget_release_evidence
  add column job_version integer,
  add column source_event_id uuid;

alter table bakery.budget_release_evidence
  add constraint budget_release_evidence_source_event_fk
  foreign key (source_event_id)
  references bakery.audit_events (id) on delete restrict;

grant insert (job_version, source_event_id)
  on bakery.budget_release_evidence to bakery_app;
