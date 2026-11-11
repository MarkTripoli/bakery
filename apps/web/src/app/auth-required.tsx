import { useEffect } from "react";
import type { ReactNode } from "react";
import type {
  ErrorComponentProps,
  ParsedLocation,
} from "@tanstack/react-router";
import { redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { authProblemCode, RouteAuthProblem } from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { RouteError } from "../shell/AppLayout.tsx";
import type { SessionController } from "./session.ts";
import { rememberCurrentReturnTo, rememberDestination } from "./auth-return.ts";
import {
  isAuthEntryPath,
  ORGANIZATIONS_PATH,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "./auth-paths.ts";
import { handleForbidden } from "./organization-selection.ts";
import { useQueryScopeController } from "./query-scope-context.tsx";
import { useAuthBrandProps } from "../screens/auth-brand.tsx";

export { AUTH_RETURN_TO_KEY, rememberCurrentReturnTo } from "./auth-return.ts";
export {
  BACKUP_CODES_PATH,
  INVITATION_PATH,
  isAuthEntryPath,
  isPublicAuthPath,
  isSettingsPath,
  ORGANIZATION_SETTINGS_PATH,
  ORGANIZATIONS_PATH,
  RECOVERY_CODE_PATH,
  REGISTER_PATH,
  SECURITY_SETTINGS_PATH,
  SESSION_REVOKE_PATH,
  SESSIONS_SETTINGS_PATH,
  SETUP_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  TWO_FACTOR_DISABLE_PATH,
  TWO_FACTOR_PATH,
  TWO_FACTOR_SETTINGS_PATH,
  TWO_FACTOR_SETUP_PATH,
} from "./auth-paths.ts";

/**
 * `beforeLoad` guard for every protected route. Redirects an anonymous or
 * expired session to sign-in (remembering the requested deep link first), a
 * factor-pending session to the second-factor challenge (same deep link
 * kept), and raises `RouteAuthProblem("AUTH_FORBIDDEN")` for a forbidden
 * session so the route's `ProtectedRouteError` renders `ForbiddenState`.
 */
export function requireSession(
  session: SessionController,
  location: ParsedLocation,
): void {
  const { status } = session.getSnapshot();
  switch (status) {
    case "anonymous":
      rememberDestination(location);
      throw redirect({ to: SIGN_IN_PATH });
    case "expired":
      rememberDestination(location);
      throw redirect({ to: SIGN_IN_PATH, search: { reason: "expired" } });
    case "factor-pending":
      rememberDestination(location);
      throw redirect({ to: TWO_FACTOR_PATH });
    case "forbidden":
      throw new RouteAuthProblem("AUTH_FORBIDDEN");
    case "authenticated":
    case "unknown":
      // `unknown` only means this tab's first `identity()` call has not yet
      // resolved to a definite status for a non-auth reason (a transport
      // blip, an invalid response): every protected query still enforces
      // auth on the server, and `ProtectedRouteError` fails closed on the
      // 401 it gets back, so letting `unknown` through here cannot render
      // protected data to an unauthenticated visitor.
      return;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Renders sign-in-required copy for a 401 Problem and keeps the deep link. */
export function AuthRequiredNotice() {
  const { translate } = useI18n();
  return (
    <UI.ErrorState
      data-testid="auth-required"
      description={translate("problems.AUTH_REQUIRED.description")}
      title={translate("problems.AUTH_REQUIRED.title")}
      variant="page"
    />
  );
}

/** Renders second-factor-required copy while the effect navigates away. */
export function FactorRequiredNotice() {
  const { translate } = useI18n();
  return (
    <UI.ErrorState
      data-testid="auth-factor-required"
      description={translate("problems.AUTH_FACTOR_REQUIRED.description")}
      title={translate("problems.AUTH_FACTOR_REQUIRED.title")}
      variant="page"
    />
  );
}

/** Renders the forbidden-organization copy for an `AUTH_FORBIDDEN` Problem. */
export function ForbiddenState() {
  const { translate } = useI18n();
  return (
    <UI.ErrorState
      data-testid="forbidden-state"
      description={translate("problems.AUTH_FORBIDDEN.description")}
      title={translate("problems.AUTH_FORBIDDEN.title")}
      variant="page"
    />
  );
}

/**
 * Route-level boundary: maps an `AUTH_*` Problem thrown during load or render
 * to the same screen `requireSession` would have produced up front — a
 * forbidden session renders in place (navigating to `/organizations` unless
 * it is already the current route, since only a page there can still show
 * the picker), every other recognised session Problem navigates away. This
 * runs at render time, where `globalThis.location` is the destination the
 * principal actually asked for, so it uses `rememberCurrentReturnTo()`
 * directly rather than threading a `beforeLoad` location through. Any other
 * error keeps the generic `RouteError` boundary.
 */
export function ProtectedRouteError({ error, reset }: ErrorComponentProps) {
  const navigate = useNavigate();
  const queryScope = useQueryScopeController();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const code = authProblemCode(error);

  useEffect(() => {
    if (code === "AUTH_REQUIRED") {
      rememberCurrentReturnTo();
      void navigate({ to: SIGN_IN_PATH });
    } else if (code === "AUTH_INVALID" || code === "AUTH_EXPIRED") {
      rememberCurrentReturnTo();
      void navigate({ to: SIGN_IN_PATH, search: { reason: "expired" } });
    } else if (code === "AUTH_FACTOR_REQUIRED") {
      rememberCurrentReturnTo();
      void navigate({ to: TWO_FACTOR_PATH });
    } else if (code === "AUTH_FORBIDDEN" && pathname !== ORGANIZATIONS_PATH) {
      handleForbidden(queryScope);
      void navigate({
        to: ORGANIZATIONS_PATH,
        search: { reason: "forbidden" },
      });
    }
  }, [code, navigate, pathname, queryScope]);

  const notice = code === "AUTH_FORBIDDEN"
    ? <ForbiddenState />
    : code === "AUTH_REQUIRED" || code === "AUTH_INVALID" ||
        code === "AUTH_EXPIRED"
    ? <AuthRequiredNotice />
    : code === "AUTH_FACTOR_REQUIRED"
    ? <FactorRequiredNotice />
    : null;
  if (notice === null) return <RouteError error={error} reset={reset} />;
  // Entry-shell routes render outside AppShell (no <main> of their own), so
  // the notice takes the brand shell the route itself would have used.
  return isAuthEntryPath(pathname)
    ? <EntryShellNotice>{notice}</EntryShellNotice>
    : notice;
}

function EntryShellNotice({ children }: { readonly children: ReactNode }) {
  const brand = useAuthBrandProps();
  return (
    <UI.AuthEntry variant="brand" {...brand}>
      {children}
    </UI.AuthEntry>
  );
}
