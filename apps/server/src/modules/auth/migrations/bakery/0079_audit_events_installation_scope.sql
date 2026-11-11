-- Installation-level and user-level mutations (settings, licence, administrator
-- grants, password, passkey and two-factor changes) have no organization, so
-- their audit rows carry a null organization_id. The organization FK still
-- cascades for rows that have one.
alter table bakery.audit_events
  alter column organization_id drop not null;

create index audit_events_organization_recent_idx
  on bakery.audit_events (organization_id, created_at desc, id desc);

create index audit_events_installation_recent_idx
  on bakery.audit_events (created_at desc, id desc)
  where organization_id is null;
