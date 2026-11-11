import type { MouseEvent } from "react";
import { useState } from "react";
import * as UI from "@bakery/ui";
import { I18nText, useI18n } from "../i18n/I18nProvider.tsx";
import type { ShellViewport } from "../app/responsive.ts";
import { securitySpecimens } from "./auth/security.tsx";

export const settingsRoutes = [
  {
    id: "profile",
    label: <I18nText id="shell.navigation.profile" />,
    href: "/__fixtures__/settings/profile",
  },
  {
    id: "security",
    label: <I18nText id="shell.navigation.security" />,
    href: "/__fixtures__/settings/security",
    matches: [
      "/__fixtures__/settings/security/password",
      "/__fixtures__/settings/security/email",
    ],
  },
  {
    id: "sessions",
    label: <I18nText id="shell.navigation.sessions" />,
    href: "/__fixtures__/settings/sessions",
  },
  {
    id: "clients",
    label: <I18nText id="shell.navigation.clients" />,
    href: "/__fixtures__/settings/clients",
  },
  {
    id: "appearance",
    label: <I18nText id="shell.navigation.appearance" />,
    href: "/__fixtures__/settings/appearance",
  },
  {
    id: "access",
    label: <I18nText id="shell.navigation.access" />,
    href: "/__fixtures__/settings/access",
  },
] satisfies readonly UI.SectionNavigationItem[];

export function SettingsNavigation({
  currentPath,
  onNavigate,
  viewport,
}: {
  readonly currentPath: string;
  readonly onNavigate: (
    event: MouseEvent<HTMLAnchorElement>,
    item: UI.SectionNavigationItem,
  ) => void;
  readonly viewport: ShellViewport;
}) {
  const { translate } = useI18n();
  const [status, setStatus] = useState("");
  const narrowMode = currentPath === "/__fixtures__/settings"
    ? "index"
    : "menu";
  const handleNavigate = (
    event: MouseEvent<HTMLAnchorElement>,
    item: UI.SectionNavigationItem,
  ) => {
    if (
      new URLSearchParams(location.search).get("draft") === "dirty" &&
      item.id === "profile"
    ) {
      event.preventDefault();
      setStatus(translate("shell.states.navigationPrevented"));
      return;
    }
    onNavigate(event, item);
  };
  return (
    <>
      <UI.SectionNavigation
        currentPath={currentPath}
        items={settingsRoutes}
        label={translate("shell.navigation.settingsSections")}
        narrowMode={narrowMode}
        onNavigate={handleNavigate}
        variant={viewport === "desktop" ? "sidebar" : narrowMode}
      />
      {status
        ? (
          <UI.Text data-testid="navigation-status" role="status">
            {status}
          </UI.Text>
        )
        : null}
    </>
  );
}

export type SettingsFixtureKind =
  | "index"
  | "profile"
  | "security"
  | "password"
  | "email"
  | "sessions"
  | "clients"
  | "appearance"
  | "access";

const titleKeyByKind = {
  index: "shell.states.settingsTitle",
  profile: "shell.navigation.profile",
  security: "shell.navigation.security",
  password: "shell.navigation.security",
  email: "shell.navigation.security",
  sessions: "shell.navigation.sessions",
  clients: "shell.navigation.clients",
  appearance: "shell.navigation.appearance",
  access: "shell.navigation.access",
} as const;

export function SettingsFixturePage(
  { kind }: { readonly kind: SettingsFixtureKind },
) {
  const { translate } = useI18n();
  if (kind === "security") {
    const SecurityDefault = securitySpecimens.default;
    return <SecurityDefault />;
  }
  return (
    <UI.Stack data-testid="synthetic-fixture" gap="spacious">
      <UI.StatusLabel status="queued">
        {translate("shell.states.fixtureLabel")}
      </UI.StatusLabel>
      <UI.Heading level="page" tabIndex={-1}>
        {translate(titleKeyByKind[kind])}
      </UI.Heading>
      {kind === "appearance"
        ? <AppearanceControls />
        : kind === "profile"
        ? <UI.Text>{translate("shell.states.worstCaseDescription")}</UI.Text>
        : kind === "password"
        ? <UI.Button busy>{translate("shell.states.busyTitle")}</UI.Button>
        : kind === "email"
        ? (
          <UI.InlineNotice tone="warning">
            {translate("shell.states.conflictDescription")}
          </UI.InlineNotice>
        )
        : kind === "sessions"
        ? (
          <UI.InlineNotice tone="warning">
            {translate("shell.states.staleDescription")}
          </UI.InlineNotice>
        )
        : kind === "clients"
        ? (
          <UI.InlineNotice tone="information">
            {translate("shell.states.reconnectingDescription")}
          </UI.InlineNotice>
        )
        : kind === "access"
        ? (
          <UI.ErrorState
            description={translate("shell.states.forbiddenDescription")}
            title={translate("shell.states.forbiddenTitle")}
          />
        )
        : (
          <UI.EmptyState
            description={translate("shell.states.emptyDescription")}
            title={translate("shell.states.emptyTitle")}
          />
        )}
    </UI.Stack>
  );
}

function AppearanceControls() {
  const { translate } = useI18n();
  const { setTheme, theme } = UI.useTheme();
  return (
    <UI.Stack gap="compact">
      <UI.Text>{translate("shell.states.appearanceDescription")}</UI.Text>
      <UI.SegmentedControl
        aria-label={translate("shell.states.themeLabel")}
        name="appearance-theme"
        onChange={(value) => {
          if (UI.THEMES.includes(value as UI.Theme)) {
            setTheme(value as UI.Theme);
          }
        }}
        options={[
          { value: "system", label: translate("shell.states.themeSystem") },
          { value: "light", label: translate("shell.states.themeLight") },
          { value: "dark", label: translate("shell.states.themeDark") },
        ]}
        value={theme}
      />
    </UI.Stack>
  );
}
