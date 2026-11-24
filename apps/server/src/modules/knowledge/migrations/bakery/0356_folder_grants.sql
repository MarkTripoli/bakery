alter table bakery.storage_entries
  add column restricted boolean not null default false;

create index storage_entries_restricted_idx
  on bakery.storage_entries (organization_id, id)
  where restricted;

create table bakery.storage_folder_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  folder_id uuid not null,
  principal_id uuid not null,
  level text not null,
  granted_by uuid not null,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint storage_folder_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint storage_folder_grants_folder_fk
    foreign key (organization_id, folder_id)
    references bakery.storage_entries (organization_id, id) on delete cascade,
  constraint storage_folder_grants_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint storage_folder_grants_granted_by_fk
    foreign key (granted_by)
    references bakery.principals (id) on delete restrict
);

create unique index storage_folder_grants_live_unique
  on bakery.storage_folder_grants (organization_id, folder_id, principal_id)
  where revoked_at is null;
create index storage_folder_grants_principal_idx
  on bakery.storage_folder_grants (organization_id, principal_id)
  where revoked_at is null;

grant select, insert on bakery.storage_folder_grants to bakery_app;
grant update (level, revoked_at, revoked_by, version)
  on bakery.storage_folder_grants to bakery_app;
