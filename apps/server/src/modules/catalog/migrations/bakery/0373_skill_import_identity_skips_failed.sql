drop index bakery.skill_imports_identity_unique;
create unique index skill_imports_identity_unique
  on bakery.skill_imports (
    organization_id, source_id, requested_revision, source_path, scope,
    owner_principal_id
  ) nulls not distinct
  where state <> 'failed';
