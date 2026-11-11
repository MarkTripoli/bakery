-- Issue #46: repository slugs are unique across every application in an
-- organization, including archived repositories. Legacy NULL slugs remain
-- nullable and are not backfilled.
alter table bakery.repositories
  add constraint repositories_organization_slug_unique
    unique (organization_id, slug);
