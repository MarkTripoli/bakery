import { type ReactNode, useEffect, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import { asyncKindForError } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
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
    return (
      <UI.ErrorState
        action={
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
        }
        data-testid="startup-error"
        description={translate(
          offline
            ? "shell.startup.offline.body"
            : "shell.startup.organizationError.body",
        )}
        title={translate(
          offline
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
