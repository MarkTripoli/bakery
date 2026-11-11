import * as UI from "@bakery/ui";
import { SECURITY_SETTINGS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
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
  /** Already-worded scope titles, in grant order. */
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

function lowerFirst(text: string, locale: string): string {
  const [first = "", ...rest] = Array.from(text);
  return first.toLocaleLowerCase(locale) + rest.join("");
}

/**
 * `/settings/clients` presenter — V-0 `clients`: back link, heading, the
 * optional "revoked" notice and one row per grant naming the client, its
 * organization and scopes, each with a Revoke access button that names both
 * for assistive technology. The `empty` async state is the "no clients"
 * notice.
 */
export function ConnectedClientsScreen(
  { async, clients, onRefresh, onReload, onRetry, onRevoke, revoked }:
    ConnectedClientsScreenProps,
) {
  const { locale, translate } = useI18n();
  return (
    <UI.SettingsContent
      back={
        <RouterLink to={SECURITY_SETTINGS_PATH}>
          <UI.IconGlyph name="back" size="large" />
          {translate("auth.settings.security.title")}
        </RouterLink>
      }
      data-testid="connected-clients"
    >
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
          <UI.InlineNotice data-testid="security-empty" tone="neutral">
            {translate("auth.settings.clients.emptyNotice")}
          </UI.InlineNotice>
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
                description={translate("auth.settings.clients.grantCaption", {
                  organization: client.organizationName,
                  // The scope titles are sentence-cased for the consent rows;
                  // inside the caption only the first one opens the sentence
                  // (V-0 `clients`: "Read work and artifacts, start and steer
                  // tasks").
                  scopes: client.scopes
                    .map((scope, index) =>
                      index === 0 ? scope : lowerFirst(scope, locale)
                    )
                    .join(translate("auth.settings.clients.scopeSeparator")),
                })}
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
