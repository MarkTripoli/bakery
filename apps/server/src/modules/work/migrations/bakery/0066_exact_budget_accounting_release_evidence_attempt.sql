alter table bakery.budget_release_evidence
  alter column attempt_id drop not null;

grant insert (
  organization_id, installation_reservation_id, job_id, attempt_id,
  effect_id, kind, digest, observed_at, version
) on bakery.budget_release_evidence to bakery_app;
