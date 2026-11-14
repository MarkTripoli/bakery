import { type ReactNode, useState } from "react";
import * as UI from "@bakery/ui";

/**
 * Synthetic Paper shell content (enterprise frames 5J-0 and E8-0) shared by
 * the shell stories. Destinations Bakery does not ship yet are disabled.
 */
export const paperDestinations: readonly UI.ApplicationRailItem[] = [
  {
    id: "work",
    label: "Work",
    href: "/",
    icon: <UI.IconGlyph name="work-list" />,
  },
  {
    id: "applications",
    label: "Applications",
    href: "/applications",
    icon: <UI.IconGlyph name="applications" />,
    disabled: true,
    disabledHint: "Soon",
  },
  {
    id: "sessions",
    label: "Sessions",
    href: "/sessions",
    icon: <UI.IconGlyph name="terminal" />,
  },
  {
    id: "workers",
    label: "Workers",
    href: "/workers",
    icon: <UI.IconGlyph name="monitor" />,
  },
  {
    id: "library",
    label: "Library",
    href: "/library",
    icon: <UI.IconGlyph name="book" />,
  },
  {
    id: "automations",
    label: "Automations",
    href: "/automations",
    icon: <UI.IconGlyph name="lightning" />,
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    icon: <UI.IconGlyph name="settings-sun" />,
  },
];

export const paperPhoneDestinations: readonly UI.ApplicationRailItem[] = [
  {
    id: "work",
    label: "Work",
    href: "/",
    icon: <UI.IconGlyph name="work-list" />,
  },
  {
    id: "applications",
    label: "Apps",
    href: "/applications",
    icon: <UI.IconGlyph name="applications" />,
    disabled: true,
    disabledHint: "Coming soon",
  },
  {
    id: "sessions",
    label: "Sessions",
    href: "/sessions",
    icon: <UI.IconGlyph name="terminal" />,
  },
];

export const paperRecentSessions = {
  label: "Recent sessions",
  items: [
    { id: "s1", label: "Repository onboarding", href: "/sessions/s1" },
    { id: "s2", label: "Activity filters", href: "/sessions/s2" },
    { id: "s3", label: "iOS notifications", href: "/sessions/s3" },
  ],
} as const;

const preventNavigation = (event: { preventDefault: () => void }) =>
  event.preventDefault();

export function PaperSidebar(
  { labelSuffix = "", variant = "labelled" }: {
    /** Keeps landmark names unique when a gallery shows several sidebars. */
    labelSuffix?: string;
    variant?: "labelled" | "compact" | "drawer";
  },
) {
  const compact = variant === "compact";
  return (
    <UI.SidebarNav
      footer={
        <UI.UserMenu
          items={[
            { id: "organizations", label: "Switch organization" },
            { id: "sign-out", label: "Sign out" },
          ]}
          label="Account"
          name="Alex Morgan"
          variant={compact ? "compact" : "full"}
        />
      }
      homeHref="/"
      homeLabel="Bakery home"
      navigation={
        <UI.ApplicationRail
          currentPath="/"
          items={paperDestinations}
          label={`Application navigation${labelSuffix}`}
          onNavigate={preventNavigation}
          variant={variant}
        />
      }
      note="Design v1 · Synthetic data"
      onNavigate={preventNavigation}
      productName="Bakery"
      recent={{
        ...paperRecentSessions,
        label: `${paperRecentSessions.label}${labelSuffix}`,
      }}
      variant={variant}
      workspace={
        <UI.WorkspaceSwitcher
          items={[
            { id: "alex", label: "Alex’s workspace", selected: true },
            { id: "example", label: "Example team" },
          ]}
          label="Switch workspace"
          variant={compact ? "compact" : "full"}
          workspace="Alex’s workspace"
        />
      }
    />
  );
}

export function PaperTopBar(
  { variant = "bar", onMenu }: {
    variant?: "bar" | "title";
    onMenu?: () => void;
  },
) {
  const newTask = variant === "title"
    ? (
      <UI.IconButton label="New task">
        <UI.IconGlyph name="plus" />
      </UI.IconButton>
    )
    : (
      <UI.Button>
        <UI.IconGlyph name="plus" />
        New task
      </UI.Button>
    );
  return (
    <UI.TopBar
      actions={
        <>
          {variant === "bar"
            ? (
              <UI.IconButton label="Search" variant="compact">
                <UI.IconGlyph name="search" />
              </UI.IconButton>
            )
            : null}
          {newTask}
        </>
      }
      breadcrumbs={
        <UI.Breadcrumbs
          aria-label="Breadcrumb"
          items={[{ label: "Workspace" }, { label: "Work" }]}
        />
      }
      leading={onMenu
        ? (
          <UI.IconButton label="Open navigation" onClick={onMenu}>
            <UI.IconGlyph name="menu" />
          </UI.IconButton>
        )
        : undefined}
      title="Work"
      variant={variant}
    />
  );
}

export function PaperStatusStrip() {
  return (
    <UI.StatusStrip label="Worker readiness">
      <UI.StatusBadge status="healthy">1 worker ready</UI.StatusBadge>
      <span>MacBook offline</span>
    </UI.StatusStrip>
  );
}

export function PaperInspector(
  { variant = "column" }: { variant?: "column" | "stacked" },
) {
  return (
    <UI.InspectorPanel
      footer={<UI.Button variant="secondary">Open session</UI.Button>}
      header={
        <UI.Heading level="section" rank={2}>
          Add repository onboarding
        </UI.Heading>
      }
      label="Selected task"
      variant={variant}
    >
      <UI.Inline>
        <UI.DataText>BKRY-104</UI.DataText>
        <UI.StatusBadge status="needsInput">Needs input</UI.StatusBadge>
      </UI.Inline>
      <UI.Text variant="muted">Your answer will resume this task.</UI.Text>
    </UI.InspectorPanel>
  );
}

export function PaperPageHeader(
  { variant = "titled" }: { variant?: "titled" | "tabsOnly" },
) {
  const [tab, setTab] = useState("all");
  return (
    <UI.PageHeader
      meta="8 open tasks"
      tabs={
        <UI.Tabs
          aria-label="Work views"
          onSelect={setTab}
          selectedId={tab}
          tabs={[
            { id: "all", label: "All work", content: null },
            { id: "input", label: "Needs input 2", content: null },
            { id: "active", label: "Active 3", content: null },
          ]}
          variant="route"
        />
      }
      title="Work"
      variant={variant}
    />
  );
}

/** One complete Paper shell around placeholder page content. */
export function PaperShell(
  {
    children,
    inspector = false,
    state = "default",
    variant,
  }: {
    children?: ReactNode;
    inspector?: boolean;
    state?: "default" | "loading" | "error";
    variant: "sheet" | "pane" | "rail";
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <UI.AppShell
      bottomNavigation={
        <UI.BottomNav
          currentPath="/"
          items={paperPhoneDestinations}
          label="Primary"
          more={{
            expanded: open,
            icon: <UI.IconGlyph name="menu" />,
            label: "More",
            onSelect: () => setOpen(true),
          }}
          onNavigate={preventNavigation}
        />
      }
      inspector={inspector
        ? <PaperInspector variant={variant === "rail" ? "column" : "stacked"} />
        : undefined}
      navigationDismissLabel="Close navigation"
      navigationLabel="Navigation"
      navigationOpen={open}
      onNavigationOpenChange={setOpen}
      sidebar={
        <PaperSidebar
          variant={variant === "rail"
            ? "labelled"
            : variant === "pane"
            ? "compact"
            : "drawer"}
        />
      }
      skipLinkLabel="Skip to content"
      state={state}
      statusStrip={variant === "sheet" ? undefined : <PaperStatusStrip />}
      topBar={
        <PaperTopBar
          onMenu={variant === "sheet" ? () => setOpen(true) : undefined}
          variant={variant === "sheet" ? "title" : "bar"}
        />
      }
      variant={variant}
    >
      {children ?? (
        <>
          <PaperPageHeader
            variant={variant === "sheet" ? "tabsOnly" : "titled"}
          />
          <UI.Text>Page content belongs here.</UI.Text>
        </>
      )}
    </UI.AppShell>
  );
}
