import type { ReactNode } from "react";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { SECURITY_SETTINGS_PATH } from "../app/auth-paths.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { INSTALLATION_HOME, SETTINGS_HOME } from "./breadcrumb-paths.ts";
import { ShellSlot } from "./shell-slots.tsx";

/** Where a section's own page lives, for the crumb above one of its sub-pages. */
const SETTINGS_SECTION_PATHS: Partial<Record<MessageKey, string>> = {
  "shell.navigation.security": SECURITY_SETTINGS_PATH,
};

/**
 * Claims the top bar's breadcrumb region for a settings page: `Settings`,
 * then the section the person is in. Outside an app shell it renders
 * nothing, so screens stay presentable in isolation.
 */
export function SettingsBreadcrumbs(
  { page, section }: {
    readonly section: MessageKey;
    /** A page under the section (Passkeys under Account & security): a third crumb. */
    readonly page?: MessageKey;
  },
) {
  const { translate } = useI18n();
  return (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          {
            href: SETTINGS_HOME,
            label: translate("shell.states.settingsTitle"),
          },
          ...(page
            ? [{
              href: SETTINGS_SECTION_PATHS[section],
              label: translate(section),
            }, {
              label: translate(page),
            }]
            : [{ label: translate(section) }]),
        ]}
      />
    </ShellSlot>
  );
}

/** A settings page with its breadcrumbs claimed through the shell slot. */
export function InSettings(
  { children, page, section }: {
    readonly children: ReactNode;
    readonly section: MessageKey;
    readonly page?: MessageKey;
  },
) {
  return (
    <>
      <SettingsBreadcrumbs page={page} section={section} />
      {children}
    </>
  );
}

/**
 * Claims the breadcrumb region for the organization settings page:
 * `Organization`, then the page. It is organization administration, not a
 * personal section, so it never appears under `Settings`.
 */
export function OrganizationBreadcrumbs() {
  const { translate } = useI18n();
  return (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          {
            href: SETTINGS_HOME,
            label: translate("shell.states.settingsTitle"),
          },
          { label: translate("shell.navigation.organizationSettings") },
        ]}
      />
    </ShellSlot>
  );
}

/**
 * Claims the breadcrumb region for an organization administration section:
 * `Organization`, then the section, as the Paper entitlements frames draw
 * single sign-on, SCIM and the audit log. It is organization administration,
 * not a personal section, so it never appears under `Settings`.
 */
export function OrganizationSectionBreadcrumbs(
  { section }: { readonly section: MessageKey },
) {
  const { translate } = useI18n();
  return (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          {
            href: SETTINGS_HOME,
            label: translate("shell.states.settingsTitle"),
          },
          { label: translate(section) },
        ]}
      />
    </ShellSlot>
  );
}

/** An organization administration page with its breadcrumbs claimed. */
export function InOrganization(
  { children, section }: {
    readonly children: ReactNode;
    readonly section: MessageKey;
  },
) {
  return (
    <>
      <OrganizationSectionBreadcrumbs section={section} />
      {children}
    </>
  );
}

/**
 * Claims the breadcrumb region for an installation administration page:
 * `Installation`, then the section. Installation routes (settings,
 * audit) are outside the Settings tree.
 */
export function InstallationBreadcrumbs(
  { children, section }: {
    readonly children: ReactNode;
    readonly section: MessageKey;
  },
) {
  const { translate } = useI18n();
  return (
    <>
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            {
              href: INSTALLATION_HOME,
              label: translate("shell.navigation.installation"),
            },
            { label: translate(section) },
          ]}
        />
      </ShellSlot>
      {children}
    </>
  );
}
