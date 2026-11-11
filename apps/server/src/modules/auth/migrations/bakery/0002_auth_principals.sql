create table bakery.principals (
  id uuid primary key default gen_random_uuid(),
  provider_user_id uuid unique references public."user" (id) on delete restrict,
  display_name text not null check (btrim(display_name) <> ''),
  principal_type text not null check (principal_type in ('human', 'service', 'worker')),
  disabled_at timestamptz,
  constraint principals_provider_user_scope check (
    (principal_type = 'human' and provider_user_id is not null) or
    (principal_type <> 'human' and provider_user_id is null)
  )
);
grant select, insert, update on bakery.principals to bakery_app;
