import { isPublicAuthPath, ORGANIZATIONS_PATH } from "./auth-paths.ts";
import type { OrganizationSelectionOutcome } from "./organization-selection.ts";

export const AUTH_RETURN_TO_KEY = "bakery.auth.returnTo.v1";

/**
 * Placeholder origin for environments without a real `location` (unit
 * tests). `isSameOriginPath`'s backslash/protocol-relative detection is
 * independent of which origin is used as the `URL` resolution base — only
 * the *shape* of the resolved origin relative to the base matters — so a
 * fixed placeholder here does not weaken the check in a real browser, where
 * the actual origin is used instead.
 */
const FALLBACK_ORIGIN = "https://bakery.invalid";

function currentOrigin(): string {
  try {
    return globalThis.location?.origin ?? FALLBACK_ORIGIN;
  } catch {
    return FALLBACK_ORIGIN;
  }
}

/**
 * Refuses anything that is not a same-document, same-origin path: absolute
 * URLs, protocol-relative targets (`//evil.example`), and the WHATWG
 * backslash-as-slash trick (`/\evil.example`, which browsers normalize to
 * `//evil.example` at any `location.assign`/`href` sink) all fail this check,
 * so a stored return path can never become an open redirect.
 */
function isSameOriginPath(target: string): boolean {
  if (!target.startsWith("/") || target.startsWith("//")) return false;
  const origin = currentOrigin();
  try {
    return new URL(target, origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Resolves `sessionStorage` defensively: some embedding contexts (a
 * sandboxed iframe, third-party-storage blocking) throw `SecurityError` on
 * the *property access* itself, before any call into the object can be
 * wrapped in a `try`/`catch`.
 */
export function safeSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export type ReturnToLocation = Readonly<{
  pathname: string;
  search: string;
  hash: string;
}>;

/**
 * Stores the requested deep link for the sign-in flow that owns
 * authentication. Absolute, protocol-relative, and cross-origin targets are
 * refused so a stored return path can never become an open redirect.
 */
export function rememberReturnTo(
  location: ReturnToLocation,
  storage: Pick<Storage, "setItem"> | null,
): string | null {
  if (!storage) return null;
  const target = `${location.pathname}${location.search}${location.hash}`;
  if (!isSameOriginPath(target)) return null;
  try {
    storage.setItem(AUTH_RETURN_TO_KEY, target);
  } catch {
    return null;
  }
  return target;
}

export function rememberCurrentReturnTo(): string | null {
  // The organization picker is an intermediate destination. A protected
  // request there must not replace the deep link it was opened to resolve.
  if (globalThis.location.pathname === ORGANIZATIONS_PATH) {
    const pending = peekReturnTo();
    if (pending !== null && pending !== ORGANIZATIONS_PATH) return pending;
  }
  return rememberReturnTo(globalThis.location, safeSessionStorage());
}

/**
 * Remembers a `beforeLoad` destination — TanStack Router's `ParsedLocation`
 * shape, whose `hash` excludes the leading `#` (unlike browser
 * `Location.hash`, which `rememberCurrentReturnTo` reads instead) — as the
 * deep link the sign-in flow returns to. Takes the router's `beforeLoad`
 * `location` as an argument rather than reading `globalThis.location`
 * internally: `location` is the router's authoritative navigation target
 * regardless of when the History API flushes it to `globalThis.location`,
 * and taking it as a parameter keeps this function pure and unit-testable
 * without a browser.
 */
export function rememberDestination(
  location: Readonly<{ pathname: string; searchStr: string; hash: string }>,
  storage: Pick<Storage, "setItem"> | null = safeSessionStorage(),
): string | null {
  if (
    location.pathname === ORGANIZATIONS_PATH && storage &&
    "getItem" in storage && typeof storage.getItem === "function"
  ) {
    const pending = peekReturnTo(storage as Pick<Storage, "getItem">);
    if (pending !== null && pending !== ORGANIZATIONS_PATH) return pending;
  }
  return rememberReturnTo(
    {
      pathname: location.pathname,
      search: location.searchStr,
      hash: location.hash ? `#${location.hash}` : "",
    },
    storage,
  );
}

/**
 * Consumes the deep link stored by `rememberReturnTo`: reads it, validates it
 * is still a same-origin, non-protocol-relative target, and removes the key
 * either way so a corrupted or already-used entry never lingers. One-shot:
 * a second call for the same sign-in returns `null`.
 */
export function consumeReturnTo(
  storage: Pick<Storage, "getItem" | "removeItem"> | null =
    safeSessionStorage(),
): string | null {
  if (!storage) return null;
  let target: string | null;
  try {
    target = storage.getItem(AUTH_RETURN_TO_KEY);
  } catch {
    return null;
  }
  try {
    storage.removeItem(AUTH_RETURN_TO_KEY);
  } catch {
    // The value is one-shot regardless of whether removal itself succeeds.
  }
  if (!target || !isSameOriginPath(target)) return null;
  return target;
}

/**
 * Reads the deep link stored by `rememberReturnTo` without consuming it:
 * same validation as `consumeReturnTo`, but the entry survives the call so a
 * caller can inspect it before deciding whether this sign-in gets to use it.
 * `postSignInDestination` is the only caller today.
 */
export function peekReturnTo(
  storage: Pick<Storage, "getItem"> | null = safeSessionStorage(),
): string | null {
  if (!storage) return null;
  let target: string | null;
  try {
    target = storage.getItem(AUTH_RETURN_TO_KEY);
  } catch {
    return null;
  }
  if (!target || !isSameOriginPath(target)) return null;
  return target;
}

/**
 * Decides where a just-authenticated tab lands, once `session.refresh()`
 * and `organizationSelection.resolve()` have both settled. A stored deep
 * link into a public auth route (an `/invitations/:id` link most notably —
 * `SignUpPage`'s "Sign in" button remembers exactly this for a freshly
 * invited, zero-membership principal) needs no organization and always
 * wins, regardless of `outcome`: the principal goes straight there instead
 * of the empty, dead-end `/organizations` chooser. Otherwise `"choose"`
 * sends the principal to `/organizations` — leaving the deep link stored,
 * since `OrganizationsPage` consumes it once an organization is picked —
 * and anything else falls through to the deep link (if any) or `"/"`.
 */
export function postSignInDestination(
  { outcome, storage = safeSessionStorage() }: {
    readonly outcome: OrganizationSelectionOutcome;
    readonly storage?: Pick<Storage, "getItem" | "removeItem"> | null;
  },
): string {
  const pending = peekReturnTo(storage);
  if (pending !== null) {
    const pathname = new URL(pending, currentOrigin()).pathname;
    if (isPublicAuthPath(pathname)) {
      consumeReturnTo(storage);
      return pending;
    }
  }
  if (outcome === "choose") return ORGANIZATIONS_PATH;
  return consumeReturnTo(storage) ?? "/";
}
