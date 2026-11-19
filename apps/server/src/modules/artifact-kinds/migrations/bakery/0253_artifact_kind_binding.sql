-- An artifact names the kind version that governs its documents.
--
-- A kind's rules were evaluated by nothing: `validateArtifactKindDocument` had
-- tests and no caller, so "validation at publication" (chapter 25 section 6,
-- O6) was a promise the server never kept. Reaching the function needs an
-- answer to "which kind?", and until now there was no place to record it.
--
-- The binding sits on the artifact, not on the version, because a kind is a
-- property of the document a workflow declared - not of each revision. That
-- also closes the hole a per-version choice would open: a publisher that named
-- its own kind per publish could satisfy a weaker kind the second time, and the
-- version history would then read as if one document had two standards.
--
-- Nullable, and no backfill: every artifact that exists today was published
-- before rules ran, and inventing a kind for it would claim a check that never
-- happened. An artifact with no binding is validated by nothing, which is the
-- truth about it.
alter table bakery.artifacts
  add column kind_version_id uuid;

-- The target carries the organization, so a binding can never point at another
-- organization's kind version: a cross-tenant kind would let one tenant's rules
-- judge another tenant's document (O43).
alter table bakery.artifacts
  add constraint artifacts_kind_version_fk
    foreign key (organization_id, kind_version_id)
    references bakery.artifact_kind_versions (organization_id, id)
    on delete restrict;

-- Listing the artifacts a kind version governs is by kind version within one
-- organization, so the organization leads: the query is a lookup, not a scan of
-- every artifact in the tenant.
create index artifacts_kind_version_idx
  on bakery.artifacts (organization_id, kind_version_id)
  where kind_version_id is not null;
