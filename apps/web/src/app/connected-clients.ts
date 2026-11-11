import type { OrganizationRole } from "@bakery/contracts/contracts";
import type { MessageKey } from "@bakery/i18n";

/**
 * Data interface for OAuth consent. The grants list and revocation use the
 * typed `connectedClients.*` client (`api/client.ts`); consent talks to the
 * Better Auth provider endpoints, which are not part of the Bakery contract.
 */

/** The OAuth scopes the consent screen can show, as the server names them. */
export type ConsentScope = "bakery:read" | "bakery:operate" | "bakery:admin";

/** An organization the person may bind the consent to, with their role there. */
export type ConsentOrganization = {
  readonly id: string;
  readonly name: string;
  readonly role: OrganizationRole;
};

/** What the read-only `get-consent` answers for the pending request. */
export type ConsentRequest = {
  readonly clientName: string;
  readonly scopes: readonly string[];
  readonly organizations: readonly ConsentOrganization[];
  /** The organization the person already chose for this flow, if any. */
  readonly selectedOrganizationId: string | null;
};

export type ConsentGateway = {
  /** Read-only `get-consent`; never the delete or update consent paths. */
  readonly get: (signal?: AbortSignal) => Promise<ConsentRequest>;
  /** `/api/auth/bakery/oauth/select-organization`: binds one organization. */
  readonly selectOrganization: (organizationId: string) => Promise<void>;
  /** `POST /oauth2/consent` with `accept` set to the person's choice. */
  readonly respond: (accept: boolean) => Promise<void>;
};

/** The scope rows the consent and clients screens know how to word. */
const SCOPE_COPY: Readonly<
  Record<ConsentScope, { title: MessageKey; description: MessageKey }>
> = {
  "bakery:read": {
    title: "auth.consent.scope.read.title",
    description: "auth.consent.scope.read.description",
  },
  "bakery:operate": {
    title: "auth.consent.scope.operate.title",
    description: "auth.consent.scope.operate.description",
  },
  "bakery:admin": {
    title: "auth.consent.scope.admin.title",
    description: "auth.consent.scope.admin.description",
  },
};

/** Copy keys for a scope, or `null` for one the screens cannot word. */
export function scopeCopy(
  scope: string,
): { title: MessageKey; description: MessageKey } | null {
  return Object.hasOwn(SCOPE_COPY, scope)
    ? SCOPE_COPY[scope as ConsentScope]
    : null;
}

/**
 * Grants keep the server's newest-first order; a grant with no wordable
 * scope still lists, so the person can always revoke it.
 */
export function wordableScopes(
  scopes: readonly string[],
): readonly MessageKey[] {
  return scopes.flatMap((scope) => {
    const copy = scopeCopy(scope);
    return copy === null ? [] : [copy.title];
  });
}
