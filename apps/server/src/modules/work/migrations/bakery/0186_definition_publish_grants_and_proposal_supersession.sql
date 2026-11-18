-- Agent publish grants and superseded definition proposals (issue #421,
-- chapter 25 sections 11 and 18.2, O50 to O52).
--
-- Grants. An agent authors drafts by default; publishing a version and "Use
-- this version" are off by default and granted per definition or per seat
-- (O52). One row is one grant of the publish power:
--   definition_kind  workflow | agent | artifactKind | skill (TypeScript
--                    vocabulary, not a CHECK constraint: the PostgreSQL
--                    boundary rail forbids them);
--   definition_id    the immutable id of the definition the grant covers (a
--                    workflow, agent, skill or artifact kind row id, never an
--                    artifact kind's key, so a kind recreated under a reused
--                    key does not inherit the grant); null covers every
--                    definition of the kind, and the writer then requires a
--                    seat, so there is no organization-wide agent grant;
--   access_token_id  the seat (access token) the grant is limited to; null
--                    lets any agent acting on the named definition publish.
-- Only a person grants or revokes (O51: who holds authority). A revoke deletes
-- the row; the audit log keeps the grant and the revocation. A grant never
-- lets an agent decide a proposal, its own or another's (O51: nothing for
-- oneself), because the decision paths require a person regardless.
create table bakery.definition_publish_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  definition_kind text not null,
  definition_id uuid,
  access_token_id uuid,
  granted_by uuid not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  constraint definition_publish_grants_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  constraint definition_publish_grants_access_token_fk
    foreign key (access_token_id)
    references bakery.access_tokens (id) on delete cascade,
  constraint definition_publish_grants_granted_by_fk
    foreign key (granted_by)
    references bakery.principals (id) on delete restrict,
  constraint definition_publish_grants_organization_id_unique
    unique (organization_id, id)
);

-- One grant per (kind, definition, seat); the guard reads by kind and
-- definition, so this index serves both the uniqueness and the lookup.
create unique index definition_publish_grants_scope_idx
  on bakery.definition_publish_grants (
    organization_id,
    definition_kind,
    coalesce(definition_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(access_token_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

grant select, insert, delete on bakery.definition_publish_grants to bakery_app;

-- Superseded proposals. Publishing a workflow draft turns the draft row into
-- the immutable version and deletes the draft, so a proposal still waiting on
-- that draft can no longer be accepted. Publish settles each such proposal in
-- the same transaction: state superseded (a TypeScript vocabulary value) and
-- superseded_by_version_id naming the published version, with an audit row
-- and a domain event per proposal. Nothing vanishes and nothing waits forever.
-- The proposal content stays immutable. The foreign key nulls only its own
-- column, so an organization delete cascades in any order.
alter table bakery.workflow_definition_proposals
  add column superseded_by_version_id uuid,
  add constraint workflow_definition_proposals_superseded_by_fk
    foreign key (organization_id, superseded_by_version_id)
    references bakery.workflow_versions (organization_id, id)
    on delete set null (superseded_by_version_id);

grant update (superseded_by_version_id)
  on bakery.workflow_definition_proposals
  to bakery_app;
