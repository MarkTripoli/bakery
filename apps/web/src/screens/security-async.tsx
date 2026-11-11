import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import type { AsyncKind } from "../app/async-state.ts";
import { PERSONAL_SETTINGS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * The shared async states every security screen renders (design R12).
 * `loading`, `empty`, `error` and `forbidden` replace the screen body;
 * `conflict`, `stale`, `offline` and `reconnecting` put a notice above the
 * body so a draft survives. `offline` and `reconnecting` also tell the screen
 * to withhold its save action, so nothing is reported as saved.
 */
export type SecurityAsyncKind = AsyncKind;

/** True while the connection cannot confirm a change. */
export function isDisconnected(kind: SecurityAsyncKind | null): boolean {
  return kind === "offline" || kind === "reconnecting";
}

export type SecurityAsyncBoundaryProps = {
  readonly kind: SecurityAsyncKind | null;
  /** Copy for `empty`: what is missing on this screen. */
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  /** Optional `empty` action, e.g. "Add a passkey". */
  readonly emptyAction?: ReactNode;
  /** "Try again" on `error`. */
  readonly onRetry: () => void;
  /** "Reload" on `conflict`; the draft stays until the person reloads. */
  readonly onReload: () => void;
  /** "Refresh" on `stale`. */
  readonly onRefresh: () => void;
  readonly children: ReactNode;
};

/** Renders the async state around a screen body; `null` means ready. */
export function SecurityAsyncBoundary(
  {
    children,
    emptyAction,
    emptyDescription,
    emptyTitle,
    kind,
    onRefresh,
    onReload,
    onRetry,
  }: SecurityAsyncBoundaryProps,
) {
  const { translate } = useI18n();
  switch (kind) {
    case "loading":
      return (
        <UI.Stack
          aria-busy="true"
          data-testid="security-loading"
          gap="compact"
        >
          <UI.Text role="status" variant="muted">
            {translate("settings.async.loading")}
          </UI.Text>
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="row" />
        </UI.Stack>
      );
    case "empty":
      return (
        <UI.EmptyState
          action={emptyAction}
          data-testid="security-empty"
          description={emptyDescription}
          title={emptyTitle}
        />
      );
    case "error":
      return (
        <UI.ErrorState
          action={
            <UI.Button onClick={onRetry}>
              {translate("core.actions.retry")}
            </UI.Button>
          }
          data-testid="security-error"
          description={translate("settings.async.errorDescription")}
          title={translate("settings.async.errorTitle")}
          variant="region"
        />
      );
    case "forbidden":
      return (
        <UI.ErrorState
          action={
            <RouterLink to={PERSONAL_SETTINGS_PATH}>
              {translate("settings.async.forbiddenAction")}
            </RouterLink>
          }
          data-testid="security-forbidden"
          description={translate("settings.async.forbiddenDescription")}
          title={translate("settings.async.forbiddenTitle")}
          variant="region"
        />
      );
    case "conflict":
      return (
        <>
          <UI.InlineNotice
            action={
              <UI.Button onClick={onReload} variant="secondary">
                {translate("settings.async.reload")}
              </UI.Button>
            }
            data-testid="security-conflict"
            tone="warning"
          >
            {translate("settings.async.conflictNotice")}
          </UI.InlineNotice>
          {children}
        </>
      );
    case "stale":
      return (
        <>
          <UI.InlineNotice
            action={
              <UI.Button onClick={onRefresh} variant="secondary">
                {translate("settings.async.refresh")}
              </UI.Button>
            }
            data-testid="security-stale"
            tone="information"
          >
            {translate("settings.async.staleNotice")}
          </UI.InlineNotice>
          {children}
        </>
      );
    case "offline":
      return (
        <>
          <UI.InlineNotice data-testid="security-offline" tone="warning">
            {translate("settings.async.offlineNotice")}
          </UI.InlineNotice>
          {children}
        </>
      );
    case "reconnecting":
      return (
        <>
          <UI.InlineNotice
            data-testid="security-reconnecting"
            tone="information"
          >
            {translate("settings.async.reconnectingNotice")}
          </UI.InlineNotice>
          {children}
        </>
      );
    default:
      return <>{children}</>;
  }
}
