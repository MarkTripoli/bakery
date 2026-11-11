-- The compiler's pin for a published workflow version: the compiler version and
-- the semantic digest it returned for exactly the published definition. The
-- application sets both together or neither (a version the compiler did not
-- accept, such as a legacy flat document, carries no pin). Published versions
-- are immutable after insert, so a newer compiler never rewrites a pin and
-- whatever executes a version reads the plan it was published with.
-- Additive and nullable: rows published before this migration keep null.
alter table bakery.workflow_versions
  add column compiler_version text,
  add column semantic_digest text;
