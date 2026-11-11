-- The app role may not update license_key directly (secret material; pinned by
-- tests/security/installation-license-write_test.ts). The licence action
-- writes it through this one narrow function, owned by the migration owner.
-- It checks the expected version itself and returns the new version, or null
-- when the version is stale, so the caller keeps one transaction with its
-- audit row.
create function bakery.set_installation_license(
  new_key text,
  expected_version integer,
  updater uuid
)
returns integer
language sql
security definer
set search_path = pg_catalog, bakery, pg_temp
as $$
  update bakery.installation_settings
     set license_key = new_key,
         version = version + 1,
         updated_by_principal_id = updater,
         updated_at = clock_timestamp()
   where id = true and version = expected_version
  returning version
$$;

revoke all on function bakery.set_installation_license(text, integer, uuid)
  from public;
grant execute on function bakery.set_installation_license(text, integer, uuid)
  to bakery_app;
