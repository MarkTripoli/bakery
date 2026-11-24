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
import { IssuePage } from "./pages/IssuePage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { BatchesListPage } from "./pages/BatchesListPage.tsx";
import { BatchPage } from "./pages/BatchPage.tsx";
import { BatchStartPage } from "./pages/BatchStartPage.tsx";
import { IssuesPage } from "./pages/IssuesPage.tsx";
import { IssueSettingsListPage } from "./pages/IssueSettingsListPage.tsx";
import { IssueSettingsPage } from "./pages/IssueSettingsPage.tsx";
import { LibraryPage } from "./pages/LibraryPage.tsx";
import { FilesPage } from "./pages/FilesPage.tsx";
import { FileVersionPage } from "./pages/FileVersionPage.tsx";
import { folderPathOf } from "./pages/files/files-state.ts";
import { AgentPage } from "./pages/AgentPage.tsx";
import { EvaluationRunPage } from "./pages/EvaluationRunPage.tsx";
import { SkillPage } from "./pages/SkillPage.tsx";
import { skillFilter, skillSearch } from "./pages/library/skills-state.ts";
import { BuiltInWorkflowPage } from "./pages/BuiltInWorkflowPage.tsx";
import { WorkflowPage } from "./pages/WorkflowPage.tsx";
import { MachinesPage } from "./pages/MachinesPage.tsx";
import { MachineDetailPage } from "./pages/MachineDetailPage.tsx";
import { MachineModelNewPage } from "./pages/MachineModelNewPage.tsx";
import { MachineWizardPage } from "./pages/MachineWizardPage.tsx";
import { TaskCoordinationPage } from "./pages/task-coordination/TaskCoordinationPage.tsx";
import { WorkflowEditorPage } from "./pages/library/WorkflowEditorPage.tsx";
import { AppearancePage } from "./pages/AppearancePage.tsx";
import { HealthPage } from "./pages/HealthPage.tsx";
import { SetupPage } from "./pages/SetupPage.tsx";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage.tsx";
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
import { OrganizationStoragePage } from "./pages/OrganizationStoragePage.tsx";
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
import { RepositoryPage } from "./pages/RepositoryPage.tsx";
import { RepositoryRulesPage } from "./pages/RepositoryRulesPage.tsx";
import { OrganizationRolesPage } from "./pages/OrganizationRolesPage.tsx";
import { PluginFramePage } from "./pages/PluginFramePage.tsx";
import { PluginPage } from "./pages/PluginPage.tsx";
import { PluginsPage } from "./pages/PluginsPage.tsx";
import {
  CONNECTION_ID_PARAMETER,
  CONNECTION_OUTCOME_PARAMETER,
  OrganizationIntegrationsPage,
  parseConnectionOutcome,
} from "./pages/OrganizationIntegrationsPage.tsx";
import { ConnectionPage } from "./pages/integrations/ConnectionPage.tsx";
import { SsoPage } from "./pages/SsoPage.tsx";
import { InstallationSettingsPage } from "./pages/InstallationSettingsPage.tsx";
import { InstallationMonitoringPage } from "./pages/InstallationMonitoringPage.tsx";
import { MonitoringDestinationPage } from "./pages/MonitoringDestinationPage.tsx";
import { InstallationBackupsPage } from "./pages/InstallationBackupsPage.tsx";
import { InstallationRestorePage } from "./pages/InstallationRestorePage.tsx";
import { InstallationUpdatesPage } from "./pages/InstallationUpdatesPage.tsx";
import { InstallationUsagePage } from "./pages/InstallationUsagePage.tsx";
import { DeliveryPage } from "./pages/DeliveryPage.tsx";
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
import { NotificationOpening } from "./notifications/NotificationOpening.tsx";
import { NotificationsPage } from "./notifications/NotificationsPage.tsx";
import { type LandingSearch, landingSearch } from "./notifications/landing.ts";
import { isNotificationView } from "./notifications/presentation.ts";
import { OAuthConsentPage } from "./pages/OAuthConsentPage.tsx";
import { createConsentGateway } from "./app/consent-gateway.ts";
import { ApiBoundaryFixture } from "./fixtures/ApiBoundaryFixture.tsx";
import { MachinesFixture } from "./fixtures/MachinesFixture.tsx";
import { SessionThreadFixture } from "./fixtures/SessionThreadFixture.tsx";
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
    id: "delivery",
    path: "/delivery",
    classification: "production",
    // Not a fifth kind of failure: `partial` is the page with figures and a
    // note that some records are missing, and `degraded` is a source that
    // stopped, whose figures are unknown rather than zero.
    states: [
      "loading",
      "default",
      "partial",
      "degraded",
      "stale",
      "empty",
      "error",
      "forbidden",
    ],
  },
  {
    id: "files",
    path: "/files",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "files-version",
    path: "/files/versions/$versionId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "files-folder",
    path: "/files/$",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "library",
    path: "/library",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "library-workflow",
    path: "/library/workflows/$workflowId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "library-workflow-editor",
    path: "/library/workflows/$workflowId/edit",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
    ],
  },
  {
    id: "library-builtin",
    path: "/library/built-in/$presetId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "library-agent",
    path: "/library/agents/$agentId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "library-skill",
    path: "/library/skills/$skillId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "library-evaluation",
    path: "/library/evaluations/$batchId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "issues",
    path: "/issues",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
    ],
  },
  {
    id: "batches",
    path: "/issues/batches",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
    ],
  },
  {
    id: "batch-new",
    path: "/issues/batches/new",
    classification: "production",
    states: [
      "ready",
      "error",
      "forbidden",
      "offline",
    ],
  },
  {
    id: "batch-detail",
    path: "/issues/batches/$batchId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "issue-detail",
    path: "/issues/$issueId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "issue-settings",
    path: "/issues/settings",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
    ],
  },
  {
    id: "issue-settings-detail",
    path: "/issues/settings/$sourceId",
    classification: "production",
    states: [
      "loading",
      "ready",
      "error",
      "forbidden",
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
    id: "machine-new",
    path: "/machines/new",
    classification: "production",
    states: [
      "loading",
      "ready",
      "reconnecting",
      "error",
      "forbidden",
      "offline",
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
    id: "machine-models",
    path: "/machines/$machineId/models",
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
    id: "machine-model-new",
    path: "/machines/$machineId/models/new",
    classification: "production",
    states: [
      "loading",
      "ready",
      "error",
      "forbidden",
      "offline",
    ],
  },
  {
    id: "notifications",
    path: "/notifications",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "offline",
      "long-copy",
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
    id: "projects",
    path: "/projects",
    classification: "production",
    states: [
      "loading",
      "ready",
      "empty",
      "error",
      "forbidden",
      "offline",
      "long-copy",
    ],
  },
  {
    id: "repository",
    path: "/projects/repositories/$repositoryId",
    classification: "production",
    states: ["loading", "default", "error", "forbidden", "offline"],
  },
  {
    id: "repository-rules",
    path: "/projects/repositories/$repositoryId/rules",
    classification: "production",
    states: ["loading", "default", "empty", "error", "forbidden"],
  },
  {
    id: "sign-in",
    path: "/sign-in",
    classification: "production",
    states: [
      "github-disabled",
      "invalid",
      "loading",
      "rate-limited",
      "blocked",
      "offline",
      "unavailable",
      "expired",
      "factor-required",
    ],
  },
  {
    id: "forgot-password",
    path: "/sign-in/forgot-password",
    classification: "production",
    states: ["default"],
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
    id: "installation-monitoring-new",
    path: "/installation/monitoring/new",
    classification: "production",
    states: ["loading", "default", "error", "forbidden"],
  },
  {
    id: "installation-monitoring-destination",
    path: "/installation/monitoring/$destinationId",
    classification: "production",
    states: ["loading", "default", "error", "forbidden", "unavailable"],
  },
  {
    id: "installation-monitoring",
    path: "/installation/monitoring",
    classification: "production",
    states: ["loading", "default", "empty", "error", "forbidden"],
  },
  {
    id: "installation-usage",
    path: "/installation/usage",
    classification: "production",
    // `unknown` is not a fifth kind of failure: it is the state where the
    // records exist but Bakery cannot say how complete they are, and the page
    // must still render figures with that warning rather than an error.
    states: [
      "loading",
      "default",
      "partial",
      "degraded",
      "empty",
      "error",
      "forbidden",
    ],
  },
  {
    id: "installation-restore",
    path: "/installation/restore",
    classification: "production",
    // `complete` is a restore whose steps have all been taken; `empty` is the
    // page opened when no restore ever held this installation.
    states: [
      "loading",
      "default",
      "busy",
      "complete",
      "empty",
      "error",
      "forbidden",
    ],
  },
  {
    id: "installation-backups",
    path: "/installation/backups",
    classification: "production",
    states: [
      "loading",
      "default",
      "busy",
      "empty",
      "error",
      "forbidden",
    ],
  },
  {
    id: "installation-updates",
    path: "/installation/updates",
    classification: "production",
    // `empty` is an installation with no update history yet; `forbidden` is
    // the app's no-access page for anyone who is not an administrator.
    states: ["loading", "default", "empty", "error", "forbidden"],
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
    id: "settings-organization-access-invitations",
    path: "/settings/organization/access/invitations",
    classification: "production",
    states: ["loading", "default", "empty", "error", "forbidden"],
  },
  {
    id: "settings-organization-service-accounts",
    path: "/settings/organization/service-accounts",
    classification: "production",
    states: ["loading", "default", "empty", "error"],
  },
  {
    id: "settings-organization-roles",
    path: "/settings/organization/roles",
    classification: "production",
    states: ["loading", "default", "error", "forbidden"],
  },
  {
    id: "settings-organization-plugins",
    path: "/settings/organization/plugins",
    classification: "production",
    states: ["loading", "default", "empty", "error"],
  },
  {
    id: "settings-organization-plugin",
    path: "/settings/organization/plugins/$installId",
    classification: "production",
    states: ["loading", "default", "error"],
  },
  {
    id: "plugin-page",
    path: "/plugins/$installId/$pageId",
    classification: "production",
    states: ["loading", "default", "error", "denied", "stale"],
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
    id: "settings-organization-integration-connection",
    path: "/settings/organization/integrations/$connectionId",
    classification: "production",
    states: ["loading", "default", "error", "forbidden"],
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
    id: "organization-storage",
    path: "/organization/storage",
    classification: "production",
    states: [
      "loading",
      "ready",
      "default",
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
    id: "clients-redirect",
    path: "/settings/clients",
    classification: "production",
    states: ["redirect"],
  },
  {
    id: "settings-organization-integrations-clients",
    path: "/settings/organization/integrations/clients",
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
    id: "fixture-session-thread",
    path: "/__fixtures__/session-thread/$state",
    classification: "fixture",
    states: [
      "default",
      "loading",
      "empty",
      "error",
      "failed",
      "complete",
      "reconnecting",
    ],
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

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: ProjectsPage,
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
  // `at`, `gone`, `n` and `r` carry a notification's landing (see landing.ts).
  validateSearch: (search: Record<string, unknown>) => landingSearch(search),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const landing = taskDetailRoute.useSearch();
    const navigate = taskDetailRoute.useNavigate();
    return (
      <TasksPage
        taskId={taskDetailRoute.useParams().taskId}
        landing={landing}
        stripLanding={() =>
          void navigate({
            search: (previous) => ({ ...previous, n: undefined, r: undefined }),
            replace: true,
          })}
      />
    );
  },
  errorComponent: ProtectedRouteError,
});

const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/workflows/$workflowId/edit",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <WorkflowEditorPage
      workflowId={workflowEditorRoute.useParams().workflowId}
    />
  ),
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

const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues",
  // `?choose=true` opens the Choose repositories sheet (an issue whose
  // repository is off sends an administrator there).
  validateSearch: (search: Record<string, unknown>) => ({
    choose: search.choose === true || search.choose === "true"
      ? true
      : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: IssuesPage,
  errorComponent: ProtectedRouteError,
});

const batchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues/batches",
  // `?repository=<id>` narrows the list to one repository.
  validateSearch: (search: Record<string, unknown>) => ({
    repository:
      typeof search.repository === "string" && search.repository !== ""
        ? search.repository
        : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: BatchesListPage,
  errorComponent: ProtectedRouteError,
});

const batchNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues/batches/new",
  // `?repository=<id>` preselects the repository.
  validateSearch: (search: Record<string, unknown>) => ({
    repository:
      typeof search.repository === "string" && search.repository !== ""
        ? search.repository
        : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: BatchStartPage,
  errorComponent: ProtectedRouteError,
});

const batchDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues/batches/$batchId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <BatchPage batchId={batchDetailRoute.useParams().batchId} />,
  errorComponent: ProtectedRouteError,
});

const issueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues/$issueId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <IssuePage issueId={issueDetailRoute.useParams().issueId} />,
  errorComponent: ProtectedRouteError,
});

const issueSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues/settings",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: IssueSettingsListPage,
  errorComponent: ProtectedRouteError,
});

const issueSettingsDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/issues/settings/$sourceId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <IssueSettingsPage
      sourceId={issueSettingsDetailRoute.useParams().sourceId}
    />
  ),
  errorComponent: ProtectedRouteError,
});

/** `?file=<id>&tab=versions|uses`: the file whose details are open, and its tab. */
function validateFilesSearch(
  search: Record<string, unknown>,
): {
  file?: string;
  tab?: "versions" | "uses";
  version?: number;
  q?: string;
  type?: "text" | "image" | "video" | "audio" | "data" | "archive" | "other";
  kind?: string;
  by?: string;
  fact?: string;
  view?: "open";
  in?: "all";
} {
  return {
    ...(typeof search.file === "string" && search.file !== ""
      ? { file: search.file }
      : {}),
    ...(search.tab === "versions" || search.tab === "uses"
      ? { tab: search.tab }
      : {}),
    ...(typeof search.q === "string" && search.q !== "" ? { q: search.q } : {}),
    ...(typeof search.type === "string" &&
        ["text", "image", "video", "audio", "data", "archive", "other"]
          .includes(search.type)
      ? { type: search.type as "text" }
      : {}),
    ...(typeof search.kind === "string" && search.kind !== ""
      ? { kind: search.kind.slice(0, 64) }
      : {}),
    ...(typeof search.by === "string" && search.by !== ""
      ? { by: search.by.slice(0, 64) }
      : {}),
    ...(search.view === "open" ? { view: "open" as const } : {}),
    ...(typeof search.fact === "string" && search.fact.includes(":")
      ? { fact: search.fact.slice(0, 700) }
      : {}),
    ...(search.in === "all" ? { in: "all" as const } : {}),
    ...(Number.isInteger(Number(search.version)) && Number(search.version) > 0
      ? { version: Number(search.version) }
      : {}),
  };
}

const deliveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/delivery",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <DeliveryPage />,
  errorComponent: ProtectedRouteError,
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files",
  validateSearch: validateFilesSearch,
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <FilesPage path="" />,
  errorComponent: ProtectedRouteError,
});

const fileVersionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files/versions/$versionId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <FileVersionPage versionId={fileVersionRoute.useParams().versionId} />
  ),
  errorComponent: ProtectedRouteError,
});

const filesPathRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files/$",
  validateSearch: validateFilesSearch,
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <FilesPage path={folderPathOf(filesPathRoute.useParams()._splat)} />
  ),
  errorComponent: ProtectedRouteError,
});

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  // `?tab=agents` opens the Agents list; Workflows is the page itself.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?: "agents" | "skills" | "memory" | "evaluations";
    fact?: string;
    scope?: "global" | "organization" | "personal";
    q?: string;
  } => {
    if (search.tab === "agents") return { tab: "agents" };
    if (search.tab === "evaluations") return { tab: "evaluations" };
    // The Skills tab keeps its filter and its name search in the URL.
    if (search.tab === "skills") {
      const filter = skillFilter(search.scope);
      const q = skillSearch(search.q);
      return {
        tab: "skills",
        ...(filter === "all" ? {} : { scope: filter }),
        ...(q === undefined ? {} : { q }),
      };
    }
    if (search.tab !== "memory") return {};
    // An open fact is only meaningful on the Memory tab.
    return typeof search.fact === "string" && search.fact !== ""
      ? { tab: "memory", fact: search.fact }
      : { tab: "memory" };
  },
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: LibraryPage,
  errorComponent: ProtectedRouteError,
});

const workflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/workflows/$workflowId",
  // `?version=` is the version being viewed.
  validateSearch: (search: Record<string, unknown>): { version?: string } =>
    typeof search.version === "string" && isUuid(search.version)
      ? { version: search.version }
      : {},
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <WorkflowPage workflowId={workflowRoute.useParams().workflowId} />
  ),
  errorComponent: ProtectedRouteError,
});

const builtInWorkflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/built-in/$presetId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <BuiltInWorkflowPage
      presetId={builtInWorkflowRoute.useParams().presetId}
    />
  ),
  errorComponent: ProtectedRouteError,
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/agents/$agentId",
  // `?version=` is the version being viewed.
  validateSearch: (search: Record<string, unknown>): { version?: string } =>
    typeof search.version === "string" && isUuid(search.version)
      ? { version: search.version }
      : {},
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <AgentPage agentId={agentRoute.useParams().agentId} />,
  errorComponent: ProtectedRouteError,
});

const skillRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/skills/$skillId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <SkillPage skillId={skillRoute.useParams().skillId} />,
  errorComponent: ProtectedRouteError,
});

const evaluationRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/evaluations/$batchId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <EvaluationRunPage batchId={evaluationRunRoute.useParams().batchId} />
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

const machineNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/new",
  validateSearch: (search: Record<string, unknown>) => ({
    finish: typeof search.finish === "string" && isUuid(search.finish)
      ? search.finish
      : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <MachineWizardPage finishId={machineNewRoute.useSearch().finish} />
  ),
  errorComponent: ProtectedRouteError,
});

const machineDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/$machineId",
  validateSearch: (
    search: Record<string, unknown>,
  ): { signIn?: "claude" | "codex" | "pi" } => {
    const agent = search.signIn;
    return agent === "claude" || agent === "codex" || agent === "pi"
      ? { signIn: agent }
      : {};
  },
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <MachineDetailPage
      machineId={machineDetailRoute.useParams().machineId}
      signInAgent={machineDetailRoute.useSearch().signIn}
    />
  ),
  errorComponent: ProtectedRouteError,
});

const machineModelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/$machineId/models",
  validateSearch: (search: Record<string, unknown>): { added?: true } =>
    search.added === true || search.added === "true" ? { added: true } : {},
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <MachineDetailPage
      machineId={machineModelsRoute.useParams().machineId}
      tab="models"
      justAdded={machineModelsRoute.useSearch().added === true}
    />
  ),
  errorComponent: ProtectedRouteError,
});

const machineModelNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/$machineId/models/new",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <MachineModelNewPage
      machineId={machineModelNewRoute.useParams().machineId}
    />
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

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in/forgot-password",
  component: ForgotPasswordPage,
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

const organizationStorageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organization/storage",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: OrganizationStoragePage,
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

const installationMonitoringRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/monitoring",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InstallationBreadcrumbs section="shell.navigation.monitoring">
      <InstallationMonitoringPage />
    </InstallationBreadcrumbs>
  ),
  errorComponent: ProtectedRouteError,
});

const installationMonitoringNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/monitoring/new",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  // The page claims its own breadcrumbs: the last crumb is its name.
  component: () => <MonitoringDestinationPage />,
  errorComponent: ProtectedRouteError,
});

const installationMonitoringDestinationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/monitoring/$destinationId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  // The page claims its own breadcrumbs: the last crumb is its name.
  component: () => <MonitoringDestinationPage />,
  errorComponent: ProtectedRouteError,
});

const installationUsageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/usage",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InstallationBreadcrumbs section="installation.usage.title">
      <InstallationUsagePage />
    </InstallationBreadcrumbs>
  ),
  errorComponent: ProtectedRouteError,
});

const installationRestoreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/restore",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InstallationBreadcrumbs section="installation.restore.title">
      <InstallationRestorePage />
    </InstallationBreadcrumbs>
  ),
  errorComponent: ProtectedRouteError,
});

const installationBackupsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/backups",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InstallationBreadcrumbs section="installation.backups.title">
      <InstallationBackupsPage />
    </InstallationBreadcrumbs>
  ),
  errorComponent: ProtectedRouteError,
});

const installationUpdatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/installation/updates",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <InstallationBreadcrumbs section="installation.updates.title">
      <InstallationUpdatesPage />
    </InstallationBreadcrumbs>
  ),
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
  component: () => <OrganizationAccessPage tab="members" />,
  errorComponent: ProtectedRouteError,
});

const organizationServiceAccountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/service-accounts",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <OrganizationAccessPage page="service-accounts" />,
  errorComponent: ProtectedRouteError,
});

const organizationInvitationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/access/invitations",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => <OrganizationAccessPage tab="invitations" />,
  errorComponent: ProtectedRouteError,
});

const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/repositories/$repositoryId",
  // The readiness check the page shows; a value that is not an identifier is dropped.
  validateSearch: (search: Record<string, unknown>) => ({
    check: typeof search.check === "string" && isUuid(search.check)
      ? search.check
      : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <RepositoryPage repositoryId={repositoryRoute.useParams().repositoryId} />
  ),
  errorComponent: ProtectedRouteError,
});

const repositoryRulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/repositories/$repositoryId/rules",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => (
    <RepositoryRulesPage
      repositoryId={repositoryRulesRoute.useParams().repositoryId}
    />
  ),
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

const organizationPluginsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/plugins",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: PluginsPage,
  errorComponent: ProtectedRouteError,
});

const organizationPluginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/plugins/$installId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { installId } = organizationPluginRoute.useParams();
    return <PluginPage installId={installId} />;
  },
  errorComponent: ProtectedRouteError,
});

const pluginFrameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugins/$installId/$pageId",
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { installId, pageId } = pluginFrameRoute.useParams();
    return <PluginFramePage installId={installId} pageId={pageId} />;
  },
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

const organizationIntegrationConnectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/integrations/$connectionId",
  validateSearch: (
    search: Record<string, unknown>,
  ): { githubConnection?: ReturnType<typeof parseConnectionOutcome> } => ({
    githubConnection: parseConnectionOutcome(
      search[CONNECTION_OUTCOME_PARAMETER],
    ),
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { connectionId } = organizationIntegrationConnectionRoute
      .useParams();
    const { githubConnection } = organizationIntegrationConnectionRoute
      .useSearch();
    return (
      <ConnectionPage
        connectionId={connectionId}
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
    <InOrganization section="shell.navigation.userProvisioning">
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
  ): { version?: string; comment?: string } & LandingSearch => ({
    version: typeof search.version === "string" ? search.version : undefined,
    comment: typeof search.comment === "string" ? search.comment : undefined,
    ...landingSearch(search),
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { artifactId, taskId } = artifactRetrievalRoute.useParams();
    const { version: _version, comment: _comment, ...landing } =
      artifactRetrievalRoute.useSearch();
    const navigate = artifactRetrievalRoute.useNavigate();
    return (
      <ArtifactRetrievalPage
        artifactId={artifactId}
        taskId={taskId}
        landing={landing}
        stripLanding={() =>
          void navigate({
            search: (previous) => ({ ...previous, n: undefined, r: undefined }),
            replace: true,
          })}
      />
    );
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
    <InSettings
      page="auth.twoFactor.sectionTitle"
      section="shell.navigation.security"
    >
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
    <InSettings
      page="auth.twoFactor.sectionTitle"
      section="shell.navigation.security"
    >
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
      <InSettings
        page="auth.twoFactor.sectionTitle"
        section="shell.navigation.security"
      >
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
    <InSettings
      page="auth.twoFactor.sectionTitle"
      section="shell.navigation.security"
    >
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
    <InSettings
      page="settings.password.title"
      section="shell.navigation.security"
    >
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
    <InSettings page="passkeys.title" section="shell.navigation.security">
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
    <InSettings page="passkeys.title" section="shell.navigation.security">
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

// Connected clients now live under Integrations (issue 233 split). The old
// path keeps working as a redirect so a bookmark or a link in an email does
// not dead-end.
const clientsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/clients",
  beforeLoad: ({ context, location }) => {
    requireSession(context.session, location);
    throw redirect({ to: "/settings/organization/integrations/clients" });
  },
  errorComponent: ProtectedRouteError,
});

const NOTIFICATIONS_PATH = "/notifications";

const notificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notifications",
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    view?: "all" | "unread" | "mentions";
    item?: string;
    open?: string;
    r?: number;
  } => ({
    view: isNotificationView(search.view) ? search.view : undefined,
    item: typeof search.item === "string" && isUuid(search.item)
      ? search.item
      : undefined,
    // `open` is a row being opened: resolved now, then replaced by its place.
    open: typeof search.open === "string" && isUuid(search.open)
      ? search.open
      : undefined,
    r: Number.isInteger(Number(search.r)) && Number(search.r) >= 1
      ? Number(search.r)
      : undefined,
  }),
  beforeLoad: ({ context, location }) =>
    requireSession(context.session, location),
  component: () => {
    const { view, item, open, r } = notificationsRoute.useSearch();
    const navigate = notificationsRoute.useNavigate();
    const landNavigate = useNavigate();
    if (open !== undefined) {
      return (
        <NotificationOpening
          id={open}
          revision={r ?? null}
          onLand={(destination) => {
            const { route, search } = destination;
            void (route.to === "/tasks/$taskId"
              ? landNavigate({
                to: route.to,
                params: route.params,
                search,
                replace: true,
              })
              : landNavigate({
                to: route.to,
                params: route.params,
                search,
                replace: true,
              }));
          }}
          onBack={() =>
            void navigate({
              to: NOTIFICATIONS_PATH,
              search: {},
              replace: true,
            })}
        />
      );
    }
    return (
      <NotificationsPage
        item={item ?? null}
        view={view ?? "all"}
        onViewChange={(next) =>
          void navigate({
            to: NOTIFICATIONS_PATH,
            search: { view: next === "all" ? undefined : next },
            replace: true,
          })}
      />
    );
  },
  errorComponent: ProtectedRouteError,
});

const clientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/organization/integrations/clients",
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
const sessionThreadFixtureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/__fixtures__/session-thread/$state",
  component: SessionThreadFixture,
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
  sessionThreadFixtureRoute,
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
  issuesRoute,
  issueDetailRoute,
  issueSettingsRoute,
  issueSettingsDetailRoute,
  batchesRoute,
  batchNewRoute,
  batchDetailRoute,
  machinesRoute,
  filesRoute,
  fileVersionRoute,
  filesPathRoute,
  libraryRoute,
  workflowRoute,
  workflowEditorRoute,
  builtInWorkflowRoute,
  agentRoute,
  skillRoute,
  evaluationRunRoute,
  machineNewRoute,
  machineDetailRoute,
  machineModelsRoute,
  machineModelNewRoute,
  statusRoute,
  settingsIndexRoute,
  profileRoute,
  appearanceRoute,
  accessRoute,
  setupRoute,
  signInRoute,
  forgotPasswordRoute,
  totpChallengeRoute,
  recoveryCodeRoute,
  signOutRoute,
  registerRoute,
  invitationRoute,
  organizationsRoute,
  organizationSettingsRoute,
  organizationStorageRoute,
  installationSettingsRoute,
  installationMonitoringRoute,
  installationMonitoringNewRoute,
  installationMonitoringDestinationRoute,
  installationUsageRoute,
  installationRestoreRoute,
  installationUpdatesRoute,
  installationBackupsRoute,
  deliveryRoute,
  installationAuditRoute,
  installationIntegrationsRoute,
  organizationAccessRoute,
  organizationInvitationsRoute,
  organizationServiceAccountsRoute,
  organizationIntegrationsRoute,
  organizationIntegrationConnectionRoute,
  organizationRolesRoute,
  organizationPluginsRoute,
  organizationPluginRoute,
  pluginFrameRoute,
  organizationRepositoryRulesRoute,
  repositoryRoute,
  repositoryRulesRoute,
  organizationRepositoryRuleEditorRoute,
  organizationSsoRoute,
  settingsAuditRoute,
  settingsScimRoute,
  projectsRoute,
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
  clientsRedirectRoute,
  notificationsRoute,
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
