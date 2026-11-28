drop index bakery.skills_remote_source_path_unique;
create unique index skills_remote_source_path_unique
  on bakery.skills (
    organization_id, source_id, source_path, scope, owner_principal_id
  ) nulls not distinct
  where source_id is not null and source_path is not null;
