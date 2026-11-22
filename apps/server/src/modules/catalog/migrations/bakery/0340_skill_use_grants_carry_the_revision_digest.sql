-- A grant names the revision a person approved, not only a row.
--
-- The version id stays, because it is what the run admission joins on. What it
-- could not say is which published revision the owner was looking at and which
-- digest that revision had, so an installed binding and the page that shows it
-- were two different answers agreed by convention. Both are recorded here at
-- the moment of the grant, from the immutable version row, so a later reader
-- needs no second read to know what was agreed.
--
-- The digest is not recomputed: it is copied from the version, which is what
-- publication wrote. A check keeps it in the shape every other digest in the
-- system has, so a hand-written row cannot claim a digest that cannot exist.
alter table bakery.skill_use_grants
  add column revision integer,
  add column revision_digest text;

update bakery.skill_use_grants as grant_row
   set revision = version.revision,
       revision_digest = version.digest
  from bakery.skill_versions as version
 where version.organization_id = grant_row.organization_id
   and version.id = grant_row.skill_version_id;

alter table bakery.skill_use_grants
  alter column revision set not null,
  alter column revision_digest set not null,
  add constraint skill_use_grants_revision_positive
    check (revision > 0),
  add constraint skill_use_grants_revision_digest_shape
    check (revision_digest ~ '^sha256:[0-9a-f]{64}$');

comment on column bakery.skill_use_grants.revision is
  'Ordinal revision of the granted version, copied from the immutable version row when the owner granted it.';
comment on column bakery.skill_use_grants.revision_digest is
  'SHA-256 of the granted revision as publication wrote it, so a binding names the bytes a person approved.';

-- Every row has a version, so every row has a revision; a database that could
-- not fill one in is a database the update above failed on, and the not-null
-- constraints above refuse it rather than leave a grant that names nothing.
