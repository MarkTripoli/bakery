alter table bakery.person_requests
  add column step_iteration integer;

drop index bakery.person_requests_open_unique;
create unique index person_requests_open_unique
  on bakery.person_requests (
    organization_id, run_id, recipient_id, intent, coalesce(step_key, ''),
    coalesce(step_iteration, -1),
    coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'open';
