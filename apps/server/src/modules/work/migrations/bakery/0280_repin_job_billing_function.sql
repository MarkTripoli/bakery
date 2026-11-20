-- The application role may not update a job's billing directly (pinned by
-- tests/security/...worker-registration-claims-and-journal_test.ts): the same role
-- serves the worker routes, so a column grant on `jobs.billing` would let any code on
-- that path rewrite what a job is billed to. 0265 granted it for route continuations
-- (#26); this takes it back and gives the one writer that needs it a narrow function,
-- owned by the migration owner, as 0080 does for the licence key.
--
-- A route continuation re-points a job's pin: the provider, model, billing route,
-- billing account and pricing snapshot, and nothing else. The function writes the new
-- billing to the job and to the billing inside its agent configuration, and it refuses
-- (returns false, writes nothing) any new billing that differs from the current one in
-- anything but those five fields. So the limits and every other part of a job's
-- billing stay out of reach of the application role even through this door.
revoke update (billing, agent_config) on bakery.jobs from bakery_app;

create function bakery.repin_job_billing(
  p_organization_id uuid,
  p_job_id uuid,
  p_billing jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, bakery, pg_temp
as $$
declare
  pin_fields constant text[] := array[
    'provider', 'model', 'billingRoute', 'billingAccountId',
    'pricingMetadataSnapshot'
  ];
  current_billing jsonb;
begin
  if p_billing is null or jsonb_typeof(p_billing) <> 'object' then
    return false;
  end if;
  select job.billing into current_billing
    from bakery.jobs as job
   where job.organization_id = p_organization_id and job.id = p_job_id
     for update;
  if not found or current_billing is null
     or jsonb_typeof(current_billing) <> 'object' then
    return false;
  end if;
  if (p_billing - pin_fields) is distinct from (current_billing - pin_fields) then
    return false;
  end if;
  update bakery.jobs
     set billing = p_billing,
         agent_config = jsonb_set(agent_config, '{billing}', p_billing),
         updated_at = clock_timestamp(),
         version = version + 1
   where organization_id = p_organization_id and id = p_job_id;
  return true;
end;
$$;

revoke all on function bakery.repin_job_billing(uuid, uuid, jsonb) from public;
grant execute on function bakery.repin_job_billing(uuid, uuid, jsonb)
  to bakery_app;
