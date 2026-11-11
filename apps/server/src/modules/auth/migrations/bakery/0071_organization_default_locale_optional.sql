-- An organization default language is an explicit administrator choice. Before
-- this migration the column defaulted every organization to 'en', which would
-- outrank a member's Accept-Language. Structure only: the data migration
-- 0071_clear_legacy_default_locale clears the stored legacy 'en' values.
alter table bakery.organizations
  alter column default_locale drop not null,
  alter column default_locale drop default;
