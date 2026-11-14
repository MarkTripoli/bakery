import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

export type RevokeClientScreenProps = {
  readonly async: SecurityAsyncKind | null;
  /** The client being revoked; named in the heading copy. */
  readonly clientName: string;
  /** The organization the grant is bound to; named beside the client. */
  readonly organizationName: string;
  /** The revocation is in flight. */
  readonly pending: boolean;
  /** The last attempt failed and may be retried. */
  readonly failed: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * Revoke-client confirmation presenter — V-0 `revoke-client`: the
 * heading naming the client and its organization, one notice (warning, or an
 * error after a failed attempt) and the Cancel / "Revoke access" pair.
 */
export function RevokeClientScreen(
  {
    async,
    clientName,
    failed,
    onCancel,
    onConfirm,
    onRefresh,
    onReload,
    onRetry,
    organizationName,
    pending,
  }: RevokeClientScreenProps,
) {
  const { translate } = useI18n();
  return (
    <UI.SettingsContent data-testid="revoke-client">
      <UI.FormContent>
        <UI.AuthHeading
          description={translate("auth.settings.clients.revoke.description", {
            client: clientName,
            organization: organizationName,
          })}
          title={translate("auth.settings.clients.revoke.title")}
        />
        <SecurityAsyncBoundary
          emptyDescription={translate("auth.settings.clients.emptyDescription")}
          emptyTitle={translate("auth.settings.clients.emptyTitle")}
          kind={async}
          onRefresh={onRefresh}
          onReload={onReload}
          onRetry={onRetry}
        >
          <UI.InlineNotice tone={failed ? "error" : "warning"}>
            {translate(
              failed
                ? "auth.settings.clients.revoke.failed"
                : "auth.settings.clients.revoke.warning",
            )}
          </UI.InlineNotice>
          <UI.Inline variant="actions">
            <UI.Button onClick={onCancel} variant="secondary">
              {translate("auth.settings.clients.revoke.cancel")}
            </UI.Button>
            <UI.Button
              data-testid="revoke-client-confirm"
              disabled={isDisconnected(async)}
              loading={pending}
              onClick={onConfirm}
              variant="destructive"
            >
              {pending
                ? translate("auth.common.pendingAction")
                : translate("auth.settings.clients.revoke.confirm")}
            </UI.Button>
          </UI.Inline>
        </SecurityAsyncBoundary>
      </UI.FormContent>
    </UI.SettingsContent>
  );
}
