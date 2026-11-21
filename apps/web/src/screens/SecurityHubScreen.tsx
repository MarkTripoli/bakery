import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import {
  CONNECTED_CLIENTS_PATH,
  PASSKEYS_SETTINGS_PATH,
  PASSWORD_SETTINGS_PATH,
  SESSIONS_SETTINGS_PATH,
  TWO_FACTOR_SETTINGS_PATH,
} from "../app/auth-paths.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { LinkedSlackRow, type LinkedSlackState } from "./linked-slack-row.tsx";
import {
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

export type SecurityHubScreenProps = {
  readonly displayName: string;
  readonly email: string;
  readonly passkeyCount: number;
  readonly twoFactorEnabled: boolean;
  /** Unused backup codes; only shown while two-factor is on. */
  readonly backupCodesRemaining: number;
  /** Opens with "Your identity was confirmed." after re-authentication. */
  readonly confirmed: boolean;
  /** Shared async state; `null` renders the settled screen. */
  readonly async: SecurityAsyncKind | null;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
  /**
   * The Slack row's state. Absent when the page has not asked, in which case the
   * section is not shown at all - a row that cannot answer is worse than no row.
   */
  readonly slackLink?: SlackLinkSection;
  readonly onLinkSlack?: () => void;
};

/** What the Linked accounts section needs from the page that owns the query. */
export type SlackLinkSection = {
  readonly organizationName: string;
  readonly state: LinkedSlackState;
  readonly workspace?: string;
  readonly banner?: Parameters<typeof LinkedSlackRow>[0]["banner"];
  readonly linking?: boolean;
  readonly onTryAgain: () => void;
  readonly onUnlink: () => void;
};

/**
 * The account-and-security hub: who you are, then one list of the ways you
 * sign in and where you are signed in (password, passkeys, two-factor, active
 * sessions, connected apps). Each row is the control, with an arrow showing it
 * opens; two-factor, while off, offers its own "Turn on" button. Signing out
 * lives in the account menu.
 */
export function SecurityHubScreen(
  {
    async,
    backupCodesRemaining,
    confirmed,
    displayName,
    email,
    onRefresh,
    onReload,
    onRetry,
    passkeyCount,
    slackLink,
    onLinkSlack,
    twoFactorEnabled,
  }: SecurityHubScreenProps,
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const SecurityRow = (
    { description, icon, label, title, to }: {
      readonly description: string;
      readonly icon: "lock" | "key" | "computer" | "plug" | "shield";
      readonly label: string;
      readonly title: string;
      readonly to: string;
    },
  ) => (
    <UI.DescriptionItem
      action={<UI.IconGlyph name="arrow" size="large" />}
      aria-label={label}
      description={description}
      icon={<UI.IconGlyph name={icon} size="large" />}
      onSelect={() => void navigate({ to })}
      title={title}
    />
  );
  return (
    <UI.SettingsContent data-testid="security-hub">
      <UI.AuthHeading
        description={translate("auth.settings.security.description")}
        title={translate("auth.settings.security.title")}
      />
      <SecurityAsyncBoundary
        emptyDescription={translate("settings.security.emptyDescription")}
        emptyTitle={translate("settings.security.emptyTitle")}
        kind={async}
        onRefresh={onRefresh}
        onReload={onReload}
        onRetry={onRetry}
      >
        {confirmed
          ? (
            <UI.InlineNotice tone="success">
              {translate("auth.settings.security.identityConfirmed")}
            </UI.InlineNotice>
          )
          : null}
        <UI.DescriptionItem
          description={email}
          icon={<UI.IconGlyph name="person" size="large" />}
          title={displayName}
        />
        <div>
          <SecurityRow
            description={translate("settings.security.passwordDescription")}
            icon="lock"
            label={translate("settings.security.changePasswordAria")}
            title={translate("settings.security.passwordTitle")}
            to={PASSWORD_SETTINGS_PATH}
          />
          <SecurityRow
            description={passkeyCount === 0
              ? translate("settings.security.passkeysNone")
              : translate("settings.security.passkeysCount", {
                count: passkeyCount,
              })}
            icon="key"
            label={translate("settings.security.managePasskeysAria")}
            title={translate("settings.security.passkeysTitle")}
            to={PASSKEYS_SETTINGS_PATH}
          />
          {twoFactorEnabled
            ? (
              <SecurityRow
                description={translate(
                  "auth.settings.security.twoFactorDescriptionOn",
                  { count: backupCodesRemaining },
                )}
                icon="shield"
                label={translate("settings.security.manageTwoFactorAria")}
                title={translate("auth.settings.security.twoFactorTitle")}
                to={TWO_FACTOR_SETTINGS_PATH}
              />
            )
            : (
              <UI.DescriptionItem
                action={
                  <UI.Inline gap="compact">
                    <UI.Badge tone="neutral">
                      {translate("auth.settings.security.twoFactorOff")}
                    </UI.Badge>
                    <UI.Button
                      aria-label={translate(
                        "settings.security.setUpTwoFactorAria",
                      )}
                      onClick={() =>
                        void navigate({ to: TWO_FACTOR_SETTINGS_PATH })}
                      variant="secondary"
                    >
                      {translate("auth.settings.security.turnOn")}
                    </UI.Button>
                  </UI.Inline>
                }
                description={translate(
                  "auth.settings.security.twoFactorDescriptionOff",
                )}
                icon={<UI.IconGlyph name="shield" size="large" />}
                title={translate("auth.settings.security.twoFactorTitle")}
                titleStyle="item"
              />
            )}
          <SecurityRow
            description={translate(
              "auth.settings.security.activeSessionsDescription",
            )}
            icon="computer"
            label={translate("settings.security.manageSessionsAria")}
            title={translate("auth.sessions.title")}
            to={SESSIONS_SETTINGS_PATH}
          />
          <SecurityRow
            description={translate("settings.security.clientsDescription")}
            icon="plug"
            label={translate("settings.security.manageClientsAria")}
            title={translate("auth.settings.clients.title")}
            to={CONNECTED_CLIENTS_PATH}
          />
        </div>
        {slackLink === undefined ? null : (
          <LinkedSlackRow
            banner={slackLink.banner}
            linking={slackLink.linking}
            onLink={onLinkSlack ?? (() => {})}
            onTryAgain={slackLink.onTryAgain}
            onUnlink={slackLink.onUnlink}
            organizationName={slackLink.organizationName}
            state={slackLink.state}
            workspace={slackLink.workspace}
          />
        )}
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}
