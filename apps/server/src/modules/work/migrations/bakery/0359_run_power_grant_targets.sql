alter table bakery.run_power_grants
  alter column question_id drop not null,
  add column artifact_version_id uuid,
  add column run_step_id uuid,
  add constraint run_power_grants_artifact_version_fk
    foreign key (organization_id, artifact_version_id)
    references bakery.artifact_versions (organization_id, id)
    on delete cascade,
  add constraint run_power_grants_run_step_fk
    foreign key (organization_id, run_step_id)
    references bakery.run_steps (organization_id, id) on delete cascade;

drop index bakery.run_power_grants_live_unique;
create unique index run_power_grants_live_unique
  on bakery.run_power_grants (
    organization_id, principal_id, power,
    coalesce(question_id, artifact_version_id, run_step_id)
  )
  where revoked_at is null;
