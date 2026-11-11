import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { scopeCopy } from "../app/connected-clients.ts";
import type { ConsentOrganization } from "../app/connected-clients.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { useAuthBrandProps } from "./auth-brand.tsx";
import { isDisconnected } from "./security-async.tsx";

/**
 * Which V-0 `consent` artboard the screen shows. `default` asks; the other
 * three are the dead ends after the person (or the clock) decided.
 */
export type OAuthConsentState = "default" | "denied" | "success" | "expired";

/** The async states a consent request can be in; it has no draft to keep. */
export type OAuthConsentAsync =
  | "loading"
  | "error"
  | "forbidden"
  | "offline"
  | "reconnecting";

export type OAuthConsentScreenProps = {
  readonly state: OAuthConsentState;
  readonly async: OAuthConsentAsync | null;
  readonly clientName: string;
  /** Organizations the person may bind this grant to. */
  readonly organizations: readonly ConsentOrganization[];
  readonly selectedOrganizationId: string;
  /** Scopes the client asks for; ones the screen cannot word are not shown. */
  readonly scopes: readonly string[];
  /** A choice is being recorded. */
  readonly pending: boolean;
  /** Recording the last choice failed and may be retried. */
  readonly failed: boolean;
  readonly onSelectOrganization: (organizationId: string) => void;
  readonly onDeny: () => void;
  readonly onAllow: () => void;
  readonly onRetry: () => void;
  /** Dead-end action: back to the account security hub. */
  readonly onReturnToAccount: () => void;
  /** Dead-end action after a grant: the connected clients list. */
  readonly onReviewClients: () => void;
};

const ROLE_KEY: Readonly<Record<ConsentOrganization["role"], MessageKey>> = {
  admin: "auth.invitation.role.Admin",
  developer: "auth.invitation.role.Developer",
  viewer: "auth.invitation.role.Viewer",
  guest: "auth.invitation.role.Guest",
};

/**
 * `/oauth/consent` presenter — V-0 `consent` on Paper's `contextShell`: the
 * left column names the client and the chosen organization, the right asks
 * "Allow access to Bakery?" with the organization chooser, the requested
 * scopes and the Deny / "Allow access" pair. One organization is bound to
 * the grant; nothing here can widen it, so the note says what the client
 * cannot do.
 */
export function OAuthConsentScreen(props: OAuthConsentScreenProps) {
  const { translate } = useI18n();
  const brand = useAuthBrandProps();
  const {
    async,
    clientName,
    failed,
    onAllow,
    onDeny,
    onRetry,
    onReturnToAccount,
    onReviewClients,
    onSelectOrganization,
    organizations,
    pending,
    scopes,
    selectedOrganizationId,
    state,
  } = props;
  const selected = organizations.find((organization) =>
    organization.id === selectedOrganizationId
  );
  const organizationName = selected?.name ?? "";
  // A refused request keeps nothing about the client or organization on screen.
  const refused = async === "forbidden";

  const context = (
    <>
      <UI.IconGlyph name="plug" size="large" />
      <UI.Heading level="section">
        {translate("auth.consent.contextTitle")}
      </UI.Heading>
      <UI.Text variant="muted">
        {translate("auth.consent.contextDescription")}
      </UI.Text>
      {refused ? null : (
        <UI.DescriptionList>
          <UI.DescriptionItem
            description={translate("auth.consent.clientCaption")}
            icon={<UI.IconGlyph name="terminal" size="large" />}
            title={clientName}
          />
          {organizationName === "" ? null : (
            <UI.DescriptionItem
              description={translate("auth.consent.organizationCaption")}
              icon={<UI.IconGlyph name="building" size="large" />}
              title={organizationName}
            />
          )}
        </UI.DescriptionList>
      )}
      <UI.Text variant="hint">
        {translate("auth.consent.revokeHint")}
      </UI.Text>
    </>
  );

  if (state !== "default") {
    return (
      <UI.AuthEntry {...brand} context={context} variant="context">
        <UI.AuthHeading
          data-testid={`consent-${state}`}
          description={translate(
            state === "denied"
              ? "auth.consent.denied.description"
              : state === "success"
              ? "auth.consent.success.description"
              : "auth.consent.expired.description",
            { client: clientName, organization: organizationName },
          )}
          title={translate(
            state === "denied"
              ? "auth.consent.denied.title"
              : state === "success"
              ? "auth.consent.success.title"
              : "auth.consent.expired.title",
          )}
        />
        <UI.Button
          data-testid={`consent-${state}-action`}
          onClick={state === "success" ? onReviewClients : onReturnToAccount}
          variant="secondary"
        >
          {translate(
            state === "success"
              ? "auth.consent.reviewClients"
              : "auth.consent.returnToAccount",
          )}
        </UI.Button>
      </UI.AuthEntry>
    );
  }

  const items = scopes.flatMap((scope) => {
    const copy = scopeCopy(scope);
    return copy === null ? [] : [{
      id: scope,
      icon: scope === "bakery:read" ? "document" as const : "terminal" as const,
      title: translate(copy.title),
      description: translate(copy.description),
    }];
  });
  const body = async === "loading"
    ? (
      <UI.Stack aria-busy="true" data-testid="consent-loading" gap="compact">
        <UI.Text role="status" variant="muted">
          {translate("settings.async.loading")}
        </UI.Text>
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    )
    : async === "error"
    ? (
      <UI.ErrorState
        action={
          <UI.Button onClick={onRetry}>
            {translate("core.actions.retry")}
          </UI.Button>
        }
        data-testid="consent-error"
        description={translate("settings.async.errorDescription")}
        title={translate("settings.async.errorTitle")}
        variant="region"
      />
    )
    : async === "forbidden"
    ? (
      <UI.ErrorState
        data-testid="consent-forbidden"
        description={translate("settings.async.forbiddenDescription")}
        title={translate("settings.async.forbiddenTitle")}
        variant="region"
      />
    )
    : (
      <>
        {async === "offline"
          ? (
            <UI.InlineNotice data-testid="consent-offline" tone="warning">
              {translate("settings.async.offlineNotice")}
            </UI.InlineNotice>
          )
          : async === "reconnecting"
          ? (
            <UI.InlineNotice
              data-testid="consent-reconnecting"
              tone="information"
            >
              {translate("settings.async.reconnectingNotice")}
            </UI.InlineNotice>
          )
          : null}
        {failed
          ? (
            <UI.InlineNotice tone="error">
              {translate("auth.consent.failed")}
            </UI.InlineNotice>
          )
          : null}
        <UI.Stack gap="compact">
          <UI.Combobox
            disabled={pending}
            label={translate("auth.consent.organization")}
            name="organizationId"
            onChange={(event) => onSelectOrganization(event.target.value)}
            options={organizations.map((organization) => ({
              label: translate("auth.consent.organizationOption", {
                organization: organization.name,
                role: translate(ROLE_KEY[organization.role]),
              }),
              value: organization.id,
            }))}
            value={selectedOrganizationId}
          />
          <UI.Text variant="hint">
            {translate("auth.consent.organizationHint")}
          </UI.Text>
        </UI.Stack>
        <UI.CapabilityList
          aria-label={translate("auth.consent.scopesLabel")}
          items={items}
        />
        <UI.InlineNotice tone="information">
          {translate("auth.consent.limits")}
        </UI.InlineNotice>
        <UI.Inline variant="actions">
          <UI.Button
            data-testid="consent-deny"
            disabled={pending}
            onClick={onDeny}
            variant="secondary"
          >
            {translate("auth.consent.deny")}
          </UI.Button>
          <UI.Button
            data-testid="consent-allow"
            disabled={isDisconnected(async) || selected === undefined}
            loading={pending}
            onClick={onAllow}
          >
            {pending
              ? translate("auth.common.pendingAction")
              : translate("auth.consent.allow")}
          </UI.Button>
        </UI.Inline>
      </>
    );

  return (
    <UI.AuthEntry {...brand} context={context} variant="context">
      <UI.AuthHeading
        data-testid="consent-request"
        description={refused
          ? translate("auth.consent.refusedDescription")
          : translate("auth.consent.description", { client: clientName })}
        title={translate("auth.consent.title")}
      />
      {body}
    </UI.AuthEntry>
  );
}
