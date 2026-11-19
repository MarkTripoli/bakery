import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { SceneId } from "@bakery/ui";
import { authProblemCode } from "../api/client.ts";
import { asyncKindForError } from "../app/async-state.ts";
import {
  ORGANIZATIONS_PATH,
  RECOVERY_CODE_PATH,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import { focusAfterPaint } from "../app/focus.ts";
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

/** An information card for a refusal; focus lands on its title so it is read. */
function RefusalCard(
  { action, description, title, scene }: {
    readonly action: ReactNode;
    readonly description: string;
    readonly title: string;
    /**
     * The character scene for this refusal, when the whole content area has
     * nothing else to offer. "Choose another organization" is that moment;
     * "sign in" and "verify" are not, because the sign-in page the person is
     * about to reach carries the brand pane already.
     */
    readonly scene?: SceneId;
  },
) {
  useEffect(() => {
    focusAfterPaint(() =>
      document.querySelector<HTMLElement>(
        '[data-testid="startup-error"] :is(h1, h2, h3)',
      )
    );
  }, []);
  if (scene) {
    return (
      <UI.SceneState
        action={action}
        data-testid="startup-error"
        description={description}
        scene={scene}
        title={title}
      />
    );
  }
  return (
    <UI.EmptyState
      action={action}
      data-testid="startup-error"
      description={description}
      title={title}
      variant="firstUse"
    />
  );
}

/**
 * After a retry opens the gate, the card that held focus is gone. Puts focus on
 * the page's heading and keeps it there while the page swaps its loading
 * heading for its own (a frame at a time, for about a second), unless the
 * person has already moved focus somewhere else.
 */
function holdFocusOnHeading(frames = 60): void {
  let last: HTMLElement | null = null;
  const settle = () => {
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (!lost && active !== last) return;
    const heading = document.querySelector<HTMLElement>("main h1");
    if (heading !== null && heading !== last) {
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus();
      last = heading;
    }
    if (frames-- > 0) requestAnimationFrame(settle);
  };
  requestAnimationFrame(() => requestAnimationFrame(settle));
}

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

  // Where a failure card was shown. When a retry then gets through at that
  // same place, focus goes to the page's heading instead of being lost with
  // the card; at another place (the person moved on) it is left alone.
  const failedAt = useRef<string | null>(null);
  const showingFailure = !shown.current && failure !== null &&
    failure !== undefined;
  useEffect(() => {
    if (showingFailure) failedAt.current = location.href;
  }, [showingFailure, location.href]);
  useEffect(() => {
    if (!resolved || failedAt.current === null) return;
    const at = failedAt.current;
    failedAt.current = null;
    if (at === location.href) holdFocusOnHeading();
    // Only the moment the gate opens: later navigation is the page's own.
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
    const signOut = offline ? null : (
      <UI.Link
        href={signOutHref}
        onClick={(event) => {
          event.preventDefault();
          onSignOut();
        }}
      >
        {translate("core.actions.signOut")}
      </UI.Link>
    );
    // A refusal is not a failure: it is named for what it is, with its one
    // action, in an information card; only the connection and the server are
    // an error.
    if (authRequired || forbidden) {
      const factor = code === "AUTH_FACTOR_REQUIRED";
      const kind = forbidden ? "noAccess" : factor ? "verify" : "signedOut";
      return (
        <RefusalCard
          action={
            <UI.Inline gap="compact">
              <UI.Button
                onClick={() =>
                  recover(
                    forbidden
                      ? ORGANIZATIONS_PATH
                      : factor
                      ? TWO_FACTOR_PATH
                      : SIGN_IN_PATH,
                  )}
                type="button"
              >
                {translate(`shell.startup.${kind}.action` as never)}
              </UI.Button>
              {factor
                ? (
                  <UI.Link
                    href={RECOVERY_CODE_PATH}
                    onClick={(event) => {
                      event.preventDefault();
                      recover(RECOVERY_CODE_PATH);
                    }}
                  >
                    {translate("auth.twoFactor.useBackupCode")}
                  </UI.Link>
                )
                : null}
              {forbidden ? signOut : null}
            </UI.Inline>
          }
          description={translate(`shell.startup.${kind}.body` as never)}
          scene={forbidden ? "forbidden" : undefined}
          title={translate(`shell.startup.${kind}.title` as never)}
        />
      );
    }
    // Offline takes the character scene: the whole content area has one thing
    // to say and the person can do nothing else. A server that answered badly
    // keeps the plain region error, because the person may still have a page
    // to go back to and a scene would overstate how stuck they are.
    if (offline) {
      return (
        <UI.SceneState
          action={
            <UI.Inline gap="compact">
              <UI.Button onClick={onRetry} type="button" variant="secondary">
                {translate("core.actions.retry")}
              </UI.Button>
            </UI.Inline>
          }
          data-testid="startup-error"
          description={translate("shell.startup.offline.body")}
          scene="offline"
          title={translate("shell.startup.offline.title")}
        />
      );
    }
    return (
      <UI.ErrorState
        action={
          <UI.Inline gap="compact">
            <UI.Button onClick={onRetry} type="button" variant="secondary">
              {translate("core.actions.retry")}
            </UI.Button>
            {signOut}
          </UI.Inline>
        }
        data-testid="startup-error"
        description={translate("shell.startup.organizationError.body")}
        title={translate("shell.startup.organizationError.title")}
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
