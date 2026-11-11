alter table bakery.principals
  add column preferred_locale text;
alter table bakery.organizations
  add column default_locale text not null default 'en';
