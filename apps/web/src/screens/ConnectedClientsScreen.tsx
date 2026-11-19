import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

export type ConnectedClientRow = {
  readonly id: string;
  readonly clientName: string;
  readonly organizationName: string;
  /** The plain description of each scope, in grant order. */
  readonly scopes: readonly string[];
};

export type ConnectedClientsScreenProps = {
  readonly async: SecurityAsyncKind | null;
  readonly clients: readonly ConnectedClientRow[];
  /** A grant was just revoked, so the page opens with the notice. */
  readonly revoked: boolean;
  /** "Revoke access" on one row; opens the confirmation for that grant. */
  readonly onRevoke: (grantId: string) => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/settings/clients` presenter — V-0 `clients`: heading, the
 * optional "revoked" notice and one row per grant naming the client, its
 * organization and scopes, each with a Revoke access button that names both
 * for assistive technology. The `empty` async state is the "no clients"
 * notice.
 */
export function ConnectedClientsScreen(
  { async, clients, onRefresh, onReload, onRetry, onRevoke, revoked }:
    ConnectedClientsScreenProps,
) {
  const { translate } = useI18n();
  return (
    <UI.SettingsContent data-testid="connected-clients">
      <UI.AuthHeading
        description={translate("auth.settings.clients.description")}
        title={translate("auth.settings.clients.title")}
      />
      {revoked
        ? (
          <UI.InlineNotice tone="success">
            {translate("auth.settings.clients.revokedNotice")}
          </UI.InlineNotice>
        )
        : null}
      {async === "empty"
        ? (
          <UI.EmptyState
            data-testid="security-empty"
            description={translate("auth.settings.clients.emptyDescription")}
            title={translate("auth.settings.clients.emptyTitle")}
          />
        )
        : null}
      <SecurityAsyncBoundary
        emptyDescription={translate("auth.settings.clients.emptyDescription")}
        emptyTitle={translate("auth.settings.clients.emptyTitle")}
        kind={async === "empty" ? null : async}
        onRefresh={onRefresh}
        onReload={onReload}
        onRetry={onRetry}
      >
        {clients.length === 0 ? null : (
          <UI.DescriptionList>
            {clients.map((client) => (
              <UI.DescriptionItem
                // A phone puts the Revoke action on its own full-width line
                // under the grant, matching every other phone row.
                actionFill
                actionPlacement="below"
                action={
                  <UI.Button
                    aria-label={translate("auth.settings.clients.revokeNamed", {
                      client: client.clientName,
                      organization: client.organizationName,
                    })}
                    disabled={isDisconnected(async)}
                    onClick={() => onRevoke(client.id)}
                    variant="secondary"
                  >
                    {translate("auth.settings.clients.revoke")}
                  </UI.Button>
                }
                data-testid="clients-row"
                description={
                  <UI.Stack gap="tight">
                    <UI.Text variant="caption">
                      {client.organizationName}
                    </UI.Text>
                    {client.scopes.map((scope) => (
                      <UI.Text key={scope} variant="caption">{scope}</UI.Text>
                    ))}
                  </UI.Stack>
                }
                icon={<UI.IconGlyph name="terminal" size="large" />}
                key={client.id}
                title={client.clientName}
              />
            ))}
          </UI.DescriptionList>
        )}
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}
