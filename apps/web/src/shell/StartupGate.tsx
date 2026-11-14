import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { authProblemCode } from "../api/client.ts";
import { asyncKindForError } from "../app/async-state.ts";
import {
  ORGANIZATIONS_PATH,
  RECOVERY_CODE_PATH,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import { rememberDestination } from "../app/auth-return.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import {
  useProtectedScope,
  useQueryScopeController,
} from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

/** A fast start shows no skeleton: it appears only when the wait passes this. */
export const STARTUP_SKELETON_DELAY_MS = 200;
/** After this the skeleton says it is taking longer than usual. */
export const STARTUP_SLOW_AFTER_MS = 8_000;

/**
 * A page's content does not render until the app knows which organization the
 * person is in. A page drawn for a provisional scope may be wrong, and showing
 * it and then replacing it is the flash (and how edits are lost), so the
 * content area waits: nothing for a fast start, the page skeleton after
 * 200 ms, a slow line after 8 s, and an error with its way on when the
 * organization cannot be loaded. Once content has rendered it is never taken
 * back: a later reload updates it in place.
 */
export function StartupGate(
  { children, enabled, failure, onRetry, onSignOut, signOutHref }: {
    readonly children: ReactNode;
    /** False for routes that need no organization (installation, fixtures). */
    readonly enabled: boolean;
    /** The organization lookup's failure, or `null`. */
    readonly failure: unknown;
    readonly onRetry: () => void;
    readonly onSignOut: () => void;
    readonly signOutHref: string;
  },
) {
  const scope = useProtectedScope();
  const queryScope = useQueryScopeController();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const { translate } = useI18n();
  const resolved = !enabled || scope.organizationId !== null;
  // Content, then skeleton, then content never happens.
  const shown = useRef(false);
  if (resolved) shown.current = true;
  const [phase, setPhase] = useState<"quiet" | "skeleton" | "slow">("quiet");
  useEffect(() => {
    if (shown.current) return;
    setPhase("quiet");
    const skeleton = globalThis.setTimeout(
      () => setPhase("skeleton"),
      STARTUP_SKELETON_DELAY_MS,
    );
    const slow = globalThis.setTimeout(
      () => setPhase("slow"),
      STARTUP_SLOW_AFTER_MS,
    );
    return () => {
      globalThis.clearTimeout(skeleton);
      globalThis.clearTimeout(slow);
    };
  }, [resolved]);

  if (shown.current) return <>{children}</>;

  if (failure !== null && failure !== undefined) {
    const offline = asyncKindForError(failure) === "offline" ||
      (typeof navigator !== "undefined" && navigator.onLine === false);
    // A denial is told as one, with the way on: sign in, verify, or choose
    // another organization. The page the person wanted is remembered so they
    // come back to it. Anything else is the connection or the server.
    const code = authProblemCode(failure);
    const forbidden = code === "AUTH_FORBIDDEN";
    const authRequired = code !== null && !forbidden;
    const recover = (
      to:
        | typeof SIGN_IN_PATH
        | typeof TWO_FACTOR_PATH
        | typeof RECOVERY_CODE_PATH
        | typeof ORGANIZATIONS_PATH,
    ) => {
      // Only for the scope this denial was about.
      if (queryScope.getSnapshot() !== scope) return;
      rememberDestination(location);
      if (forbidden) organizationSelection.handleForbidden(queryScope);
      void navigate({
        to,
        ...(forbidden
          ? { search: { reason: "forbidden" } }
          : code === "AUTH_EXPIRED" || code === "AUTH_INVALID"
          ? { search: { reason: "expired" } }
          : {}),
      });
    };
    const action = forbidden
      ? (
        <UI.Button onClick={() => recover(ORGANIZATIONS_PATH)} type="button">
          {translate("auth.organizations.title")}
        </UI.Button>
      )
      : authRequired
      ? code === "AUTH_FACTOR_REQUIRED"
        ? (
          <UI.Inline gap="compact" variant="actions">
            <UI.Button onClick={() => recover(TWO_FACTOR_PATH)} type="button">
              {translate("auth.twoFactor.verify")}
            </UI.Button>
            <UI.Link
              href={RECOVERY_CODE_PATH}
              onClick={(event) => {
                event.preventDefault();
                recover(RECOVERY_CODE_PATH);
              }}
            >
              {translate("auth.twoFactor.useBackupCode")}
            </UI.Link>
          </UI.Inline>
        )
        : (
          <UI.Button onClick={() => recover(SIGN_IN_PATH)} type="button">
            {translate("auth.signIn.submit")}
          </UI.Button>
        )
      : (
        <UI.Inline gap="compact">
          <UI.Button onClick={onRetry} type="button" variant="secondary">
            {translate("core.actions.retry")}
          </UI.Button>
          {offline ? null : (
            <UI.Link
              href={signOutHref}
              onClick={(event) => {
                event.preventDefault();
                onSignOut();
              }}
            >
              {translate("core.actions.signOut")}
            </UI.Link>
          )}
        </UI.Inline>
      );
    return (
      <UI.ErrorState
        action={action}
        data-testid="startup-error"
        description={translate(
          forbidden
            ? "shell.states.forbiddenDescription"
            : authRequired
            ? "shell.states.authRequiredDescription"
            : offline
            ? "shell.startup.offline.body"
            : "shell.startup.organizationError.body",
        )}
        title={translate(
          forbidden
            ? "shell.states.forbiddenTitle"
            : authRequired
            ? "shell.states.authRequiredTitle"
            : offline
            ? "shell.startup.offline.title"
            : "shell.startup.organizationError.title",
        )}
        variant="region"
      />
    );
  }

  return (
    <div aria-busy="true" data-testid="startup-pending">
      {phase === "quiet"
        ? null
        : (
          <UI.Stack data-testid="startup-skeleton" gap="standard">
            <UI.Skeleton shape="text" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            {phase === "slow"
              ? (
                <UI.Text role="status" variant="muted">
                  {translate("shell.startup.slow")}
                </UI.Text>
              )
              : null}
          </UI.Stack>
        )}
    </div>
  );
}
