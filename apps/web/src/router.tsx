import { useMemo } from "react";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Navigate,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { isUuid } from "@bakery/contracts/contracts";
import type { BakeryApiClient } from "./api/client.ts";
import { useBakeryApi } from "./api/context.tsx";
import {
  CONNECTED_CLIENTS_PATH,
  REVOKE_CLIENT_PATH,
} from "./app/auth-paths.ts";
import {
  ProtectedRouteError,
  requireSession,
  SETUP_PATH,
} from "./app/auth-required.tsx";
import { installationStatus } from "./app/installation-status-cache.ts";
import type { SessionController } from "./app/session.ts";
import {
  AppLayout,
  RouteError,
  RouteNotFound,
  RoutePending,
} from "./shell/AppLayout.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { MachinesPage } from "./pages/MachinesPage.tsx";
import { MachineDetailPage } from "./pages/MachineDetailPage.tsx";
import { TaskCoordinationPage } from "./pages/task-coordination/TaskCoordinationPage.tsx";
import { AppearancePage } from "./pages/AppearancePage.tsx";
import { HealthPage } from "./pages/HealthPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";
import { SignInPage } from "./pages/SignInPage.tsx";
import { TwoFactorChallengePage } from "./pages/TwoFactorChallengePage.tsx";
import { RecoveryCodePage } from "./pages/RecoveryCodePage.tsx";
import { SignOutPage } from "./pages/SignOutPage.tsx";
import { JoinPage } from "./pages/JoinPage.tsx";
import { RegisterPage } from "./pages/RegisterPage.tsx";
import { InvitationPage } from "./pages/InvitationPage.tsx";
import {
  InOrganization,
  InSettings,
  InstallationBreadcrumbs,
} from "./shell/SettingsShellSlots.tsx";
import { OrganizationSettingsPage } from "./pages/OrganizationSettingsPage.tsx";
import {
  InstallationIntegrationsPage,
  parseRegistrationOutcome,
  REGISTRATION_OUTCOME_PARAMETER,
} from "./pages/InstallationIntegrationsPage.tsx";
import { ScimConnectionPage } from "./pages/ScimConnectionPage.tsx";
import { AuditEventsPage } from "./pages/AuditEventsPage.tsx";
import { OrganizationAccessPage } from "./pages/OrganizationAccessPage.tsx";
import { OrganizationRepositoryRuleEditorPage } from "./pages/OrganizationRepositoryRuleEditorPage.tsx";
import { OrganizationRepositoryRulesPage } from "./pages/OrganizationRepositoryRulesPage.tsx";
import { OrganizationRolesPage } from "./pages/OrganizationRolesPage.tsx";
import {
  CONNECTION_ID_PARAMETER,
  CONNECTION_OUTCOME_PARAMETER,
  OrganizationIntegrationsPage,
  parseConnectionOutcome,
} from "./pages/OrganizationIntegrationsPage.tsx";
import { SsoPage } from "./pages/SsoPage.tsx";
import { InstallationSettingsPage } from "./pages/InstallationSettingsPage.tsx";
import { AccessPage } from "./pages/AccessPage.tsx";
import { SettingsIndexPage } from "./pages/SettingsIndexPage.tsx";
import { ProfilePage } from "./pages/ProfilePage.tsx";
import { OrganizationsPage } from "./pages/OrganizationsPage.tsx";
import { SessionsSettingsPage } from "./pages/SessionsSettingsPage.tsx";
import { RevokeSessionsPage } from "./pages/RevokeSessionsPage.tsx";
import { ArtifactRetrievalPage } from "./pages/ArtifactRetrievalPage.tsx";
import { TwoFactorSettingsPage } from "./pages/TwoFactorSettingsPage.tsx";
import { TotpSetupPage } from "./pages/TotpSetupPage.tsx";
import { BackupCodesPage } from "./pages/BackupCodesPage.tsx";
import { TotpDisablePage } from "./pages/TotpDisablePage.tsx";
import { SecurityHubPage } from "./pages/SecurityHubPage.tsx";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.tsx";
import { PasskeysPage } from "./pages/PasskeysPage.tsx";
import { AddPasskeyPage } from "./pages/AddPasskeyPage.tsx";
import { ReauthPage } from "./pages/ReauthPage.tsx";
import { ConnectedClientsPage } from "./pages/ConnectedClientsPage.tsx";
import { RevokeClientPage } from "./pages/RevokeClientPage.tsx";
import { OAuthConsentPage } from "./pages/OAuthConsentPage.tsx";
import { createConsentGateway } from "./app/consent-gateway.ts";
import { ProjectsOnboardingPage } from "./pages/ProjectsOnboardingPage.tsx";
import { useProjectsOnboardingLabels } from "./pages/projects-onboarding/useProjectsOnboardingLabels.ts";
import { ApiBoundaryFixture } from "./fixtures/ApiBoundaryFixture.tsx";
import { MachinesFixture } from "./fixtures/MachinesFixture.tsx";
import {
  authFixtureStates,
  AuthStateFixture,
} from "./fixtures/AuthStateFixture.tsx";
import { shellFixtureStates } from "./routes/route-states.ts";
import { CacheScopeFixture } from "./fixtures/CacheScopeFixture.tsx";
import { ArtifactFixture } from "./fixtures/ArtifactFixture.tsx";
import { OrganizationFixture } from "./fixtures/OrganizationFixture.tsx";
import {
  type SettingsFixtureKind,
  SettingsFixturePage,
} from "./fixtures/SettingsFixture.tsx";
import { ShellStateFixture } from "./fixtures/ShellStateFixture.tsx";
import { RunOutputFixture } from "./fixtures/RunOutputFixture.tsx";
import {
  WorkQueueFixture,
  WorkSessionFixture,
} from "./fixtures/WorkFixture.tsx";
import {
  ProjectsOnboardingFixture,
  TaskConversationFixture,
  TaskCoordinationFixture,
} from "./fixtures/E06Fixture.tsx";

/** Router-level context: the app singletons `beforeLoad` guards depend on. */
export type RouterContext = {
  readonly api: BakeryApiClient;
  readonly session: SessionController;
};

/**
 * Canonical route coverage metadata. `scripts/check-ui-architecture.mjs` reads
 * this literal array and requires one `createRoute` specimen per path in this
 * same module, so both the entry and the specimen keep literal paths.
 */
export const routeCoverage = [
  {
    id: "tasks",
    path: "/tasks",
    classification: "production",
    states: [
      "loading",
      "ready",
      "reconnecting",
      "empty",
      "error",
      "forbidden",
      "offline",
    ],
  },
  {
    id: "task-new",
    path: "/tasks/new",
    classification: "production",
    states: [
      "loading",
      "ready",
      "reconnecting",
      "empty",
      "error",
      "forbidden",
      "offline",
    ],
  },
  {
    id: "e05-task-run",
    path: "/tasks/$taskId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "reconnecting",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "task-coordination",
    path: "/tasks/$taskId/coordination",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "reconnecting",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "machines",
    path: "/machines",
    classification: "production",
    states: [
      "loading",
      "ready",
      "reconnecting",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "machine-detail",
    path: "/machines/$machineId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "reconnecting",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
      "detail",
    ],
  },
  {
    id: "status",
    path: "/",
    classification: "production",
    states: [
      "loading",
      "ready",
      "unavailable",
      "error",
      "offline",
      "reconnecting",
    ],
  },
  {
    id: "settings-index",
    path: "/settings",
    classification: "production",
    states: ["redirect", "default"],
  },
  {
    id: "profile",
    path: "/settings/profile",
    classification: "production",
    states: [
      "loading",
      "default",
      "empty",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "reconnecting",
      "long-copy",
    ],
  },
  {
    id: "appearance",
    path: "/settings/appearance",
    classification: "production",
    states: [
      "ready",
      "loading",
      "default",
      "empty",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "reconnecting",
    ],
  },
  {
    id: "access",
    path: "/settings/access",
    classification: "production",
    states: [
      "loading",
      "default",
      "empty",
      "error",
      "forbidden",
      "stale",
      "offline",
      "reconnecting",
      "no-access",
    ],
  },
  {
    id: "setup",
    path: "/setup",
    classification: "production",
    states: ["loading", "default", "ready", "unavailable"],
  },
  {
    id: "projects-onboarding",
    path: "/projects/onboarding",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "conflict",
      "disabled",
      "stale",
      "offline",
      "reconnecting",
      "long-copy",
      "unavailable",
    ],
  },
  {
    id: "sign-in",
    path: "/sign-in",
    classification: "production",
    states: [
      "github-disabled",
      "invalid",
      "loading",
      "offline",
      "unavailable",
      "throttled",
      "expired",
      "factor-required",
    ],
  },
  {
    id: "totp-challenge",
    path: "/sign-in/two-factor",
    classification: "production",
    states: ["default", "invalid", "loading", "rate-limited", "expired"],
  },
  {
    id: "backup-challenge",
    path: "/sign-in/recovery-code",
    classification: "production",
    states: ["default", "invalid", "loading", "no-access"],
  },
  {
    id: "signout",
    path: "/sign-out",
    classification: "production",
    states: ["default", "unsynced", "success"],
  },
  {
    id: "register",
    path: "/register",
    classification: "production",
    states: ["ready", "invalid", "conflict", "submitting"],
  },
  {
    id: "invitation",
    path: "/invitations/$invitationId",
    classification: "production",
    states: ["loading", "ready", "action", "error", "auth-required"],
  },
  {
    id: "organizations",
    path: "/organizations",
    classification: "production",
    states: ["loading", "ready", "empty", "removed", "forbidden", "error"],
  },
  {
    id: "installation-settings",
    path: "/installation/settings",
    classification: "production",
    states: [
      "loading",
      "default",
      "busy",
      "error",
      "conflict",
      "forbidden",
    ],
  },
  {
    id: "installation-audit",
    path: "/installation/audit",
    classification: "production",
    states: ["loading", "default", "empty", "error", "forbidden"],
  },
  {
    id: "installation-integrations",
    path: "/settings/installation/integrations",
    classification: "production",
    states: [
      "loading",
      "empty",
      "default",
      "busy",
      "expired",
      "failed",
      "conflict",
      "error",
      "forbidden",
    ],
  },
  {
    id: "settings-organization-access",
    path: "/settings/organization/access",
    classification: "production",
    states: ["loading", "default", "empty", "error", "forbidden"],
  },
  {
    id: "settings-organization-roles",
    path: "/settings/organization/roles",
    classification: "production",
    states: ["loading", "default", "error", "forbidden"],
  },
  {
    id: "settings-organization-repository-rules",
    path: "/settings/organization/repository-rules",
    classification: "production",
    states: ["loading", "default", "empty", "error", "forbidden"],
  },
  {
    id: "settings-organization-repository-rule-editor",
    path: "/settings/organization/repository-rules/$ruleKey",
    classification: "production",
    states: ["loading", "default", "error", "forbidden"],
  },
  {
    id: "settings-organization-integrations",
    path: "/settings/organization/integrations",
    classification: "production",
    states: ["loading", "empty", "default", "busy", "error", "forbidden"],
  },
  {
    id: "settings-audit",
    path: "/settings/audit",
    classification: "production",
    states: ["loading", "default", "empty", "error", "forbidden"],
  },
  {
    id: "settings-organization-sso",
    path: "/settings/organization/sso",
    classification: "production",
    states: ["loading", "default", "empty", "busy", "error", "forbidden"],
  },
  {
    id: "settings-scim",
    path: "/settings/scim",
    classification: "production",
    states: ["loading", "default", "busy", "error", "conflict", "forbidden"],
  },
  {
    id: "organization-settings",
    path: "/organization/settings",
    classification: "production",
    states: [
      "loading",
      "ready",
      "default",
      "long-copy",
      "error",
      "forbidden",
      "conflict",
      "offline",
      "reconnecting",
    ],
  },
  {
    id: "artifact-retrieval",
    path: "/tasks/$taskId/artifacts/$artifactId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "auth-required",
      "forbidden",
      "unavailable",
      "offline",
      "reconnecting",
      "error",
    ],
  },
  {
    id: "security",
    path: "/settings/security",
    classification: "production",
    states: ["default", "saved", "protected"],
  },
  {
    id: "password",
    path: "/settings/security/password",
    classification: "production",
    states: ["default", "invalid", "loading", "success"],
  },
  {
    id: "passkeys",
    path: "/settings/security/passkeys",
    classification: "production",
    states: ["default", "enabled", "rename", "remove", "blocked", "failed"],
  },
  {
    id: "passkey-add",
    path: "/settings/security/passkeys/new",
    classification: "production",
    states: ["default", "prompt", "canceled", "unsupported", "success"],
  },
  {
    id: "reauth",
    path: "/account/reauthenticate",
    classification: "production",
    states: ["default", "invalid", "loading"],
  },
  {
    id: "clients",
    path: "/settings/clients",
    classification: "production",
    states: ["default", "empty", "revoked"],
  },
  {
    id: "revoke-client",
    path: "/settings/clients/revoke",
    classification: "production",
    states: ["default", "failed"],
  },
  {
    id: "consent",
    path: "/oauth/consent",
    classification: "production",
    states: ["default", "denied", "success", "expired"],
  },
  {
    id: "sessions",
    path: "/settings/sessions",
    classification: "production",
    states: ["default", "revoked", "empty"],
  },
  {
    id: "revoke",
    path: "/settings/sessions/revoke",
    classification: "production",
    states: ["default", "success", "failed"],
  },
  {
    id: "two-factor",
    path: "/settings/security/two-factor",
    classification: "production",
    states: ["default", "enabled", "no-codes"],
  },
  {
    id: "totp-setup",
    path: "/settings/security/two-factor/setup",
    classification: "production",
    states: ["default", "scan", "invalid", "expired", "loading"],
  },
  {
    id: "backup-codes",
    path: "/settings/security/two-factor/backup-codes",
    classification: "production",
    states: ["default", "copied", "regenerate", "invalid", "regenerated"],
  },
  {
    id: "totp-disable",
    path: "/settings/security/two-factor/disable",
    classification: "production",
    states: ["default", "invalid", "disabled"],
  },
  {
    id: "fixture-machines",
    path: "/__fixtures__/machines/$state",
    classification: "fixture",
    states: [
      "default",
      "ready",
      "loading",
      "empty",
      "error",
      "forbidden",
      "stale",
      "offline",
      "reconnecting",
      "expired",
      "revoked",
      "unavailable",
      "accepted",
      "complete",
    ],
  },
  {
    id: "fixture-machines-detail",
    path: "/__fixtures__/machines/detail",
    classification: "fixture",
    states: ["default"],
  },
  {
    id: "fixture-api-boundary",
    path: "/__fixtures__/api-boundary",
    classification: "fixture",
    states: ["loading", "auth-required", "error"],
  },
  {
    id: "fixture-organization-sso",
    path: "/__fixtures__/organization/sso",
    classification: "fixture",
    states: ["default"],
  },
  {
    id: "fixture-organization-access",
    path: "/__fixtures__/organization/access",
    classification: "fixture",
    states: ["loading", "default", "empty", "error"],
  },
  {
    id: "fixture-installation-settings",
    path: "/__fixtures__/installation/settings",
    classification: "fixture",
    states: ["default", "busy", "error", "conflict"],
  },
  {
    id: "fixture-shell-state",
    path: "/__fixtures__/shell/$state",
    classification: "fixture",
    states: [
      "loading",
      "empty",
      "error",
      "forbidden",
      "conflict",
      "stale",
      "offline",
      "reconnecting",
      "busy",
      "long-copy",
    ],
  },
  {
    id: "fixture-auth",
    path: "/__fixtures__/auth/$state",
    classification: "fixture",
    states: [
      "accepted",
      "authenticated",
      "blocked",
      "canceled",
      "conflict",
      "copied",
      "declined",
      "default",
      "denied",
      "disabled",
      "empty",
      "enabled",
      "error",
      "existing",
      "expired",
      "failed",
      "forbidden",
      "github-disabled",
      "invalid",
      "loading",
      "long-copy",
      "no-access",
      "no-codes",
      "offline",
      "prompt",
      "protected",
      "rate-limited",
      "ready",
      "reconnecting",
      "regenerate",
      "regenerated",
      "remove",
      "removed",
      "rename",
      "revoked",
      "saved",
      "scan",
      "skeleton",
      "stale",
      "success",
      "throttled",
      "unavailable",
      "unsupported",
      "wrong-account",
    ],
  },
  {
    id: "fixture-settings",
    path: "/__fixtures__/settings",
    classification: "fixture",
    states: ["empty"],
  },
  {
    id: "fixture-settings-profile",
    path: "/__fixtures__/settings/profile",
    classification: "fixture",
    states: ["long-copy"],
  },
  {
    id: "fixture-settings-security",
    path: "/__fixtures__/settings/security",
    classification: "fixture",
    states: ["detail"],
  },
  {
    id: "fixture-settings-security-password",
    path: "/__fixtures__/settings/security/password",
    classification: "fixture",
    states: ["action", "busy"],
  },
  {
    id: "fixture-settings-security-email",
    path: "/__fixtures__/settings/security/email",
    classification: "fixture",
    states: ["conflict"],
  },
  {
    id: "fixture-settings-sessions",
    path: "/__fixtures__/settings/sessions",
    classification: "fixture",
    states: ["stale"],
  },
  {
    id: "fixture-settings-clients",
    path: "/__fixtures__/settings/clients",
    classification: "fixture",
    states: ["reconnecting"],
  },
  {
    id: "fixture-settings-appearance",
    path: "/__fixtures__/settings/appearance",
    classification: "fixture",
    states: ["ready"],
  },
  {
    id: "fixture-settings-access",
    path: "/__fixtures__/settings/access",
    classification: "fixture",
    states: ["forbidden"],
  },
  {
    id: "fixture-organization",
    path: "/__fixtures__/organization",
    classification: "fixture",
    states: ["organization-admin"],
  },
  {
    id: "fixture-cache-scope",
    path: "/__fixtures__/cache-scope",
    classification: "fixture",
    states: ["cache-scope"],
  },
  {
    id: "fixture-work-queue",
    path: "/__fixtures__/work/queue",
    classification: "fixture",
    states: ["default"],
  },
  {
    id: "fixture-work-session",
    path: "/__fixtures__/work/session",
    classification: "fixture",
    states: ["default"],
  },
  {
    id: "fixture-work-conversation",
    path: "/__fixtures__/work/conversation/$state",
    classification: "fixture",
    states: ["default", "plan-review", "question", "empty", "conflict"],
  },
  {
    id: "fixture-work-coordination",
    path: "/__fixtures__/work/coordination/$state",
    classification: "fixture",
    states: ["default", "empty", "partial", "stale", "workflow", "ticket"],
  },
  {
    id: "fixture-work-onboarding",
    path: "/__fixtures__/work/onboarding/$state",
    classification: "fixture",
    states: ["default"],
  },
  {
    id: "fixture-artifacts-artifact",
    path: "/__fixtures__/artifacts/artifact/$state",
    classification: "fixture",
    states: [
      "default",
      "empty",
      "expired",
      "forbidden",
      "loading",
      "reconnecting",
      "stale",
      "unsupported",
    ],
  },
  {
    id: "fixture-artifacts-task-run",
    path: "/__fixtures__/artifacts/task-run/$state",
    classification: "fixture",
    states: ["default", "reconnecting"],
  },
] as const;

const rootRoute = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ abortController, context, location }) => {
    const status = await installationStatus(
      context.api,
      abortController.signal,
    );
    if (
      status.ok && status.data.bootstrapped === false &&
      location.pathname !== SETUP_PATH
    ) {
      throw redirect({ to: SETUP_PATH });
    }
    await context.session.refresh(abortController.signal);
  },
  component: AppLayout,
  errorComponent: RouteError,
  notFoundComponent: RouteNotFound,
  pendingComponent: RoutePending,
});
function projectsOnboardingComponent() {
  const labels = useProjectsOnboardingLabels();
  return <ProjectsOnboardingPage labels={labels} />;
}

const projectsOnboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/onboarding",
  validateSearch: (search: Record<string, unknown>) => ({
    application: typeof search.application === "string" &&
        isUuid(search.application)
      ? search.application
      : undefined,
    repository: typeof search.repository === "string" &&
        isUuid(search.repository)
      ? search.repository
      : undefined,
    profile: typeof search.profile === "string" && isUuid(search.profile)
      ? search.profile
      : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: projectsOnboardingComponent,
  errorComponent: ProtectedRouteError,
});

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: TasksPage,
  errorComponent: ProtectedRouteError,
});
const taskNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/new",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <TasksPage composing />,
  errorComponent: ProtectedRouteError,
});
const taskDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <TasksPage taskId={taskDetailRoute.useParams().taskId} />,
  errorComponent: ProtectedRouteError,
});

const taskCoordinationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId/coordination",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <TaskCoordinationPage
      taskId={taskCoordinationRoute.useParams().taskId}
    />
  ),
  errorComponent: ProtectedRouteError,
});

const machinesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: MachinesPage,
  errorComponent: ProtectedRouteError,
});

const machineDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/$machineId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <MachineDetailPage machineId={machineDetailRoute.useParams().machineId} />
  ),
  errorComponent: ProtectedRouteError,
});
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: HealthPage,
  errorComponent: ProtectedRouteError,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: ({ context, location }) => {
    requireSession(context.session, location);
    // Phones get the section index; wider screens land on Profile.
    if (!globalThis.matchMedia?.("(max-width: 743px)").matches) {
      throw redirect({ to: "/settings/profile" });
    }
  },
  component: () => <SettingsIndexPage />,
  errorComponent: ProtectedRouteError,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/profile",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.profile">
      <ProfilePage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const appearanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/appearance",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.appearance">
      <AppearancePage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const accessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/access",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.access">
      <AccessPage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: (
    search: Record<string, unknown>,
  ): { reason?: "expired" | "factor"; invitation?: string } => ({
    reason: search.reason === "expired" || search.reason === "factor"
      ? search.reason
      : undefined,
    // Only a UUID can name an invitation; anything else is dropped rather
    // than carried into a preview request and a dead-end deep link.
    invitation: typeof search.invitation === "string" &&
        isUuid(search.invitation)
      ? search.invitation
      : undefined,
  }),
  component: () => {
    const { invitation, reason } = signInRoute.useSearch();
    return (
      <SignInPage invitation={invitation ?? null} reason={reason ?? null} />
    );
  },
});

const totpChallengeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in/two-factor",
  component: TwoFactorChallengePage,
});

const recoveryCodeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in/recovery-code",
  component: RecoveryCodePage,
});

const signOutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-out",
  component: SignOutPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: (
    search: Record<string, unknown>,
  ): { invitation?: string } => ({
    invitation: typeof search.invitation === "string"
      ? search.invitation
      : undefined,
  }),
  component: () => {
    const { invitation } = registerRoute.useSearch();
    return invitation && isUuid(invitation)
      ? <RegisterPage invitationId={invitation} />
      : <JoinPage />;
  },
});

const invitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invitations/$invitationId",
  component: InvitationPage,
});

const organizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organizations",
  validateSearch: (
    search: Record<string, unknown>,
  ): { reason?: "forbidden" | "removed" } => ({
    reason: search.reason === "forbidden" || search.reason === "removed"
      ? search.reason
      : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { reason } = organizationsRoute.useSearch();
    return <OrganizationsPage reason={reason ?? null} />;
  },
  errorComponent: ProtectedRouteError,
});
const organizationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organization/settings",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: OrganizationSettingsPage,
  errorComponent: ProtectedRouteError,
});

const installationSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/settings",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: InstallationSettingsPage,
  errorComponent: ProtectedRouteError,
});

const installationIntegrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/installation/integrations",
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    githubAppRegistration?: ReturnType<typeof parseRegistrationOutcome>;
  } => ({
    githubAppRegistration: parseRegistrationOutcome(
      search[REGISTRATION_OUTCOME_PARAMETER],
    ),
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { githubAppRegistration } = installationIntegrationsRoute
      .useSearch();
    return (
      <InstallationIntegrationsPage outcome={githubAppRegistration ?? null} />
    );
  },
  errorComponent: ProtectedRouteError,
});

const installationAuditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/audit",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InstallationBreadcrumbs section="settings.audit.section">
      <AuditEventsPage scope="installation" />
    </InstallationBreadcrumbs>
  ),
  errorComponent: ProtectedRouteError,
});

const organizationAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/access",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: OrganizationAccessPage,
  errorComponent: ProtectedRouteError,
});

const organizationRepositoryRulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/repository-rules",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: OrganizationRepositoryRulesPage,
  errorComponent: ProtectedRouteError,
});

const organizationRepositoryRuleEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/repository-rules/$ruleKey",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: OrganizationRepositoryRuleEditorPage,
  errorComponent: ProtectedRouteError,
});

const organizationSsoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/sso",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: SsoPage,
  errorComponent: ProtectedRouteError,
});

const organizationRolesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/roles",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: OrganizationRolesPage,
  errorComponent: ProtectedRouteError,
});

const organizationIntegrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/integrations",
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    githubConnection?: ReturnType<typeof parseConnectionOutcome>;
    connectionId?: string;
  } => {
    const connectionId = search[CONNECTION_ID_PARAMETER];
    return {
      githubConnection: parseConnectionOutcome(
        search[CONNECTION_OUTCOME_PARAMETER],
      ),
      connectionId: typeof connectionId === "string" && isUuid(connectionId)
        ? connectionId
        : undefined,
    };
  },
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { githubConnection, connectionId } = organizationIntegrationsRoute
      .useSearch();
    return (
      <OrganizationIntegrationsPage
        connectionId={connectionId ?? null}
        outcome={githubConnection ?? null}
      />
    );
  },
  errorComponent: ProtectedRouteError,
});

const settingsAuditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/audit",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.audit">
      <AuditEventsPage scope="organization" />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const settingsScimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/scim",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InOrganization section="shell.navigation.scimShort">
      <ScimConnectionPage />
    </InOrganization>
  ),
  errorComponent: ProtectedRouteError,
});

const artifactRetrievalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId/artifacts/$artifactId",
  validateSearch: (
    search: Record<string, unknown>,
  ): { version?: string; comment?: string } => ({
    version: typeof search.version === "string" ? search.version : undefined,
    comment: typeof search.comment === "string" ? search.comment : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { artifactId, taskId } = artifactRetrievalRoute.useParams();
    return <ArtifactRetrievalPage artifactId={artifactId} taskId={taskId} />;
  },
  errorComponent: ProtectedRouteError,
});

/** `search.<flag>` is `true` when written by `navigate({ search })` and `"1"` when typed into the address bar as `?flag=1`. */
function searchFlag(value: unknown): boolean {
  return value === true || value === "1" || value === 1;
}

const securityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/security",
  validateSearch: (
    search: Record<string, unknown>,
  ): { confirmed?: boolean } => ({
    confirmed: searchFlag(search.confirmed) || undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { confirmed } = securityRoute.useSearch();
    return (
      <InSettings section="shell.navigation.security">
        <SecurityHubPage confirmed={confirmed === true} />
      </InSettings>
    );
  },
  errorComponent: ProtectedRouteError,
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/sessions",
  validateSearch: (
    search: Record<string, unknown>,
  ): { revoked?: boolean } => ({
    revoked: searchFlag(search.revoked) || undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { revoked } = sessionsRoute.useSearch();
    return (
      <InSettings section="shell.navigation.sessions">
        <SessionsSettingsPage revoked={revoked === true} />
      </InSettings>
    );
  },
  errorComponent: ProtectedRouteError,
});

const revokeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/sessions/revoke",
  validateSearch: (
    search: Record<string, unknown>,
  ): { session?: string } => ({
    session: typeof search.session === "string" && isUuid(search.session)
      ? search.session
      : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { session } = revokeRoute.useSearch();
    return (
      <InSettings section="shell.navigation.sessions">
        <RevokeSessionsPage sessionId={session ?? null} />
      </InSettings>
    );
  },
  errorComponent: ProtectedRouteError,
});

const twoFactorSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/security/two-factor",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.security">
      <TwoFactorSettingsPage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const totpSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/security/two-factor/setup",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.security">
      <TotpSetupPage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const backupCodesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/security/two-factor/backup-codes",
  validateSearch: (
    search: Record<string, unknown>,
  ): { regenerate?: boolean } => ({
    regenerate: searchFlag(search.regenerate) || undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { regenerate } = backupCodesRoute.useSearch();
    return (
      <InSettings section="shell.navigation.security">
        <BackupCodesPage regenerate={regenerate === true} />
      </InSettings>
    );
  },
  errorComponent: ProtectedRouteError,
});

const totpDisableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/security/two-factor/disable",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.security">
      <TotpDisablePage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const passwordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/security/password",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.security">
      <ChangePasswordPage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const passkeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/security/passkeys",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.security">
      <PasskeysPage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const passkeyAddRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/security/passkeys/new",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InSettings section="shell.navigation.security">
      <AddPasskeyPage />
    </InSettings>
  ),
  errorComponent: ProtectedRouteError,
});

const reauthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account/reauthenticate",
  validateSearch: (
    search: Record<string, unknown>,
  ): { returnTo?: string } => ({
    returnTo: typeof search.returnTo === "string" ? search.returnTo : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { returnTo } = reauthRoute.useSearch();
    return <ReauthPage returnTo={returnTo ?? null} />;
  },
  errorComponent: ProtectedRouteError,
});

const clientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/clients",
  validateSearch: (
    search: Record<string, unknown>,
  ): { revoked?: boolean } => ({
    revoked: searchFlag(search.revoked) || undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { revoked } = clientsRoute.useSearch();
    const navigate = useNavigate();
    return (
      <InSettings section="shell.navigation.clients">
        <ConnectedClientsPage
          onRevoke={(grant) =>
            void navigate({ to: REVOKE_CLIENT_PATH, search: { grant } })}
          revoked={revoked === true}
        />
      </InSettings>
    );
  },
  errorComponent: ProtectedRouteError,
});

const revokeClientRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/clients/revoke",
  validateSearch: (
    search: Record<string, unknown>,
  ): { grant?: string } => ({
    grant: typeof search.grant === "string" && isUuid(search.grant)
      ? search.grant
      : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { grant } = revokeClientRoute.useSearch();
    const navigate = useNavigate();
    return (
      <InSettings section="shell.navigation.clients">
        {grant === undefined
          ? <Navigate replace to={CONNECTED_CLIENTS_PATH} />
          : (
            <RevokeClientPage
              grantId={grant}
              onCancel={() => void navigate({ to: CONNECTED_CLIENTS_PATH })}
              onDone={() =>
                void navigate({
                  to: CONNECTED_CLIENTS_PATH,
                  search: { revoked: true },
                })}
            />
          )}
      </InSettings>
    );
  },
  errorComponent: ProtectedRouteError,
});

const oauthConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/oauth/consent",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const api = useBakeryApi();
    const gateway = useMemo(() => createConsentGateway(api), [api]);
    return <OAuthConsentPage gateway={gateway} />;
  },
  errorComponent: ProtectedRouteError,
});

const machinesFixtureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/machines/$state",
  component: MachinesFixture,
});
const machinesDetailFixtureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/machines/detail",
  component: MachinesFixture,
});
const apiBoundaryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/api-boundary",
  component: ApiBoundaryFixture,
});

const cacheScopeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/cache-scope",
  component: CacheScopeFixture,
});

const shellStateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/shell/$state",
  component: ShellStateFixture,
});

const authStateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/auth/$state",
  component: AuthStateFixture,
});

const installationSettingsFixtureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/installation/settings",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: InstallationSettingsPage,
  errorComponent: ProtectedRouteError,
});

const organizationAccessFixtureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/organization/access",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: OrganizationAccessPage,
  errorComponent: ProtectedRouteError,
});

const organizationSsoFixtureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/organization/sso",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: SsoPage,
  errorComponent: ProtectedRouteError,
});

function settingsComponent(kind: SettingsFixtureKind) {
  return function SettingsRouteComponent() {
    return <SettingsFixturePage kind={kind} />;
  };
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings",
  component: settingsComponent("index"),
});
const settingsProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings/profile",
  component: settingsComponent("profile"),
});
const settingsSecurityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings/security",
  component: settingsComponent("security"),
});
const settingsPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings/security/password",
  component: settingsComponent("password"),
});
const settingsEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings/security/email",
  component: settingsComponent("email"),
});
const settingsSessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings/sessions",
  component: settingsComponent("sessions"),
});
const settingsClientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings/clients",
  component: settingsComponent("clients"),
});
const settingsAppearanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings/appearance",
  component: settingsComponent("appearance"),
});
const settingsAccessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/settings/access",
  component: settingsComponent("access"),
});
const organizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/organization",
  component: OrganizationFixture,
});

const workQueueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/work/queue",
  component: WorkQueueFixture,
});

const workSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/work/session",
  component: WorkSessionFixture,
});

const workConversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/work/conversation/$state",
  component: TaskConversationFixture,
});

const workCoordinationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/work/coordination/$state",
  component: TaskCoordinationFixture,
});

const workOnboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/work/onboarding/$state",
  component: ProjectsOnboardingFixture,
});

const artifactFixtureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/artifacts/artifact/$state",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <ArtifactFixture state={globalThis.location.pathname.split("/").at(-1)} />
  ),
});

const developmentRoutes = [
  machinesFixtureRoute,
  machinesDetailFixtureRoute,
  artifactFixtureRoute,
  apiBoundaryRoute,
  cacheScopeRoute,
  shellStateRoute,
  authStateRoute,
  installationSettingsFixtureRoute,
  organizationAccessFixtureRoute,
  organizationSsoFixtureRoute,
  settingsRoute,
  settingsProfileRoute,
  settingsSecurityRoute,
  settingsPasswordRoute,
  settingsEmailRoute,
  settingsSessionsRoute,
  settingsClientsRoute,
  settingsAppearanceRoute,
  settingsAccessRoute,
  organizationRoute,
  workQueueRoute,
  workSessionRoute,
  workConversationRoute,
  workCoordinationRoute,
  workOnboardingRoute,
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/__fixtures__/artifacts/task-run/$state",
    component: RunOutputFixture,
  }),
] as const;

const routeTree = rootRoute.addChildren([
  tasksRoute,
  taskNewRoute,
  taskDetailRoute,
  taskCoordinationRoute,
  machinesRoute,
  machineDetailRoute,
  statusRoute,
  settingsIndexRoute,
  profileRoute,
  appearanceRoute,
  accessRoute,
  setupRoute,
  signInRoute,
  totpChallengeRoute,
  recoveryCodeRoute,
  signOutRoute,
  registerRoute,
  invitationRoute,
  organizationsRoute,
  organizationSettingsRoute,
  installationSettingsRoute,
  installationAuditRoute,
  installationIntegrationsRoute,
  organizationAccessRoute,
  organizationIntegrationsRoute,
  organizationRolesRoute,
  organizationRepositoryRulesRoute,
  organizationRepositoryRuleEditorRoute,
  organizationSsoRoute,
  settingsAuditRoute,
  settingsScimRoute,
  projectsOnboardingRoute,
  artifactRetrievalRoute,
  securityRoute,
  sessionsRoute,
  revokeRoute,
  twoFactorSettingsRoute,
  totpSetupRoute,
  backupCodesRoute,
  totpDisableRoute,
  passwordRoute,
  passkeysRoute,
  passkeyAddRoute,
  reauthRoute,
  clientsRoute,
  revokeClientRoute,
  oauthConsentRoute,
  ...(import.meta.env.DEV ? developmentRoutes : []),
]);

// DEV-only hook: the browser specs compare the route manifest against the
// running app. A built preview serves no /src modules, so the spec reads the
// same coverage data from here instead of importing source files.
if (import.meta.env.DEV && typeof window !== "undefined") {
  Object.defineProperty(window, "__bakeryRouteCoverage", {
    configurable: true,
    value: { routeCoverage, shellFixtureStates, authFixtureStates },
  });
}

export const router = createRouter({
  routeTree,
  defaultPendingMs: 0,
  // Populated per render by `<RouterProvider context={{ api, session }} />`
  // in `main.tsx`, once those singletons exist; `createRouter` only needs a
  // value satisfying the type.
  context: undefined as unknown as RouterContext,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
