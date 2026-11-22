-- #74 / #42: an import may make a Private skill, and a version records when it
-- was published and an optional label.
--
-- scope is organization (the default, every existing import) or personal; a
-- personal import is owned by the person who asked for it. The vocabulary and
-- the rule that a personal import has exactly one owner are validated in
-- TypeScript at the writer. Neither column is updatable by bakery_app: an
-- import's scope and owner are fixed when it is admitted.
alter table bakery.skill_imports
  add column scope text not null default 'organization',
  add column owner_principal_id uuid,
  add constraint skill_imports_owner_principal_fk
    foreign key (owner_principal_id) references bakery.principals (id)
    on delete restrict;

-- One import per source, revision and folder, now per scope and owner too, so a
-- person's private import never replays somebody else's run.
alter table bakery.skill_imports drop constraint skill_imports_identity_unique;
create unique index skill_imports_identity_unique
  on bakery.skill_imports (
    organization_id, source_id, requested_revision, source_path, scope,
    owner_principal_id
  ) nulls not distinct;

-- published_at is set by the writer when a version is published. Versions
-- published before this migration keep null: the boundary rail forbids a
-- data-changing backfill here, and the time is not derived from updated_at.
-- label is an optional name a person gives a version (for an archive imported
-- from a web address, whose version is its content digest).
alter table bakery.skill_versions
  add column published_at timestamptz,
  add column label text;

grant update (published_at, label) on bakery.skill_versions to bakery_app;
