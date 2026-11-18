-- Workflow origin provenance (issue #35, AC1).
--
-- A workflow definition is one of three things: authored in this organization,
-- installed from the code-owned catalog, or copied from another definition.
-- Until now the only marker was the `preset:` slug prefix, which encodes the
-- catalog identity inside a string a user can also type. That is not provenance:
-- it cannot be queried as a column, it cannot carry a catalog version, and a
-- copy would be indistinguishable from an install.
--
-- `origin_kind` is the discriminator AC2's copy needs. An installed definition
-- and a copied one must never be confused, because only the installed one is
-- system-managed and locked against edits.
--
-- The pairing constraint is structural rather than a business rule: a catalog
-- origin without a key and a version is not a catalog origin, so the three
-- columns cannot disagree. Immutability after install is enforced in code, not
-- here - the engineering rules forbid triggers, and a refusal has to be
-- nameable in an error response.
alter table bakery.workflow_definitions
  add column origin_kind text not null default 'authored',
  add column origin_catalog_key text,
  add column origin_catalog_version integer;

alter table bakery.workflow_definitions
  add constraint workflow_definitions_origin_kind_check
    check (origin_kind in ('authored', 'catalog', 'copy')),
  add constraint workflow_definitions_origin_catalog_pairing_check
    check (
      (origin_kind = 'catalog') =
      (origin_catalog_key is not null and origin_catalog_version is not null)
    );

-- Existing preset rows are catalog installs that predate the columns. The slug
-- is `preset:<id>`, so the key is the slug without its prefix. The version is
-- the preset revision the row's active version was materialized from; where no
-- active version exists the row was never installed and 1 is the only honest
-- value, since the catalog has no revision 0.
update bakery.workflow_definitions as definition
   set origin_kind = 'catalog',
       origin_catalog_key = substring(definition.slug from 8),
       origin_catalog_version = coalesce(
         (
           select version.revision
             from bakery.workflow_versions as version
            where version.organization_id = definition.organization_id
              and version.id = definition.active_version_id
         ),
         1
       )
 where definition.slug like 'preset:%';
