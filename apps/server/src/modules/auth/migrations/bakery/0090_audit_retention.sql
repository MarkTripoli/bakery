-- Per-organization audit retention window. A null window (or no row) keeps
-- audit events forever. The range (30..3650 days) is validated by the
-- application contract.
create table bakery.audit_retention_settings (
  organization_id uuid primary key,
  retention_days integer,
  version integer not null default 1,
  updated_by_principal_id uuid,
  updated_at timestamptz not null default now(),
  constraint audit_retention_settings_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint audit_retention_settings_principal_fk
    foreign key (updated_by_principal_id)
    references bakery.principals (id) on delete set null
);

grant select, insert, update on bakery.audit_retention_settings to bakery_app;

-- The only way to delete audit rows. bakery_app keeps no direct delete on
-- bakery.audit_events; the function is owned by the migration owner and runs
-- with its rights. Only the ee retention job calls it, after an entitlement
-- check. A row is kept while a budget_release_evidence row names it as its
-- source_event_id (a restrict foreign key, so deleting it would fail anyway).
-- As defence in depth the cutoff may never be newer than 30 days, the smallest
-- retention window the contract allows, whatever the caller passes.
create function bakery.purge_audit_events(
  p_organization_id uuid,
  p_before timestamptz,
  p_max_rows integer
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, bakery, pg_temp
as $$
declare
  purged integer;
begin
  if p_before > now() - interval '30 days' then
    return 0;
  end if;
  with doomed as (
    select audit.id
    from bakery.audit_events as audit
    where audit.organization_id = p_organization_id
      and audit.created_at < p_before
      and not exists (
        select 1
        from bakery.budget_release_evidence as evidence
        where evidence.source_event_id = audit.id
      )
    order by audit.created_at, audit.id
    limit greatest(p_max_rows, 0)
    for update of audit skip locked
  )
  delete from bakery.audit_events as removed
  using doomed
  where removed.id = doomed.id;
  get diagnostics purged = row_count;
  return purged;
end;
$$;

revoke all on function bakery.purge_audit_events(uuid, timestamptz, integer)
  from public;
grant execute on function bakery.purge_audit_events(uuid, timestamptz, integer)
  to bakery_app;
