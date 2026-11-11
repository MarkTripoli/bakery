import { normalizeEmail } from "./registration.ts";
import { OrganizationRole } from "./authorization.ts";
import { z } from "zod";

export const INSTALLATION_BOOTSTRAP_REPAIR_VERSION = 1;

export const BootstrapInstallationSchema = z.strictObject({
  principalId: z.uuid().nullable().describe(
    "Immutable owner-recorded bootstrap identity, or null before authenticated bootstrap.",
  ),
  repairVersion: z.number().int().positive().nullable().describe(
    "Completed owner bootstrap repair version, or null before bootstrap.",
  ),
  grantedByPrincipalId: z.uuid().nullable().describe(
    "Grant provenance for the recorded bootstrap identity; null before bootstrap.",
  ),
  revoked: z.boolean().describe(
    "Whether the recorded bootstrap grant is revoked; authenticated retries never reactivate it.",
  ),
}).describe(
  "Private installation bootstrap marker and live grant provenance, never a public settings projection.",
);
export type BootstrapInstallation = z.infer<typeof BootstrapInstallationSchema>;

export const personalOrganization = Object.freeze(
  {
    name: "Personal",
    slug: "personal",
  } as const,
);

export type BootstrapUser = { id: string; email: string; name: string };
export type BootstrapOrganization = {
  id: string;
  name: string;
  slug: string;
};
export type BootstrapMember = {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
};
export type BootstrapPrincipal = {
  id: string;
  providerUserId: string | null;
  principalType: string;
  disabled: boolean;
};

export type HumanPrincipalInput = {
  providerUserId: string;
  displayName: string;
};

export type BootstrapState = {
  users: BootstrapUser[];
  organizations: BootstrapOrganization[];
  members: BootstrapMember[];
  principals: BootstrapPrincipal[];
  installation: BootstrapInstallation;
};

export type BootstrapSnapshot = {
  user?: BootstrapState["users"][number];
  organization?: BootstrapState["organizations"][number];
  member?: BootstrapState["members"][number];
  principal?: BootstrapState["principals"][number];
  complete: boolean;
  identityComplete: boolean;
};

export function assessBootstrapState(
  state: BootstrapState,
  email: string,
): BootstrapSnapshot | null {
  const marker = state.installation;
  if (marker.principalId !== null) {
    const user = state.users[0];
    const principal = state.principals[0];
    if (
      state.users.length !== 1 || state.principals.length !== 1 ||
      !user || !principal || normalizeEmail(user.email) !== email ||
      !user.name.trim() || principal.id !== marker.principalId ||
      principal.providerUserId !== user.id ||
      principal.principalType !== "human" ||
      principal.disabled || marker.revoked ||
      marker.grantedByPrincipalId !== principal.id ||
      marker.repairVersion !== INSTALLATION_BOOTSTRAP_REPAIR_VERSION
    ) return null;
    return { user, principal, identityComplete: true, complete: true };
  }
  if (marker.repairVersion !== null || marker.grantedByPrincipalId !== null) {
    return null;
  }
  if (
    state.users.length > 1 || state.organizations.length > 1 ||
    state.members.length > 1 || state.principals.length > 1
  ) return null;

  const user = state.users[0];
  const organization = state.organizations[0];
  const member = state.members[0];
  const principal = state.principals[0];

  if (!user && (organization || member || principal)) return null;
  if (
    user && (normalizeEmail(user.email) !== email || !user.name.trim())
  ) {
    return null;
  }
  if (
    organization &&
    (organization.name !== personalOrganization.name ||
      organization.slug !== personalOrganization.slug)
  ) return null;
  if (
    member &&
    (!user || !organization || member.userId !== user.id ||
      member.organizationId !== organization.id ||
      member.role !== OrganizationRole.Admin)
  ) return null;
  if (
    principal &&
    (!user || principal.providerUserId !== user.id ||
      principal.principalType !== "human" || principal.disabled)
  ) return null;

  return {
    user,
    organization,
    member,
    principal,
    identityComplete: Boolean(user && organization && member && principal),
    complete: false,
  };
}
