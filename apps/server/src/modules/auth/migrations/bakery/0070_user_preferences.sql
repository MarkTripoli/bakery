-- Private organization-specific presentation state for one person: theme and
-- time zone. The account-wide language lives in bakery.principals.preferred_locale.
create table bakery.user_preferences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  principal_id uuid not null,
  preferences jsonb not null,
  cas_version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_preferences_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint user_preferences_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint user_preferences_organization_principal_unique
    unique (organization_id, principal_id),
  constraint user_preferences_organization_id_unique
    unique (organization_id, id)
);

grant select, insert, update on bakery.user_preferences to bakery_app;
