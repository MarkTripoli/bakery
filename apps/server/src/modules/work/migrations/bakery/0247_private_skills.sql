-- GHI-431 gives a skill an owner and a scope. global skills come with Bakery,
-- organization skills belong to one organization, and a personal skill
-- (shown as Private) belongs to one person and is visible to that person
-- only. Every existing skill stays an organization skill. Scope and owner are
-- immutable after insert, so no update privilege is granted on them.
alter table bakery.skills
  add column scope text not null default 'organization',
  add column owner_principal_id uuid,
  add constraint skills_scope_known
    check (scope in ('global', 'organization', 'personal')),
  add constraint skills_personal_has_owner
    check ((scope = 'personal') = (owner_principal_id is not null)),
  add constraint skills_owner_principal_fk
    foreign key (owner_principal_id) references bakery.principals (id)
    on delete restrict;

-- A personal slug is unique per owner, so creating one never reveals that
-- somebody else holds the same slug privately.
alter table bakery.skills drop constraint skills_slug_unique;
create unique index skills_shared_slug_unique
  on bakery.skills (organization_id, slug)
  where scope <> 'personal';
create unique index skills_personal_slug_unique
  on bakery.skills (organization_id, owner_principal_id, slug)
  where scope = 'personal';
