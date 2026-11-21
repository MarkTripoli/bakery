-- Direct access to one document (chapter 24, #73 revision 3). A person with no
-- role access to a document can be given it by a mention: one row per person per
-- document, created or renewed in the same transaction as the comment that names
-- them, ended by an explicit version-checked revoke.
--
-- level is "read_comment" (read the document and comment on it) or "edit" (also
-- publish new versions). The two values are owned by TypeScript, like the other
-- closed vocabularies, not by a CHECK. Inherited access (an organization role)
-- never has a row here, so revoking a grant can never remove that. Repeated
-- provenance (granted again after a revoke) lives in audit_events; this row
-- holds the current grant and who gave it.
create table bakery.artifact_access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  artifact_id uuid not null,
  principal_id uuid not null,
  level text not null,
  granted_by uuid not null,
  source_comment_id uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  version integer not null default 1,
  constraint artifact_access_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint artifact_access_grants_artifact_fk
    foreign key (organization_id, artifact_id)
    references bakery.artifacts (organization_id, id) on delete cascade,
  constraint artifact_access_grants_principal_fk
    foreign key (principal_id)
    references bakery.principals (id) on delete cascade,
  constraint artifact_access_grants_granted_by_fk
    foreign key (granted_by)
    references bakery.principals (id) on delete restrict,
  constraint artifact_access_grants_revoked_by_fk
    foreign key (revoked_by)
    references bakery.principals (id) on delete restrict,
  constraint artifact_access_grants_comment_fk
    foreign key (organization_id, source_comment_id)
    references bakery.artifact_comments (organization_id, id),
  constraint artifact_access_grants_one_per_principal
    unique (organization_id, artifact_id, principal_id),
  constraint artifact_access_grants_organization_id_unique
    unique (organization_id, id)
);

-- The authority check reads "does this principal hold a live grant on this
-- document"; the unique key above already serves it.
grant select, insert on bakery.artifact_access_grants to bakery_app;
grant update (level, granted_by, source_comment_id, granted_at, revoked_at,
  revoked_by, version)
  on bakery.artifact_access_grants to bakery_app;

-- Revoking a grant withdraws the person's unread mention notifications for that
-- document, so the Undo leaves nothing in their inbox that points at it. That is
-- a delete of unread rows by the revoke handler and nothing else.
grant delete on bakery.notifications to bakery_app;
