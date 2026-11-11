import * as UI from "@bakery/ui";
import { ORGANIZATIONS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

export type AppearanceOption = {
  /** Option value; `""` is the system default. */
  readonly value: string;
  /** Already-translated label. */
  readonly label: string;
};

/** Exported so the container can move focus to the control a failure names. */
export const APPEARANCE_FIELD_IDS = {
  language: "appearance-language",
  timeZone: "appearance-time-zone",
} as const;

export type AppearanceScreenProps = {
  /** Shared async state; `null` renders the settled screen. */
  readonly async: SecurityAsyncKind | null;
  /** Name of the organization the preferences belong to; `""` when unknown. */
  readonly organizationName: string;
  readonly theme: UI.Theme;
  /** The theme the device currently shows. */
  readonly resolvedTheme: "light" | "dark";
  readonly languageOptions: readonly AppearanceOption[];
  readonly language: string;
  /** Already-translated hints under the language control (phone gets the short one). */
  readonly languageHint: string;
  readonly languageHintShort: string;
  readonly timeZoneOptions: readonly AppearanceOption[];
  readonly timeZone: string;
  /** Already-translated hints under the time zone control (phone gets the short one). */
  readonly timeZoneHint: string;
  readonly timeZoneHintShort: string;
  readonly dirty: boolean;
  readonly pending: boolean;
  /** Preferences were saved and nothing has changed since. */
  readonly saved: boolean;
  /** Saving language or time zone failed for a reason other than a conflict. */
  readonly saveFailed: boolean;
  /** Saving the theme to the account failed; it still applies here. */
  readonly themeSaveFailed: boolean;
  readonly onTheme: (theme: UI.Theme) => void;
  readonly onLanguage: (value: string) => void;
  readonly onTimeZone: (value: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/settings/appearance`: the color theme (saved the moment it is picked),
 * then language and time zone, which are drafted and saved together. All of it
 * is private to the person within the selected organization.
 */
export function AppearanceScreen(
  {
    async,
    dirty,
    language,
    languageHint,
    languageHintShort,
    languageOptions,
    onCancel,
    onLanguage,
    onRefresh,
    onReload,
    onRetry,
    onSave,
    onTheme,
    onTimeZone,
    organizationName,
    pending,
    resolvedTheme,
    saveFailed,
    saved,
    theme,
    themeSaveFailed,
    timeZone,
    timeZoneHint,
    timeZoneHintShort,
    timeZoneOptions,
  }: AppearanceScreenProps,
) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const statusKey = theme === "system"
    ? resolvedTheme === "dark"
      ? "preferences.theme.status.systemDark"
      : "preferences.theme.status.systemLight"
    : theme === "dark"
    ? "preferences.theme.status.dark"
    : "preferences.theme.status.light";
  const themeNames = {
    light: translate("preferences.theme.light"),
    dark: translate("preferences.theme.dark"),
    system: translate("preferences.theme.system"),
  } as const;
  return (
    <UI.SettingsContent data-testid="appearance-settings" variant="preferences">
      <UI.AuthHeading
        description={translate("preferences.description")}
        title={translate("preferences.title")}
      />
      <SecurityAsyncBoundary
        emptyAction={
          <RouterLink to={ORGANIZATIONS_PATH}>
            {translate("core.actions.switchOrganization")}
          </RouterLink>
        }
        emptyDescription={translate("preferences.empty.description")}
        emptyTitle={translate("preferences.empty.title")}
        kind={async}
        onRefresh={onRefresh}
        onReload={onReload}
        onRetry={onRetry}
      >
        <UI.SettingsSection title={translate("preferences.theme.heading")}>
          <UI.Text variant="hint">
            {translate("preferences.theme.description")}
          </UI.Text>
          <UI.Inline
            aria-label={translate("preferences.theme.groupLabel")}
            role="radiogroup"
            variant="thirds"
          >
            {(["light", "dark", "system"] as const).map((choice) => (
              <UI.ThemeChoice
                checked={theme === choice}
                key={choice}
                name="appearance-theme"
                onChange={() =>
                  onTheme(choice)}
                theme={choice}
                value={choice}
              >
                {themeNames[choice]}
              </UI.ThemeChoice>
            ))}
          </UI.Inline>
          <UI.Inline gap="compact" role="status">
            <UI.IconGlyph name="check" />
            <UI.Badge tone="success">{translate(statusKey)}</UI.Badge>
          </UI.Inline>
          {themeSaveFailed
            ? (
              <UI.InlineNotice tone="warning">
                {translate("preferences.theme.saveFailed")}
              </UI.InlineNotice>
            )
            : null}
        </UI.SettingsSection>
        <UI.AppearancePreview
          action={translate("preferences.preview.action")}
          caption={translate("preferences.preview.caption")}
          label={translate("preferences.preview.label")}
          meta={translate("preferences.preview.meta")}
          status={
            <UI.StatusBadge status="needsInput">
              {translate("preferences.preview.status")}
            </UI.StatusBadge>
          }
          title={translate("preferences.preview.title")}
        />
        <UI.SettingsSection title={translate("preferences.workspace.heading")}>
          <UI.Text variant="muted">
            {organizationName === ""
              ? translate("preferences.workspace.description.noOrganization")
              : translate("preferences.workspace.description", {
                organization: organizationName,
              })}
          </UI.Text>
          <UI.Inline gap="compact">
            <UI.IconGlyph name="monitor" />
            <UI.Text variant="hint">{translate("preferences.motion")}</UI.Text>
          </UI.Inline>
          <UI.Text variant="hint">{translate("preferences.autoSave")}</UI.Text>
        </UI.SettingsSection>
        <UI.SettingsSection title={translate("preferences.region.heading")}>
          {phone ? null : (
            <UI.Text variant="hint">
              {translate("preferences.region.description")}
            </UI.Text>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSave();
            }}
          >
            <UI.Stack gap="standard">
              {saved
                ? (
                  <UI.InlineNotice tone="success">
                    {translate("preferences.saved")}
                  </UI.InlineNotice>
                )
                : null}
              {saveFailed
                ? (
                  <UI.InlineNotice tone="error">
                    {translate("preferences.saveError")}
                  </UI.InlineNotice>
                )
                : null}
              <UI.Combobox
                id={APPEARANCE_FIELD_IDS.language}
                label={translate("preferences.language.label")}
                name="language"
                onChange={(event) =>
                  onLanguage(event.currentTarget.value)}
                options={[...languageOptions]}
                value={language}
              />
              <UI.Text variant="hint">
                {phone ? languageHintShort : languageHint}
              </UI.Text>
              <UI.Combobox
                id={APPEARANCE_FIELD_IDS.timeZone}
                label={translate("preferences.timeZone.label")}
                name="timeZone"
                onChange={(event) => onTimeZone(event.currentTarget.value)}
                options={[...timeZoneOptions]}
                value={timeZone}
              />
              <UI.Text variant="hint">
                {phone ? timeZoneHintShort : timeZoneHint}
              </UI.Text>
              <UI.Inline gap="compact">
                <UI.Button
                  disabled={isDisconnected(async) || !dirty}
                  loading={pending}
                  type="submit"
                >
                  {translate(
                    pending ? "auth.common.pendingAction" : "preferences.save",
                  )}
                </UI.Button>
                <UI.Button
                  disabled={!dirty || pending}
                  onClick={onCancel}
                  variant="secondary"
                >
                  {translate("preferences.cancel")}
                </UI.Button>
              </UI.Inline>
            </UI.Stack>
          </form>
        </UI.SettingsSection>
      </SecurityAsyncBoundary>
    </UI.SettingsContent>
  );
}
