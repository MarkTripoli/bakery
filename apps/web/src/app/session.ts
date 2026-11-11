import {
  authProblemCode,
  type BakeryApiClient,
  type PrincipalIdentity,
} from "../api/client.ts";
import type { QueryScopeController } from "./query-scope.ts";
import { clear as clearOrganizationSelection } from "./organization-selection.ts";
import { clearIssuedBackupCodes } from "./backup-codes-handoff.ts";

export type SessionStatus =
  | "unknown"
  | "anonymous"
  | "factor-pending"
  | "authenticated"
  | "expired"
  | "forbidden";

export type SessionSnapshot = Readonly<{
  status: SessionStatus;
  identity: PrincipalIdentity | null;
}>;
export type SessionRefreshFreshness = "fresh" | "indeterminate";

export type SessionContinuationResult = Readonly<{
  snapshot: SessionSnapshot;
  freshness: SessionRefreshFreshness;
}>;

const UNKNOWN_SNAPSHOT: SessionSnapshot = { status: "unknown", identity: null };

function sameIdentity(
  a: PrincipalIdentity | null,
  b: PrincipalIdentity | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.principalId === b.principalId &&
    a.principalType === b.principalType &&
    a.displayName === b.displayName &&
    a.locale === b.locale &&
    a.direction === b.direction &&
    a.catalogVersion === b.catalogVersion &&
    a.twoFactorEnabled === b.twoFactorEnabled &&
    a.email === b.email &&
    a.backupCodesRemaining === b.backupCodesRemaining;
}

/**
 * Tracks whether this tab is anonymous, mid-factor-challenge, authenticated,
 * expired, or forbidden, from the same `identity()` call every route guard
 * and page use. No credential material is ever held here: `identity` is the
 * server-projected `PrincipalIdentity`, and every other status carries none.
 */
export class SessionController {
  #snapshot: SessionSnapshot = UNKNOWN_SNAPSHOT;
  /** Last principal id seen as `authenticated`, kept across an intervening
   * non-authenticated status so a later sign-in under a *different*
   * principal — or a first sign-in after a tab whose earlier `identity()`
   * call only ever failed non-authentication (status stayed `unknown` or
   * moved straight to a non-authenticated status without ever publishing
   * `authenticated`) — is still detected as a change and resets the
   * protected scope. */
  #lastAuthenticatedPrincipalId: string | null = null;
  /** Bumped at the start of every `refresh()` and by `signOut()`, so a
   * superseded call's late response can recognise it lost the race and skip
   * publishing. */
  #epoch = 0;
  readonly #api: BakeryApiClient;
  readonly #queryScope: QueryScopeController;
  readonly #listeners = new Set<() => void>();

  constructor(api: BakeryApiClient, queryScope: QueryScopeController) {
    this.#api = api;
    this.#queryScope = queryScope;
  }

  readonly subscribe = (listener: () => void): () => void => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SessionSnapshot => this.#snapshot;

  /**
   * Reloads the session from `identity()` and republishes the snapshot.
   * Returns the current snapshot without publishing when this call has been
   * superseded by a later `refresh()`/`signOut()`, or when `signal` is
   * aborted (before the call or during it) — an abort or a stale response
   * carries no information about the actual session and must never overwrite
   * a newer or equally valid one.
   */
  async refresh(signal?: AbortSignal): Promise<SessionSnapshot> {
    return (await this.refreshForContinuation(signal)).snapshot;
  }

  /**
   * Refreshes the session once and reports whether the returned snapshot was
   * established by this identity response. An unclassified response keeps
   * the legacy snapshot unchanged, but continuation callers must not treat
   * that stale value as proof of the post-mutation session.
   */
  async refreshForContinuation(
    signal?: AbortSignal,
  ): Promise<SessionContinuationResult> {
    const epoch = ++this.#epoch;
    const result = await this.#api.identity(signal);
    if (signal?.aborted || epoch !== this.#epoch) {
      return { snapshot: this.#snapshot, freshness: "indeterminate" };
    }

    const previous = this.#snapshot;
    let next: SessionSnapshot;
    if (result.ok) {
      next = { status: "authenticated", identity: result.data };
    } else {
      switch (authProblemCode(result.error)) {
        case "AUTH_REQUIRED":
          next = { status: "anonymous", identity: null };
          break;
        case "AUTH_FACTOR_REQUIRED":
          next = { status: "factor-pending", identity: null };
          break;
        case "AUTH_INVALID":
        case "AUTH_EXPIRED":
          next = { status: "expired", identity: null };
          break;
        case "AUTH_FORBIDDEN":
          next = { status: "forbidden", identity: null };
          break;
        default:
          // Generic callers retain the last known snapshot, but a
          // post-mutation continuation must retry this refresh rather than
          // classify that stale snapshot as the new session.
          return { snapshot: previous, freshness: "indeterminate" };
      }
    }

    if (
      next.status === previous.status &&
      sameIdentity(next.identity, previous.identity)
    ) {
      return { snapshot: previous, freshness: "fresh" };
    }

    if (result.ok) {
      if (result.data.principalId !== this.#lastAuthenticatedPrincipalId) {
        this.#queryScope.reset();
        // A different person on this browser never inherits the previous
        // person's remembered organization. The first sign-in after a page
        // load has no prior principal and keeps the remembered choice.
        if (this.#lastAuthenticatedPrincipalId !== null) {
          clearOrganizationSelection();
        }
      }
      this.#lastAuthenticatedPrincipalId = result.data.principalId;
    } else if (previous.status !== "anonymous") {
      // Any transition into a non-authenticated status — except one already
      // starting from `anonymous`, which has nothing protected left to leak
      // — must drop the protected cache: a different principal signing in
      // next must never render a principal we merely lost track of (e.g.
      // `unknown` → `expired` with no intervening `authenticated`, where
      // `#lastAuthenticatedPrincipalId` was never set).
      this.#queryScope.reset();
    }

    this.#set(next);
    return { snapshot: this.#snapshot, freshness: "fresh" };
  }

  /**
   * Ends the local session: signs out with the provider (a failure there
   * never blocks clearing local state), drops every protected query and the
   * remembered organization, then republishes `anonymous`. The epoch bumps
   * both before and after the provider call, so neither a `refresh()`
   * already in flight nor one that starts *while the provider call is
   * pending* can win the race and republish a signed-out principal as
   * authenticated once its late response arrives.
   */
  async signOut(signal?: AbortSignal): Promise<void> {
    this.#epoch += 1;
    try {
      await this.#api.auth.signOut(signal);
    } catch {
      // The provider call is best-effort; the local session clears regardless.
    }
    this.#epoch += 1;
    this.#queryScope.reset();
    clearOrganizationSelection();
    // Freshly issued backup codes belong to the principal that signed out;
    // they never cross to the next sign-in in this tab.
    clearIssuedBackupCodes();
    this.#set({ status: "anonymous", identity: null });
  }

  #set(next: SessionSnapshot): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}
