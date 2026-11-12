-- Verified links between an external identity and a Bakery member (issue #12,
-- Slack first). An installation proves a workspace; this row proves a person:
-- the Slack user who completed Sign in with Slack for this organization is this
-- principal. Only identifiers and times live here, never a token or other proof.
-- The identity is the workspace (identity_scope) plus the immutable user id
-- under one app, and no application grant covers those columns or the
-- organization, so a link cannot be repointed at another identity.
-- external_app_id is the provider's own app id: registrations for non-GitHub
-- apps arrive with the install flow, and the link must not wait for them.
-- The foreign key to the membership removes the link with the member, so
-- re-adding a person later restores nothing, as with their resource bindings.
-- A membership made inactive keeps its row; the application revokes those
-- links. Structure only: the active/revoked lifecycle, the member check and
-- the reasons are enforced in TypeScript.
create table bakery.external_identity_links (
  id uuid primary key,
  organization_id uuid not null,
  principal_id uuid not null,
  provider text not null,
  external_app_id text not null,
  identity_scope text not null,
  external_user_id text not null,
  verification_method text not null,
  verified_at timestamptz not null,
  state text not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint external_identity_links_identity_unique
    unique (organization_id, provider, external_app_id, identity_scope,
      external_user_id),
  constraint external_identity_links_organization_id_unique
    unique (organization_id, id),
  constraint external_identity_links_organization_fk
    foreign key (organization_id)
    references bakery.organizations (id) on delete cascade,
  -- Removing a member removes the links they held.
  constraint external_identity_links_membership_fk
    foreign key (organization_id, principal_id)
    references bakery.organization_memberships (organization_id, principal_id)
    on delete cascade,
  constraint external_identity_links_revoked_by_fk
    foreign key (revoked_by) references bakery.principals (id)
);

-- A member's live links, and the sweep for members who are no longer active.
create index external_identity_links_principal_active
  on bakery.external_identity_links (organization_id, principal_id)
  where state = 'active';

grant select, insert on bakery.external_identity_links to bakery_app;
grant update (principal_id, verification_method, verified_at, state, revoked_at,
  revoked_by, revoke_reason, updated_at, version)
  on bakery.external_identity_links to bakery_app;
