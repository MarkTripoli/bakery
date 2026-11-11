import * as UI from "@bakery/ui";
import {
  SECURITY_SETTINGS_PATH,
  SESSION_REVOKE_PATH,
} from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export type OtherSession = {
  readonly id: string;
  /** Picks the row glyph; derived from the recorded user agent. */
  readonly device: "desktop" | "phone";
  /** The device label — the recorded user agent, or the "unknown" fallback. */
  readonly title: string;
  /** Already-formatted "Last active …" hint. */
  readonly description: string;
};

export type SessionsSettingsScreenProps = {
  readonly state: "loading" | "ready" | "error";
  /** `ready` only: every session other than this device's, newest first. */
  readonly others: readonly OtherSession[];
  /** A session was just signed out, so the page opens with the notice. */
  readonly revoked: boolean;
  /** Retries the session list query (`error`). */
  readonly onRetry: () => void;
  /** "Sign out all other sessions". */
  readonly onRevokeOthers: () => void;
};

/**
 * `/settings/sessions` presenter — Paper `sessions` (auth.js L188):
 * back link, heading, optional "signed out" notice, this device's row with
 * its `Current` badge, one row per other session with a Revoke link (or the
 * "no other sessions" notice), and the "Sign out all other sessions" button
 * (the artboard keeps it in the empty state too; confirming there is a no-op
 * the revoke page reports as such).
 */
export function SessionsSettingsScreen(
  { onRetry, onRevokeOthers, others, revoked, state }:
    SessionsSettingsScreenProps,
) {
  const { translate } = useI18n();
  return (
    <UI.SettingsContent
      back={
        <RouterLink to={SECURITY_SETTINGS_PATH}>
          <UI.IconGlyph name="back" size="large" />
          {translate("auth.settings.security.title")}
        </RouterLink>
      }
      data-testid="sessions-settings"
    >
      <UI.AuthHeading
        description={translate("auth.settings.sessions.description")}
        title={translate("auth.sessions.title")}
      />
      {revoked
        ? (
          <UI.InlineNotice tone="success">
            {translate("auth.sessions.revoked")}
          </UI.InlineNotice>
        )
        : null}
      {state === "loading"
        ? (
          <UI.Stack data-testid="sessions-loading" gap="compact">
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={onRetry}>
                {translate("core.actions.retry")}
              </UI.Button>
            }
            data-testid="sessions-error"
            description={translate("problems.UNKNOWN.description")}
            title={translate("shell.states.errorTitle")}
            variant="region"
          />
        )
        : (
          <>
            <UI.DescriptionItem
              action={
                <UI.Badge tone="success">
                  {translate("auth.sessions.current")}
                </UI.Badge>
              }
              data-testid="sessions-current"
              description={translate(
                "auth.settings.sessions.thisDeviceCaption",
              )}
              icon={<UI.IconGlyph name="computer" size="large" />}
              title={translate("auth.settings.sessions.thisDevice")}
            />
            {others.map((session) => (
              <UI.DescriptionItem
                action={
                  <RouterLink
                    search={{ session: session.id }}
                    to={SESSION_REVOKE_PATH}
                  >
                    {translate("auth.sessions.revoke")}
                  </RouterLink>
                }
                data-testid="sessions-other"
                description={session.description}
                icon={
                  <UI.IconGlyph
                    name={session.device === "phone" ? "phone" : "computer"}
                    size="large"
                  />
                }
                key={session.id}
                title={session.title}
              />
            ))}
            {others.length === 0
              ? (
                <UI.InlineNotice tone="neutral">
                  {translate("auth.settings.sessions.emptyNotice")}
                </UI.InlineNotice>
              )
              : null}
            <UI.Button onClick={onRevokeOthers} variant="secondary">
              {translate("auth.sessions.revokeOthers")}
            </UI.Button>
          </>
        )}
    </UI.SettingsContent>
  );
}
