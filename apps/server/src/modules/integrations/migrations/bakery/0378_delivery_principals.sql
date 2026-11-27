create table bakery.delivery_principals (
  organization_id uuid not null,
  purpose text not null,
  principal_id uuid not null,
  created_at timestamptz not null default now(),
  constraint delivery_principals_pkey primary key (organization_id, purpose),
  constraint delivery_principals_principal_unique unique (principal_id),
  constraint delivery_principals_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint delivery_principals_principal_fk
    foreign key (principal_id) references bakery.principals (id)
);

grant select, insert on bakery.delivery_principals to bakery_app;
