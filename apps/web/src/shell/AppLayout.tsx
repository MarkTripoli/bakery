import {
  type ErrorComponentProps,
  Outlet,
  useMatches,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import {
  installationSettingsQueryOptions,
  organizationQueryOptions,
} from "../api/query.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { OrganizationSwitchGuard } from "./OrganizationSwitchGuard.tsx";
import { StartupGate } from "./StartupGate.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { SettingsNavigation } from "../fixtures/SettingsFixture.tsx";
import {
  ProductionSettingsNavigation,
  settingsSectionKey,
} from "./ProductionSettingsNavigation.tsx";
import {
  INSTALLATION_INTEGRATIONS_PATH,
  InstallationSettingsNavigation,
} from "./InstallationSettingsNavigation.tsx";
import { OrganizationSettingsNavigation } from "./OrganizationSettingsNavigation.tsx";
import { useShellViewport } from "../app/responsive.ts";
import {
  isAuthEntryPath,
  isSettingsPath,
  ORGANIZATION_SETTINGS_PATH,
  ORGANIZATIONS_PATH,
  SIGN_OUT_PATH,
} from "../app/auth-required.tsx";
import { useThemePreference } from "../app/server-presentation.tsx";
import { useSession } from "../app/session-context.tsx";
import {
  artifactFixturePerson,
  isNorthwindFixturePath,
  isOnboardingFixturePath,
  isWorkFixturePath,
  NORTHWIND_FIXTURE_PROFILE,
  SHELL_FIXTURE_IDENTITY,
} from "../fixtures/shell-identity.ts";
import { ShellSlotsProvider, useShellSlotTargets } from "./shell-slots.tsx";

type ShellNavigate = (
  event: MouseEvent<HTMLAnchorElement>,
  item: { readonly href: string },
) => void;

/** Work is the `/tasks` queue once that route exists; until then `/`. */
function useWorkHref(): string {
  const router = useRouter();
  return Object.hasOwn(router.routesByPath, "/tasks") ? "/tasks" : "/";
}

/**
 * Primary destinations from the Paper sidebar (frame 5J-0). Only Work and
 * Settings have routes; the rest render disabled with a "Soon" hint instead
 * of dead links (no hint on design fixtures, which mirror the mock). A route
 * may mark one current through `ShellActiveNavigation`; that item then links
 * to the presented route.
 */
const ORGANIZATION_FIXTURE_PATHS: readonly string[] = [
  "/__fixtures__/organization/sso",
  "/__fixtures__/organization/access",
];

/** The organization design fixtures (single sign-on, access; development builds only). */
function isSsoFixturePath(pathname: string): boolean {
  return import.meta.env.DEV && ORGANIZATION_FIXTURE_PATHS.includes(pathname);
}

function isMachinesPath(pathname: string): boolean {
  return pathname === "/machines" || pathname.startsWith("/machines/");
}

const SSO_FIXTURE_PROFILE = {
  workspace: "Platform team",
  note: "Design study · Sample data",
} as const;

function usePrimaryDestinations(
  { activeId, fixture, pathname }: {
    readonly activeId: string | null;
    readonly fixture: boolean;
    readonly pathname: string;
  },
): readonly UI.ApplicationRailItem[] {
  const { translate } = useI18n();
  const workHref = useWorkHref();
  const soon = fixture ? undefined : translate("shell.navigation.comingSoon");
  const unshipped = (
    id: string,
    label: string,
    icon: UI.IconGlyphProps["name"],
  ): UI.ApplicationRailItem =>
    activeId === id
      ? { id, label, href: pathname, icon: <UI.IconGlyph name={icon} /> }
      : {
        id,
        label,
        href: `/${id}`,
        icon: <UI.IconGlyph name={icon} />,
        disabled: true,
        disabledHint: soon,
      };
  if (isNorthwindFixturePath(pathname)) {
    const sample = (
      id: string,
      label: string,
      icon: UI.IconGlyphProps["name"],
    ): UI.ApplicationRailItem => ({
      id,
      label,
      href: id === "work" ? workHref : `/${id}`,
      icon: <UI.IconGlyph name={icon} />,
    });
    return [
      sample("work", translate("shell.navigation.work"), "work-list"),
      sample(
        "applications",
        translate("shell.navigation.applications"),
        "applications",
      ),
      sample(
        "sessions",
        translate("shell.navigation.sessionsArea"),
        "terminal",
      ),
      sample("workers", translate("shell.navigation.workers"), "monitor"),
      sample("library", translate("shell.navigation.library"), "book"),
      sample(
        "automations",
        translate("shell.navigation.automations"),
        "lightning",
      ),
      {
        id: "settings",
        label: translate("shell.states.settingsTitle"),
        href: "/settings/profile",
        matchPath: "/settings",
        icon: <UI.IconGlyph name="settings-sun" />,
      },
    ];
  }
  if (isSsoFixturePath(pathname)) {
    // Paper's single sign-on frames show their own sample rail.
    const sample = (
      id: string,
      label: string,
      icon: UI.IconGlyphProps["name"],
    ): UI.ApplicationRailItem => ({
      id,
      label,
      href: `/${id}`,
      icon: <UI.IconGlyph name={icon} />,
    });
    return [
      sample("work", translate("shell.navigation.work"), "work-list"),
      sample(
        "applications",
        translate("shell.navigation.applications"),
        "applications",
      ),
      sample(
        "sessions",
        translate("shell.navigation.sessionsArea"),
        "terminal",
      ),
      sample("machines", translate("shell.navigation.machines"), "monitor"),
      sample(
        "integrations",
        translate("shell.navigation.integrations"),
        "integration",
      ),
      sample(
        "automations",
        translate("shell.navigation.automations"),
        "lightning",
      ),
      {
        id: "settings",
        label: translate("shell.states.settingsTitle"),
        href: "/settings/profile",
        matchPath: "/settings",
        icon: <UI.IconGlyph name="settings-sun" />,
      },
    ];
  }
  return [
    {
      id: "work",
      label: translate("shell.navigation.work"),
      href: workHref,
      icon: <UI.IconGlyph name="work-list" />,
    },
    {
      id: "issues",
      label: translate("shell.navigation.issues"),
      href: "/issues",
      matchPath: "/issues",
      icon: <UI.IconGlyph name="issue" />,
    },
    unshipped(
      "applications",
      translate("shell.navigation.applications"),
      "applications",
    ),
    unshipped(
      "sessions",
      translate("shell.navigation.sessionsArea"),
      "terminal",
    ),
    {
      id: "machines",
      label: translate("shell.navigation.machines"),
      href: "/machines",
      matchPath: "/machines",
      icon: <UI.IconGlyph name="monitor" />,
    },
    unshipped("library", translate("shell.navigation.library"), "book"),
    unshipped(
      "automations",
      translate("shell.navigation.automations"),
      "lightning",
    ),
    {
      id: "settings",
      label: translate("shell.states.settingsTitle"),
      href: "/settings/profile",
      matchPath: "/settings",
      icon: <UI.IconGlyph name="settings-sun" />,
    },
  ];
}

/**
 * Account menu: switch the color theme, switch organization, or head to
 * `/sign-out` to confirm.
 */
function useAccountActions() {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const session = useSession();
  const installation = useQuery({
    ...installationSettingsQueryOptions(api, scope),
    enabled: session.status === "authenticated",
  });
  const { resolvedTheme } = UI.useTheme();
  const { choose } = useThemePreference();
  const nextTheme = resolvedTheme === "light" ? "dark" : "light";
  return {
    items: [
      {
        id: "theme",
        label: translate(
          nextTheme === "light"
            ? "shell.navigation.themeUseLight"
            : "shell.navigation.themeUseDark",
        ),
      },
      {
        id: "organization-settings",
        label: translate("shell.navigation.organizationSettings"),
      },
      ...(installation.isSuccess
        ? [{
          id: "installation-settings",
          label: translate("settings.installation.title"),
        }]
        : []),
      {
        id: "switch-organization",
        label: translate("core.actions.switchOrganization"),
      },
      { id: "sign-out", label: translate("core.actions.signOut") },
    ],
    onSelect: (id: string) => {
      if (id === "theme") {
        void choose(nextTheme);
      } else if (id === "organization-settings") {
        void navigate({ to: ORGANIZATION_SETTINGS_PATH });
      } else if (id === "installation-settings") {
        void navigate({ to: "/installation/settings" });
      } else if (id === "switch-organization") {
        void navigate({ to: ORGANIZATIONS_PATH });
      } else if (id === "sign-out") {
        void navigate({ to: SIGN_OUT_PATH });
      }
    },
  };
}

function InstallationAccountActions({ roleLabel }: {
  readonly roleLabel?: string;
}) {
  const session = useSession();
  const account = useAccountActions();
  if (session.status !== "authenticated" || !session.identity) return null;
  const menu = (
    <UI.UserMenu
      items={account.items}
      label={session.identity.displayName}
      name={session.identity.displayName}
      onSelect={account.onSelect}
      variant="compact"
    />
  );
  return roleLabel
    ? (
      <UI.Inline gap="compact">
        <UI.Text variant="muted">{roleLabel}</UI.Text>
        {menu}
      </UI.Inline>
    )
    : menu;
}

function ShellSidebar(
  {
    currentPath,
    destinations,
    fixture,
    fixtureProfile,
    fixturePerson,
    onNavigate,
    organizationResolving,
    selectedId,
    variant,
  }: {
    /** The organization lookup is still running, so the rail has no name to show yet. */
    readonly organizationResolving: boolean;
    readonly currentPath: string;
    readonly destinations: readonly UI.ApplicationRailItem[];
    readonly fixture: boolean;
    /** Synthetic workspace name and footnote a design fixture presents. */
    readonly fixtureProfile?: {
      readonly workspace: string;
      readonly note?: string;
      readonly person?: string;
      readonly recent?: boolean;
    };
    readonly fixturePerson?: string;
    readonly onNavigate: ShellNavigate;
    readonly selectedId?: string;
    readonly variant: "labelled" | "compact" | "drawer";
  },
) {
  const { translate } = useI18n();
  const session = useSession();
  const account = useAccountActions();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  // The rail names the organization the person is in, so someone in two of
  // them can tell which. Until it is known the name is a short skeleton line;
  // if it cannot be read the rail falls back to the generic word.
  const organization = useQuery({
    ...organizationQueryOptions(api, scope),
    enabled: !fixture && session.status === "authenticated" &&
      scope.organizationId !== null,
  });
  const sessionIdentity = session.status === "authenticated"
    ? session.identity
    : null;
  const person = fixture
    ? fixtureProfile?.person ?? SHELL_FIXTURE_IDENTITY.person
    : fixturePerson ?? sessionIdentity?.displayName;
  const compact = variant === "compact";
  return (
    <UI.SidebarNav
      footer={person
        ? (
          <UI.UserMenu
            items={account.items}
            label={person}
            name={person}
            onSelect={account.onSelect}
            variant={compact ? "compact" : "full"}
          />
        )
        : undefined}
      homeHref="/"
      homeLabel={translate("shell.navigation.home")}
      navigation={
        <UI.ApplicationRail
          currentPath={currentPath}
          items={destinations}
          label={translate("shell.navigation.primary")}
          onNavigate={onNavigate}
          selectedId={selectedId}
          variant={variant}
        />
      }
      note={fixture
        ? fixtureProfile ? fixtureProfile.note : SHELL_FIXTURE_IDENTITY.note
        : undefined}
      onNavigate={onNavigate}
      productName={translate("shell.navigation.productName")}
      recent={fixture && fixtureProfile?.recent !== false
        ? {
          label: translate("shell.navigation.recentSessions"),
          items: SHELL_FIXTURE_IDENTITY.recentSessions.map((item) => ({
            ...item,
            href: currentPath,
          })),
        }
        : undefined}
      variant={variant}
      workspace={person
        ? (
          <UI.WorkspaceSwitcher
            items={account.items.filter((item) =>
              item.id === "switch-organization" ||
              item.id === "organization-settings"
            )}
            label={translate("shell.navigation.switchOrganization")}
            onSelect={account.onSelect}
            variant={compact ? "compact" : "full"}
            workspace={fixture
              ? fixtureProfile?.workspace ?? SHELL_FIXTURE_IDENTITY.workspace
              : organization.data?.name ??
                (organizationResolving || organization.isPending &&
                    scope.organizationId !== null
                  ? <UI.Skeleton shape="text" />
                  : translate("shell.navigation.organization"))}
          />
        )
        : undefined}
    />
  );
}

/** Title the top bar shows for the presented route. */
function usePageTitle(pathname: string): string | undefined {
  const { translate } = useI18n();
  if (
    pathname === "/" || pathname === "/tasks" || pathname === "/tasks/" ||
    isWorkFixturePath(pathname)
  ) return translate("shell.navigation.work");
  if (isMachinesPath(pathname)) {
    return translate("shell.navigation.machines");
  }
  if (pathname === "/issues" || pathname.startsWith("/issues/")) {
    return translate("shell.navigation.issues");
  }
  if (pathname === INSTALLATION_INTEGRATIONS_PATH) {
    return translate("shell.navigation.installation");
  }
  if (
    isSettingsPath(pathname) || pathname === "/__fixtures__/settings" ||
    pathname.startsWith("/__fixtures__/settings/")
  ) return translate("shell.states.settingsTitle");
  if (pathname === ORGANIZATION_SETTINGS_PATH) {
    return translate("shell.navigation.organizationSettings");
  }
  return undefined;
}

export function AppLayout() {
  return (
    <ShellSlotsProvider>
      <ShellFrame />
    </ShellSlotsProvider>
  );
}

function ShellFrame() {
  const slots = useShellSlotTargets();
  const { translate } = useI18n();
  const viewport = useShellViewport();
  const navigate = useNavigate();
  const priorPath = useRef<string | null>(null);
  // Match the presented Outlet, not the URL of a still-pending destination.
  // Switching shells early remounts the departing page and loses auth recovery.
  const pathname = useMatches({
    select: (matches) => matches.at(-1)?.pathname ?? "/",
  });
  const status = useRouterState({ select: (state) => state.status });
  const [navigationOpen, setNavigationOpen] = useState(false);
  const ssoFixture = isSsoFixturePath(pathname);
  const fixture = isWorkFixturePath(pathname) || ssoFixture;
  // Installation pages need no organization: they restore the scope quietly
  // (a multi-organization person is never sent to /organizations from them)
  // and are not held back. Every other page waits for the organization (see
  // `StartupGate`), so a person who has to choose is sent to /organizations
  // here, before any page content is drawn.
  const needsOrganization = !fixture &&
    !pathname.startsWith("/__fixtures__/") &&
    !isAuthEntryPath(pathname) && !pathname.startsWith("/installation/") &&
    pathname !== INSTALLATION_INTEGRATIONS_PATH;
  const scope = useProtectedScope();
  const restore = useRestoreOrganizationScope({
    redirect: needsOrganization,
    enabled: !fixture && !pathname.startsWith("/__fixtures__/") &&
      !isAuthEntryPath(pathname),
  });
  const activeId = slots?.activeNavigation ?? null;
  const primaryDestinations = usePrimaryDestinations({
    activeId,
    fixture,
    pathname,
  });
  const workHref = useWorkHref();
  // Work design fixtures render the production queue and session, so the
  // navigation marks Work exactly as on the Work route itself.
  const navigationPath = fixture ? workHref : pathname;
  const selectedId = activeId ?? undefined;
  const pageTitle = usePageTitle(pathname);
  const onNavigate = (
    event: MouseEvent<HTMLAnchorElement>,
    item: { readonly href: string },
  ) => {
    if (
      event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey ||
      event.altKey || event.currentTarget.target === "_blank"
    ) return;
    event.preventDefault();
    void navigate({ to: item.href });
  };

  // A route change from outside the drawer (history, deep link) closes it.
  useEffect(() => setNavigationOpen(false), [pathname]);

  useEffect(() => {
    if (priorPath.current === null) {
      priorPath.current = pathname;
      return;
    }
    if (priorPath.current === pathname) return;
    priorPath.current = pathname;

    let frame = 0;
    let focusedHeading: HTMLElement | null = null;
    const focusHeading = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const heading = document.querySelector<HTMLElement>("main h1");
        if (!heading || heading === focusedHeading) return;
        if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
        heading.focus();
        focusedHeading = heading;
      });
    };
    const main = document.querySelector("main");
    const observer = new MutationObserver(focusHeading);
    if (main) observer.observe(main, { childList: true, subtree: true });
    const timeout = globalThis.setTimeout(() => observer.disconnect(), 5_000);
    focusHeading();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      observer.disconnect();
    };
  }, [pathname]);

  /**
   * `AuthEntry` (rendered by every public auth screen, plus `/organizations`
   * for a signed-in principal with no usable membership) is a full-page
   * template that already supplies its own `<main>` landmark, logo and
   * status region. Wrapping it in `AppShell` — which renders its own
   * `<main>` and header — would nest two `<main>` landmarks and duplicate
   * the wordmark; AUTH-FLOWS.md's approved `focused`/`context`
   * compositions have no header bar at all.
   */
  if (isAuthEntryPath(pathname)) {
    return <Outlet />;
  }

  const chromeless = viewport === "phone" &&
    isOnboardingFixturePath(pathname);
  // A page that draws its own phone header replaces the shell's top bar.
  const pageHeader = viewport === "phone" && slots?.phoneHeader === "page";
  const shellVariant = viewport === "phone"
    ? "sheet"
    : viewport === "tablet"
    ? "pane"
    : "rail";
  const sidebarVariant = viewport === "phone"
    ? "drawer"
    : viewport === "tablet"
    ? "compact"
    : "labelled";
  const fixtureSettings = pathname === "/__fixtures__/settings" ||
    pathname.startsWith("/__fixtures__/settings/");
  const installationSettings = pathname === "/installation/settings" ||
    pathname === "/installation/audit" ||
    pathname === INSTALLATION_INTEGRATIONS_PATH ||
    pathname === "/__fixtures__/installation/settings";
  const organizationSettings = ORGANIZATION_FIXTURE_PATHS.includes(pathname);
  const productionSettings = isSettingsPath(pathname) ||
    isMachinesPath(pathname);
  const settingsChrome = installationSettings || organizationSettings;
  // A settings page's breadcrumb, until the page claims its own: Settings, then
  // the section, so it never reads "Workspace / Settings".
  const settingsSection = isSettingsPath(pathname)
    ? settingsSectionKey(pathname)
    : null;
  const shellNavigate: ShellNavigate = (event, item) => {
    setNavigationOpen(false);
    onNavigate(event, item);
  };
  const productName = translate("shell.navigation.productName");
  const title = pageTitle ?? productName;
  const destinations = primaryDestinations.filter((item) =>
    item.id === "work" || item.id === "applications" ||
    item.id === "sessions"
  ).map((item) =>
    item.id === "applications"
      ? {
        ...item,
        label: translate("shell.navigation.applicationsShort"),
        disabledHint: translate("shell.navigation.comingSoonLong"),
      }
      : item
  );

  // Phone tabs belong to top-level destinations only; focused flows such as
  // Settings and its sub-steps keep the full height for their own actions.
  const topLevel = !isNorthwindFixturePath(pathname) &&
    destinations.some((item) => !item.disabled && item.href === navigationPath);

  return (
    <UI.AppShell
      appearance={installationSettings
        ? "installation"
        : organizationSettings
        ? "organization"
        : undefined}
      bottomNavigation={topLevel && !chromeless
        ? (
          <UI.BottomNav
            currentPath={navigationPath}
            items={destinations}
            label={translate("shell.navigation.tabs")}
            more={{
              expanded: navigationOpen,
              icon: <UI.IconGlyph name="menu" />,
              label: translate("shell.navigation.more"),
              onSelect: () => setNavigationOpen(true),
            }}
            note={fixture ? SHELL_FIXTURE_IDENTITY.phoneNote : undefined}
            onNavigate={shellNavigate}
            selectedId={selectedId}
          />
        )
        : undefined}
      inspector={slots?.claimed.has("inspector")
        ? <div ref={slots.target("inspector")} />
        : undefined}
      inspectorSize={slots?.inspectorSize}
      mainInset={slots?.mainInset}
      statusStrip={slots?.claimed.has("statusStrip")
        ? <div ref={slots.target("statusStrip")} />
        : undefined}
      navigationDismissLabel={translate("shell.navigation.closeNavigation")}
      navigationLabel={translate("shell.navigation.menu")}
      navigationOpen={navigationOpen}
      onNavigationOpenChange={setNavigationOpen}
      sectionNavigation={fixtureSettings
        ? (
          <SettingsNavigation
            currentPath={pathname}
            onNavigate={onNavigate}
            viewport={viewport}
          />
        )
        : installationSettings
        ? (
          <InstallationSettingsNavigation
            currentPath={pathname === "/installation/audit" ||
                pathname === INSTALLATION_INTEGRATIONS_PATH
              ? pathname
              : "/installation/settings"}
            onNavigate={onNavigate}
            viewport={viewport}
          />
        )
        : organizationSettings
        ? (
          <OrganizationSettingsNavigation
            currentPath={pathname}
            onNavigate={onNavigate}
            viewport={viewport}
          />
        )
        : productionSettings
        ? (
          <ProductionSettingsNavigation
            currentPath={pathname}
            onNavigate={onNavigate}
            viewport={viewport}
          />
        )
        : undefined}
      sidebar={
        <ShellSidebar
          currentPath={navigationPath}
          destinations={primaryDestinations}
          fixture={fixture}
          fixtureProfile={ssoFixture
            ? SSO_FIXTURE_PROFILE
            : isNorthwindFixturePath(pathname)
            ? { ...NORTHWIND_FIXTURE_PROFILE, recent: false }
            : undefined}
          fixturePerson={artifactFixturePerson(pathname)}
          onNavigate={shellNavigate}
          organizationResolving={needsOrganization &&
            scope.organizationId === null && !restore.failure}
          selectedId={selectedId}
          variant={sidebarVariant}
        />
      }
      skipLinkLabel={translate("shell.navigation.skipToContent")}
      state={status === "pending" ? "loading" : "default"}
      topBar={chromeless || pageHeader ? undefined : (
        <UI.TopBar
          actions={slots?.claimed.has("actions")
            ? <span ref={slots.target("actions")} />
            : settingsChrome || organizationSettings
            ? (
              <InstallationAccountActions
                roleLabel={organizationSettings
                  ? translate("shell.navigation.organizationAdmin")
                  : undefined}
              />
            )
            : undefined}
          breadcrumbs={slots?.claimed.has("breadcrumbs")
            ? <span ref={slots.target("breadcrumbs")} />
            : (
              <UI.Breadcrumbs
                aria-label={translate("shell.navigation.breadcrumb")}
                items={settingsSection
                  ? [
                    { label: translate("shell.states.settingsTitle") },
                    { label: translate(settingsSection) },
                  ]
                  : [
                    { label: translate("shell.navigation.workspace") },
                    ...(pageTitle ? [{ label: pageTitle }] : []),
                  ]}
              />
            )}
          leading={viewport === "phone"
            ? (
              <UI.IconButton
                aria-expanded={navigationOpen}
                aria-haspopup="dialog"
                label={translate("shell.navigation.openNavigation")}
                onClick={() => setNavigationOpen(true)}
              >
                <UI.IconGlyph
                  name="menu"
                  size={settingsChrome ? "large" : "medium"}
                />
              </UI.IconButton>
            )
            : undefined}
          title={settingsChrome && viewport === "phone"
            ? (
              <>
                <UI.LogoMark variant="compact" />
                {productName}
              </>
            )
            : title}
          variant={viewport === "phone" ? "title" : "bar"}
        />
      )}
      variant={shellVariant}
    >
      <StartupGate
        enabled={needsOrganization}
        failure={restore.failure}
        onRetry={restore.retry}
        onSignOut={() => void navigate({ to: SIGN_OUT_PATH })}
        signOutHref={SIGN_OUT_PATH}
      >
        <Outlet />
      </StartupGate>
      <OrganizationSwitchGuard onAsk={() => setNavigationOpen(false)} />
    </UI.AppShell>
  );
}

export function RoutePending() {
  const { translate } = useI18n();
  return (
    <UI.Stack
      aria-label={translate("shell.states.loadingTitle")}
      gap="spacious"
    >
      <UI.Heading level="page" tabIndex={-1}>
        {translate("shell.states.loadingTitle")}
      </UI.Heading>
      <UI.Skeleton shape="text" />
      <UI.Skeleton shape="surface" />
    </UI.Stack>
  );
}

export function RouteError(_props: ErrorComponentProps) {
  const { translate } = useI18n();
  return (
    <UI.ErrorState
      description={translate("shell.states.errorDescription")}
      title={translate("shell.states.errorTitle")}
      variant="page"
    />
  );
}

export function RouteNotFound() {
  const { translate } = useI18n();
  return (
    <UI.ErrorState
      description={translate("shell.states.notFoundDescription")}
      title={translate("shell.states.notFoundTitle")}
      variant="page"
    />
  );
}
