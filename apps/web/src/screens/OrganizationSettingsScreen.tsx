import * as UI from "@bakery/ui";
import { ORGANIZATIONS_PATH } from "../app/auth-paths.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  isDisconnected,
  SecurityAsyncBoundary,
  type SecurityAsyncKind,
} from "./security-async.tsx";

/** Exported so the container can move focus to the control a failure names. */
export const ORGANIZATION_LOCALE_FIELD_ID = "organization-default-locale";

export type OrganizationLocaleOption = {
  /** Locale tag, or `""` for "Bakery default" (clears the organization default). */
  readonly value: string;
  /** Already-translated language name. */
  readonly label: string;
};

export type OrganizationSettingsScreenProps = {
  /** Shared async state; `null` renders the settled screen. */
  readonly async: SecurityAsyncKind | null;
  /** The organization's name, shown in the description. */
  readonly organizationName: string;
  /** Admins edit the default language; everyone else sees it read-only. */
  readonly canEdit: boolean;
  /** Installed languages plus the "Bakery default" entry first. */
  readonly localeOptions: readonly OrganizationLocaleOption[];
  /** The saved default (`""` for none). */
  readonly savedLocale: string;
  /** The draft the Admin is editing. */
  readonly draftLocale: string;
  /** What the feature flags currently allow; `null` while unknown. */
  readonly availability: {
    readonly signups: boolean;
    readonly organizationCreation: boolean;
  } | null;
  /** A save succeeded and nothing has changed since. */
  readonly saved: boolean;
  /** A save failed for a reason other than a conflict. */
  readonly saveFailed: boolean;
  readonly pending: boolean;
  readonly onDraftChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onRetry: () => void;
  readonly onReload: () => void;
  readonly onRefresh: () => void;
};

/**
 * `/organization/settings`: the organization's default language (editable by
 * an Admin with an optimistic-concurrency save, read-only for everyone else)
 * and the installation's feature availability (read-only for everyone).
 * There is no Paper artboard for this page; it is built only from catalog
 * components in the `settings` composition.
 */
export function OrganizationSettingsScreen(
  {
    async,
    availability,
    canEdit,
    draftLocale,
    localeOptions,
    onDraftChange,
    onRefresh,
    onReload,
    onRetry,
    onSave,
    organizationName,
    pending,
    saveFailed,
    saved,
    savedLocale,
  }: OrganizationSettingsScreenProps,
) {
  const { translate } = useI18n();
  const savedLabel =
    localeOptions.find((option) => option.value === savedLocale)?.label ??
      savedLocale;
  return (
    <UI.SettingsContent data-testid="organization-settings">
      <UI.AuthHeading
        description={organizationName === ""
          ? translate("organizationSettings.description")
          : `${organizationName} · ${
            translate("organizationSettings.description")
          }`}
        title={translate("organizationSettings.title")}
      />
      <SecurityAsyncBoundary
        emptyAction={
          <RouterLink to={ORGANIZATIONS_PATH}>
            {translate("core.actions.switchOrganization")}
          </RouterLink>
        }
        emptyDescription={translate("organizationSettings.empty.description")}
        emptyTitle={translate("organizationSettings.empty.title")}
        kind={async}
        onRefresh={onRefresh}
        onReload={onReload}
        onRetry={onRetry}
      >
        <UI.SettingsSection
          title={translate("organizationSettings.language.heading")}
          variant="stack"
        >
          {canEdit
            ? (
              <UI.FormContent>
                {saved
                  ? (
                    <UI.InlineNotice tone="success">
                      {translate("organizationSettings.language.saved")}
                    </UI.InlineNotice>
                  )
                  : null}
                {saveFailed
                  ? (
                    <UI.InlineNotice tone="error">
                      {translate("organizationSettings.language.saveError")}
                    </UI.InlineNotice>
                  )
                  : null}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    onSave();
                  }}
                >
                  <UI.Stack gap="standard">
                    <UI.Combobox
                      id={ORGANIZATION_LOCALE_FIELD_ID}
                      label={translate("organizationSettings.language.label")}
                      name="default-locale"
                      onChange={(event) =>
                        onDraftChange(event.currentTarget.value)}
                      options={[...localeOptions]}
                      value={draftLocale}
                    />
                    <UI.Text variant="muted">
                      {translate("organizationSettings.language.hint")}
                    </UI.Text>
                    <UI.Button
                      disabled={isDisconnected(async) ||
                        draftLocale === savedLocale}
                      loading={pending}
                      type="submit"
                    >
                      {translate(
                        pending
                          ? "auth.common.pendingAction"
                          : "organizationSettings.language.save",
                      )}
                    </UI.Button>
                  </UI.Stack>
                </form>
              </UI.FormContent>
            )
            : (
              <UI.DescriptionItem
                data-testid="organization-locale-readonly"
                description={translate(
                  "organizationSettings.language.readOnlyHint",
                )}
                icon={<UI.IconGlyph name="document" size="large" />}
                title={savedLabel}
              />
            )}
        </UI.SettingsSection>
      </SecurityAsyncBoundary>
      <UI.SettingsSection title={translate("features.heading")}>
        <UI.Text variant="muted">{translate("features.description")}</UI.Text>
        <UI.DescriptionList data-testid="feature-availability">
          <FeatureRow
            available={availability?.signups ?? null}
            availableKey="features.signups.available"
            pausedKey="features.signups.paused"
            titleKey="features.signups.title"
          />
          <FeatureRow
            available={availability?.organizationCreation ?? null}
            availableKey="features.organizationCreation.available"
            pausedKey="features.organizationCreation.paused"
            titleKey="features.organizationCreation.title"
          />
        </UI.DescriptionList>
      </UI.SettingsSection>
    </UI.SettingsContent>
  );
}

function FeatureRow(
  { available, availableKey, pausedKey, titleKey }: {
    readonly available: boolean | null;
    readonly availableKey:
      | "features.signups.available"
      | "features.organizationCreation.available";
    readonly pausedKey:
      | "features.signups.paused"
      | "features.organizationCreation.paused";
    readonly titleKey:
      | "features.signups.title"
      | "features.organizationCreation.title";
  },
) {
  const { translate } = useI18n();
  if (available === null) {
    return <UI.Skeleton shape="row" />;
  }
  return (
    <UI.DescriptionItem
      action={
        <UI.Badge tone={available ? "success" : "neutral"}>
          {translate(available ? "features.available" : "features.paused")}
        </UI.Badge>
      }
      description={translate(available ? availableKey : pausedKey)}
      icon={<UI.IconGlyph name={available ? "check" : "alert"} size="large" />}
      title={translate(titleKey)}
    />
  );
}
