import type { BakeryApiClient, OrganizationAccess } from "../api/client.ts";
import type { QueryScopeController } from "./query-scope.ts";

export const ORGANIZATION_PREFERENCE_KEY =
  "bakery.organization.lastSelected.v1";

export type OrganizationSelectionOutcome = "selected" | "choose";

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("ORGANIZATION_SELECTION_ABORTED");
}

/**
 * Resolves `localStorage` defensively: some embedding contexts (a sandboxed
 * iframe, third-party storage blocked) throw on the property access itself,
 * before any call reaches this module's own `try`/`catch` — the same
 * exposure `safeSessionStorage` (`auth-return.ts`) guards for its store.
 */
function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Forgets the last-selected organization; never touches session identity. */
export function clear(
  storage: Pick<Storage, "removeItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(ORGANIZATION_PREFERENCE_KEY);
  } catch {
    // Best-effort: an unavailable store already has nothing to forget.
  }
}

/** The organization remembered for this browser, if any. */
export function remembered(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): string | null {
  try {
    return storage?.getItem(ORGANIZATION_PREFERENCE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** True when an organization was remembered for this browser. */
export function hasRemembered(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): boolean {
  return remembered(storage) !== null;
}

/** Persists the resolved organization so the next sign-in skips `"choose"`. */
export function remember(
  organizationId: string,
  storage: Pick<Storage, "setItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ORGANIZATION_PREFERENCE_KEY, organizationId);
  } catch {
    // Best-effort: an unavailable store already has nothing to remember into.
  }
}

/** Bounds how many cursor pages `resolve` walks looking for a remembered id. */
const MAX_RESOLVE_PAGES = 10;

/**
 * Picks the organization scope for this tab: the remembered id when it is
 * still a live membership — searched across every membership page, bounded
 * to `MAX_RESOLVE_PAGES` — the sole membership when the principal belongs
 * to exactly one organization in total, or `"choose"` when the caller must
 * ask the principal to pick one.
 *
 * A failed organizations request is not evidence that the principal needs to
 * choose. It is thrown to the caller so a temporary outage remains
 * recoverable and an auth or forbidden response keeps its classification.
 */
export async function resolve(
  api: BakeryApiClient,
  queryScope: QueryScopeController,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(),
  signal?: AbortSignal,
): Promise<OrganizationSelectionOutcome> {
  const initialScope = queryScope.getSnapshot();
  const assertCurrent = () => {
    throwIfAborted(signal);
    // A session reset or tenant switch can precede React effect cleanup.
    // Never publish memberships fetched for the scope that was replaced.
    if (queryScope.getSnapshot() !== initialScope) {
      throw new Error("ORGANIZATION_SELECTION_SUPERSEDED");
    }
  };
  let storedId: string | null = null;
  try {
    storedId = storage?.getItem(ORGANIZATION_PREFERENCE_KEY) ?? null;
  } catch {
    storedId = null;
  }

  let cursor: string | undefined;
  let totalMemberships = 0;
  let firstMembership: OrganizationAccess | null = null;
  let nextCursor: string | null = null;
  for (let page = 0; page < MAX_RESOLVE_PAGES; page += 1) {
    assertCurrent();
    const result = await api.listOrganizations(cursor, signal);
    assertCurrent();
    if (!result.ok) throw result.error;
    const memberships: readonly OrganizationAccess[] = result.data.items;
    if (totalMemberships === 0 && memberships.length > 0) {
      firstMembership = memberships[0];
    }
    totalMemberships += memberships.length;

    if (
      storedId !== null &&
      memberships.some((membership) => membership.id === storedId)
    ) {
      assertCurrent();
      queryScope.setIdentity(storedId);
      return "selected";
    }

    nextCursor = result.data.nextCursor;
    if (nextCursor === null) break;
    cursor = nextCursor;
  }

  if (totalMemberships === 1 && nextCursor === null && firstMembership) {
    assertCurrent();
    queryScope.setIdentity(firstMembership.id);
    remember(firstMembership.id, storage);
    return "selected";
  }
  return "choose";
}

/**
 * Handles a protected query's `AUTH_FORBIDDEN` Problem: forgets the stale
 * organization preference and drops the scoped identity so the next
 * `resolve` starts clean. Navigating to `/organizations?reason=forbidden`
 * stays the caller's job, since only a page holds the router's `navigate`.
 */
export function handleForbidden(queryScope: QueryScopeController): void {
  clear();
  queryScope.setIdentity(null);
}

/**
 * Restores the organization scope after a reload. A person who has to choose
 * is handed to `onChoose` (the page hook sends them to `/organizations`); a
 * `null` `onChoose` leaves them where they are, so shell chrome can restore a
 * remembered or sole organization without bouncing a multi-organization user.
 */
export async function restore(
  api: BakeryApiClient,
  queryScope: QueryScopeController,
  onChoose: (() => void) | null,
  signal?: AbortSignal,
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
): Promise<OrganizationSelectionOutcome> {
  const outcome = await resolve(api, queryScope, storage, signal);
  if (!signal?.aborted && outcome === "choose") onChoose?.();
  return outcome;
}
