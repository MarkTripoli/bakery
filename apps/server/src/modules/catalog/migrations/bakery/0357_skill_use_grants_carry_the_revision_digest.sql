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

