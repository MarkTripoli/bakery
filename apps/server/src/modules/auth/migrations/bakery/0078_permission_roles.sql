-- Role validity (admin|developer|viewer|guest) is enforced by the application
-- (requireOrganizationRole and the contract enum); the PostgreSQL boundary
-- rail forbids new CHECK constraints, so the narrow role checks are dropped.
alter table bakery.organization_memberships
  drop constraint organization_memberships_role_supported;

alter table bakery.organization_invitations
  drop constraint organization_invitations_role_check;
