import type { ReactNode } from "react";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellSlot } from "./shell-slots.tsx";

/**
 * Claims the top bar's breadcrumb region for a settings page: `Settings`,
 * then the section the person is in. Outside an app shell it renders
 * nothing, so screens stay presentable in isolation.
 */
export function SettingsBreadcrumbs(
  { section }: { readonly section: MessageKey },
) {
  const { translate } = useI18n();
  return (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { label: translate("shell.states.settingsTitle") },
          { label: translate(section) },
        ]}
      />
    </ShellSlot>
  );
}

/** A settings page with its breadcrumbs claimed through the shell slot. */
export function InSettings(
  { children, section }: {
    readonly children: ReactNode;
    readonly section: MessageKey;
  },
) {
  return (
    <>
      <SettingsBreadcrumbs section={section} />
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
          { label: translate("shell.navigation.organization") },
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
          { label: translate("shell.navigation.organization") },
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
            { label: translate("shell.navigation.installation") },
            { label: translate(section) },
          ]}
        />
      </ShellSlot>
      {children}
    </>
  );
}
