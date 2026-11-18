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
-- There is deliberately no CHECK constraint here. The PostgreSQL boundary rail
-- forbids them, and 0172 dropped one for the same reason: a rule the kernel
-- branches on belongs in the described contract, where it can be named in an
-- error response, not in a constraint nobody can report. The invariant that
-- `catalog` origins carry a key and a version is therefore a property of the
-- one statement that writes these columns, and a test pins it.
--
-- Existing preset rows predate these columns and default to 'authored'. They
-- are not backfilled here, because migrations are structural only and a data
-- repair is not structure. The install path repairs them instead, once a preset
-- is used again - see ensurePresetWorkflowVersion, whose insert fills in an
-- origin that is still 'authored' and never rewrites one already set.
alter table bakery.workflow_definitions
  add column origin_kind text not null default 'authored',
  add column origin_catalog_key text,
  add column origin_catalog_version integer;
