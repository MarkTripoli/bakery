import type { CatalogActionName } from "./catalog-literals.ts";
import {
  WORKFLOW_ACTION_NAMES,
  type WorkflowActionName,
} from "./workflow-action-registry.ts";

export const AuthImplementedAction = Object.freeze(
  {
    OrganizationInvitationRecipientGet: "organizationInvitations.recipientGet",
    OrganizationInvitationRecipientAccept:
      "organizationInvitations.recipientAccept",
    OrganizationInvitationRecipientReject:
      "organizationInvitations.recipientReject",
    OrganizationInvitationPreview: "organizationInvitations.preview",
    IdentityGet: "identity.get",
    OrganizationsList: "organizations.list",
    OrganizationsCreate: "organizations.create",
    OrganizationsGet: "organizations.get",
    OrganizationsUpdate: "organizations.update",
    OrganizationsEffectiveAccess: "organizations.effectiveAccess",
    OrganizationMembershipsList: "organizationMemberships.list",
    OrganizationMembershipsCreate: "organizationMemberships.create",
    OrganizationMembershipsUpdate: "organizationMemberships.update",
    OrganizationMembershipsDelete: "organizationMemberships.delete",
    OrganizationInvitationsList: "organizationInvitations.list",
    OrganizationInvitationsCreate: "organizationInvitations.create",
    OrganizationInvitationsCancel: "organizationInvitations.cancel",
    InstallationStatus: "installation.status",
    BrowserSessionsList: "browserSessions.list",
    BrowserSessionsRevoke: "browserSessions.revoke",
    BrowserSessionsRevokeOthers: "browserSessions.revokeOthers",
    BrowserSessionsRevokeCurrent: "browserSessions.revokeCurrent",
    ConnectedClientsList: "connectedClients.list",
    ConnectedClientsRevoke: "connectedClients.revoke",
    ProfileGet: "profile.get",
    ProfileUpdate: "profile.update",
    UserPreferencesGet: "userPreferences.get",
    UserPreferencesUpdate: "userPreferences.update",
    InstallationCapabilities: "installation.capabilities",
    InstallationSettingsGet: "installationSettings.get",
    InstallationSettingsUpdate: "installationSettings.update",
    InstallationAdministratorsList: "installationAdministrators.list",
    InstallationAdministratorsCreate: "installationAdministrators.create",
    InstallationAdministratorsRevoke: "installationAdministrators.revoke",
    PasswordResetLinksCreate: "passwordResetLinks.create",
    PasswordResetsRedeem: "passwordResets.redeem",
    DesktopSignInsStart: "desktopSignIns.start",
    DesktopSignInsExchange: "desktopSignIns.exchange",
    DesktopHandoffsCreate: "desktopHandoffs.create",
    AuditEventsList: "auditEvents.list",
    AuditEventsExport: "auditEvents.export",
    AuditEventsStream: "auditEvents.stream",
    AuditRetentionGet: "auditRetention.get",
    AuditRetentionUpdate: "auditRetention.update",
    InstallationAuditEventsList: "installationAuditEvents.list",
    PrincipalsList: "principals.list",
    PrincipalsCreate: "principals.create",
    PrincipalsUpdate: "principals.update",
    PermissionGrantsList: "permissionGrants.list",
    PermissionGrantsCreate: "permissionGrants.create",
    PermissionGrantsDelete: "permissionGrants.delete",
    AccessTokensList: "accessTokens.list",
    AccessTokensCreate: "accessTokens.create",
    AccessTokensRevoke: "accessTokens.revoke",
    ScimConnectionGet: "scimConnection.get",
    ScimConnectionCreate: "scimConnection.create",
    ScimConnectionRotate: "scimConnection.rotate",
    ScimConnectionRevoke: "scimConnection.revoke",
    AccessBindingsList: "accessBindings.list",
    AccessBindingsCreate: "accessBindings.create",
    AccessBindingsDelete: "accessBindings.delete",
    OrganizationRolesList: "organizationRoles.list",
    OrganizationRolesCreate: "organizationRoles.create",
    OrganizationRolesUpdate: "organizationRoles.update",
    OrganizationRolesDelete: "organizationRoles.delete",
    OrganizationRolesAssign: "organizationRoles.assign",
    OrganizationRolesUnassign: "organizationRoles.unassign",
  } as const satisfies Record<string, CatalogActionName>,
);

export const TaskImplementedAction = Object.freeze(
  {
    TasksList: "tasks.list",
    TasksGet: "tasks.get",
    TasksCreate: "tasks.create",
    TasksUpdate: "tasks.update",
    TaskDependenciesCreate: "taskDependencies.create",
    TaskDependenciesDelete: "taskDependencies.delete",
    RunsCreate: "runs.create",
    RunsList: "runs.list",
    RunsGet: "runs.get",
    RunStepsList: "runSteps.list",
    WorkflowPresetsList: "workflowPresets.list",
    SyncSnapshot: "sync.snapshot",
    UsageList: "usage.list",
  } as const satisfies Record<string, CatalogActionName>,
);
export const CoordinationImplementedAction = Object.freeze(
  {
    CoordinationPlansCreate: "coordinationPlans.create",
    CoordinationPlansCreateFromWorkflow: "coordinationPlans.createFromWorkflow",
    CoordinationPlansList: "coordinationPlans.list",
    CoordinationPlansGet: "coordinationPlans.get",
    CoordinationPlansMaterialize: "coordinationPlans.materialize",
    CoordinationPlansCancel: "coordinationPlans.cancel",
    TaskRepositoriesList: "taskRepositories.list",
    TaskRepositoriesSet: "taskRepositories.set",
    ApplicationRepositoryRolesList: "applicationRepositoryRoles.list",
    ApplicationRepositoryRolesSet: "applicationRepositoryRoles.set",
  } as const satisfies Record<string, CatalogActionName>,
);
export const coordinationImplementedActions = Object.freeze(
  Object.values(CoordinationImplementedAction),
);
export const ExecutionImplementedAction = Object.freeze(
  {
    RunsControl: "runs.control",
    RunsControlCapabilities: "runs.controlCapabilities",
    SessionsGet: "sessions.get",
    SessionsList: "sessions.list",
    SessionsFeed: "sessions.feed",
    SessionsSteer: "sessions.steer",
    RunStepsNote: "runSteps.note",
    RunStepsTakeOver: "runSteps.takeOver",
    RunStepsRevertWrites: "runSteps.revertWrites",
    HandoffManifestsGet: "handoffManifests.get",
    HandoffManifestsContinue: "handoffManifests.continue",
    TranscriptStatus: "outputStreams.transcript",
  } as const satisfies Record<string, CatalogActionName>,
);

export const executionImplementedActions = Object.freeze(
  Object.values(ExecutionImplementedAction),
);
export const MachineImplementedAction = Object.freeze(
  {
    WorkersList: "workers.list",
    WorkersGet: "workers.get",
    WorkersEnroll: "workers.enroll",
    WorkerEnrollmentsList: "workerEnrollments.list",
    WorkerEnrollmentsGet: "workerEnrollments.get",
    WorkerEnrollmentsCancel: "workerEnrollments.cancel",
    WorkerEnrollmentsReplace: "workerEnrollments.replace",
    MachinesDispatchBlockers: "machines.dispatchBlockers",
    WorkerInspectEnrollment: "worker.inspectEnrollment",
    WorkerReportInventory: "worker.reportInventory",
    WorkerComponentsList: "workerComponents.list",
    WorkersRepairEnrollment: "workers.repairEnrollment",
    WorkerLinkPackage: "worker.linkPackage",
    WorkerInspectLinkCode: "worker.inspectLinkCode",
    WorkerCreateLinkRequest: "worker.createLinkRequest",
    WorkerPollLinkRequest: "worker.pollLinkRequest",
    WorkerLinkRequestsFind: "workerLinkRequests.find",
    WorkerLinkRequestsApprove: "workerLinkRequests.approve",
    WorkerLinkRequestsDecline: "workerLinkRequests.decline",
    WorkersRevoke: "workers.revoke",
    WorkersArchive: "workers.archive",
    WorkerMaintenanceCreate: "workerMaintenance.create",
    WorkerMaintenanceList: "workerMaintenance.list",
    WorkerMaintenanceGet: "workerMaintenance.get",
    WorkerMaintenanceCancel: "workerMaintenance.cancel",
    ModelProviderAccountsList: "modelProviderAccounts.list",
    WorkerProviderBindingsList: "workerProviderBindings.list",
    WorkerProviderBindingsCreate: "workerProviderBindings.create",
    WorkerProviderBindingsUpdate: "workerProviderBindings.update",
    WorkerProviderAuthCreate: "workerProviderAuth.create",
    WorkerProviderAuthGet: "workerProviderAuth.get",
    WorkerProviderAuthCancel: "workerProviderAuth.cancel",
    WorkerReportProviderAuth: "worker.reportProviderAuth",
    WorkerReportMaintenance: "worker.reportMaintenance",
    WorkersUpdate: "workers.update",
  } as const satisfies Record<string, CatalogActionName>,
);
export const machineImplementedActions = Object.freeze(
  Object.values(MachineImplementedAction),
);

export const ConversationImplementedAction = Object.freeze(
  {
    MessagesList: "messages.list",
    MessagesCreate: "messages.create",
    ConversationTurnsList: "conversationTurns.list",
    ConversationParticipantsList: "conversationParticipants.list",
    ConversationsList: "conversations.list",
    ConversationsGet: "conversations.get",
    ConversationsCreate: "conversations.create",
    ConversationsUpdate: "conversations.update",
    ConversationTurnsGet: "conversationTurns.get",
    ConversationTurnsCancel: "conversationTurns.cancel",
    QuestionsList: "questions.list",
    QuestionsGet: "questions.get",
    QuestionsAnswer: "questions.answer",
    ConversationsMentionCandidates: "conversations.mentionCandidates",
    ConversationAccessList: "conversationAccess.list",
    ConversationAccessRevoke: "conversationAccess.revoke",
    ConversationAccessSharers: "conversationAccess.sharers",
    WorkflowDefinitionProposalsList: "workflowDefinitionProposals.list",
  } as const satisfies Record<string, CatalogActionName>,
);

export const conversationImplementedActions = Object.freeze(
  Object.values(ConversationImplementedAction),
);

export const ApprovalImplementedAction = Object.freeze(
  {
    PlanRevisionsList: "planRevisions.list",
    PlanRevisionsGet: "planRevisions.get",
    ApprovalsList: "approvals.list",
    ApprovalsGet: "approvals.get",
    ApprovalsDecide: "approvals.decide",
    ApprovalsRevoke: "approvals.revoke",
  } as const satisfies Record<string, CatalogActionName>,
);
export const approvalImplementedActions = Object.freeze(
  Object.values(ApprovalImplementedAction),
);

export const OutputImplementedAction = Object.freeze(
  {
    StreamsList: "output.streams.list",
    StreamsRead: "output.streams.read",
  } as const satisfies Record<string, CatalogActionName>,
);
export const outputImplementedActions = Object.freeze(
  Object.values(OutputImplementedAction),
);

export const attemptReadImplementedActions = Object.freeze(
  ["jobAttempts.list"] as const satisfies readonly CatalogActionName[],
);

export const ProjectsImplementedAction = Object.freeze(
  {
    ApplicationsList: "applications.list",
    ApplicationsGet: "applications.get",
    ApplicationsCreate: "applications.create",
    ApplicationsUpdate: "applications.update",
    RepositoriesList: "repositories.list",
    RepositoriesGet: "repositories.get",
    RepositoriesCreate: "repositories.create",
    RepositoriesUpdate: "repositories.update",
    RepositoryProfilesList: "repositoryProfiles.list",
    RepositoryProfilesCreate: "repositoryProfiles.create",
    RepositoryRulesGetEffective: "repositoryRules.getEffective",
    RepositoryRulePreviewsCreateForRepository:
      "repositoryRulePreviews.createForRepository",
    RepositoriesOnboard: "repositories.onboard",
    RepositoryOnboardingsGet: "repositoryOnboardings.get",
    RepositoryObservationsGet: "repositoryObservations.get",
    RolesCreate: "projects.roles.create",
    RolesList: "projects.roles.list",
    RolesResolve: "projects.roles.resolve",
    RolesUpdate: "projects.roles.update",
    ScopeProfilesGet: "scopeProfiles.get",
    ScopeProfilesPut: "scopeProfiles.put",
  } as const satisfies Record<string, CatalogActionName>,
);

export const AgentImplementedAction = Object.freeze(
  {
    AgentsList: "agents.list",
    AgentsGet: "agents.get",
    AgentsCreate: "agents.create",
    AgentsUpdate: "agents.update",
    AgentsActivateVersion: "agents.activateVersion",
    AgentVersionsCreate: "agentVersions.create",
    AgentVersionsList: "agentVersions.list",
  } as const satisfies Record<string, CatalogActionName>,
);
export const agentImplementedActions = Object.freeze(
  Object.values(AgentImplementedAction),
);

/**
 * The provider route and incident reads (#26 slice 2).
 *
 * Slice 1 published the contracts and deliberately left every action out of this
 * set, so a catalogue entry could not tell a caller a feature existed with no
 * handler behind it. These five have handlers now, and nothing else about them
 * moves: they are reads, they take no body and they write no row.
 */
export const ProviderReadsImplementedAction = Object.freeze(
  {
    ProviderRoutesList: "providerRoutes.list",
    ProviderRoutesGet: "providerRoutes.get",
    ProviderRoutesHealth: "providerRoutes.health",
    ProviderIncidentsList: "providerIncidents.list",
    ProviderIncidentsGet: "providerIncidents.get",
  } as const satisfies Record<string, CatalogActionName>,
);
export const providerReadsImplementedActions = Object.freeze(
  Object.values(ProviderReadsImplementedAction),
);

/**
 * The provider route writes (#26 slice 2, writes).
 *
 * Kept apart from the reads because they are commands: Admin access, an
 * idempotency key, and an `If-Match` version on the update. An incident is not
 * here on purpose. Nothing a caller says opens or closes one; the host does,
 * after judging a probe result, so there is no operation to name.
 */
export const ProviderWritesImplementedAction = Object.freeze(
  {
    ProviderRoutesCreate: "providerRoutes.create",
    ProviderRoutesUpdate: "providerRoutes.update",
  } as const satisfies Record<string, CatalogActionName>,
);
export const providerWritesImplementedActions = Object.freeze(
  Object.values(ProviderWritesImplementedAction),
);

/**
 * The route continuation offers (#26 slice 6a).
 *
 * The offers read (which steps of a run are stalled behind a provider incident
 * and which routes they could continue on) and the admission command that acts on
 * an offer. The read decides nothing; the command is the one place a continuation
 * is admitted.
 */
export const RouteContinuationsImplementedAction = Object.freeze(
  {
    RouteContinuationsList: "routeContinuations.list",
    RouteContinuationsAdmit: "routeContinuations.admit",
  } as const satisfies Record<string, CatalogActionName>,
);
export const routeContinuationsImplementedActions = Object.freeze(
  Object.values(RouteContinuationsImplementedAction),
);

export const RepositoryRulesImplementedAction = Object.freeze(
  {
    RepositoryRulesGet: "repositoryRules.get",
    RepositoryRuleVersionsCreate: "repositoryRuleVersions.create",
    RepositoryRuleVersionsList: "repositoryRuleVersions.list",
    RepositoryRulePreviewsCreateForOrganization:
      "repositoryRulePreviews.createForOrganization",
  } as const satisfies Record<string, CatalogActionName>,
);
export const repositoryRulesImplementedActions = Object.freeze(
  Object.values(RepositoryRulesImplementedAction),
);

export const ArtifactKindImplementedAction = Object.freeze(
  {
    ArtifactKindsList: "artifactKinds.list",
    ArtifactKindsGet: "artifactKinds.get",
    ArtifactKindVersionsCreate: "artifactKindVersions.create",
    ArtifactKindVersionsList: "artifactKindVersions.list",
  } as const satisfies Record<string, CatalogActionName>,
);
export const artifactKindImplementedActions = Object.freeze(
  Object.values(ArtifactKindImplementedAction),
);

export const IntegrationsImplementedAction = Object.freeze(
  {
    IntegrationAppRegistrationsGet: "integrationAppRegistrations.get",
    IntegrationAppRegistrationsBegin: "integrationAppRegistrations.begin",
    IntegrationAppRegistrationsPut: "integrationAppRegistrations.put",
    IntegrationManifestCallback: "integrationAuth.manifestCallback",
    IntegrationAuthAttemptsCreate: "integrationAuthAttempts.create",
    IntegrationAuthAttemptsGet: "integrationAuthAttempts.get",
    IntegrationSetup: "integrationAuth.setup",
    IntegrationAuthorizationCallback: "integrationAuth.authorizationCallback",
    IntegrationConnectionsGet: "integrationConnections.get",
    IntegrationConnectionsCreate: "integrationConnections.create",
    IntegrationConnectionsList: "integrationConnections.list",
    IntegrationResourcesList: "integrationResources.list",
    IntegrationEffectsList: "integrationEffects.list",
    IntegrationEffectsGet: "integrationEffects.get",
    IntegrationConnectionsUpdate: "integrationConnections.update",
    IntegrationGrantsList: "integrationGrants.list",
    IntegrationGrantsCreate: "integrationGrants.create",
    IntegrationGrantsDelete: "integrationGrants.delete",
    IntegrationConnectionsRemove: "integrationConnections.remove",
    IntegrationResourcesUpdate: "integrationResources.update",
    IntegrationConnectionsCheck: "integrationConnections.check",
    IntegrationConnectionsInvoke: "integrationConnections.invoke",
    IntegrationDiscoveriesCreate: "integrationDiscoveries.create",
    IntegrationInstallationsList: "integrationInstallations.list",
    IntegrationInstallationsGet: "integrationInstallations.get",
    IntakeWebhook: "intake.webhook",
  } as const satisfies Record<string, CatalogActionName>,
);
export const integrationsImplementedActions = Object.freeze(
  Object.values(IntegrationsImplementedAction),
);

export const DeliveryImplementedAction = Object.freeze(
  {
    ChecksList: "checks.list",
    RunReviewsList: "runReviews.list",
    RunReviewsAccept: "runReviews.accept",
    ReviewFindingsList: "reviewFindings.list",
    RunDeliveryDecisionsList: "runDeliveryDecisions.list",
    RunRepairAllowancesCreate: "runRepairAllowances.create",
    RunRepairTriesList: "runRepairTries.list",
    PullRequestsList: "pullRequests.list",
    MergeEntriesList: "mergeEntries.list",
    MergeEntriesCreate: "mergeEntries.create",
    PullRequestsMerge: "pullRequests.merge",
    MergeAttemptsList: "mergeAttempts.list",
    MergeAttemptsReconcile: "mergeAttempts.reconcile",
    DeploymentsList: "deployments.list",
    DeploymentsCreate: "deployments.create",
    DeploymentsRollback: "deployments.rollback",
    MetricsGet: "metrics.get",
    MetricsSources: "metrics.sources",
  } as const satisfies Record<string, CatalogActionName>,
);
export const deliveryImplementedActions = Object.freeze(
  Object.values(DeliveryImplementedAction),
);

/** Evaluation batches: scorers, cases, datasets, batches, results (#44). */
export const EvaluationImplementedAction = Object.freeze(
  {
    EvaluationDefinitionsList: "evaluationDefinitions.list",
    EvaluationDefinitionsCreate: "evaluationDefinitions.create",
    EvaluationCasesList: "evaluationCases.list",
    EvaluationCasesCreate: "evaluationCases.create",
    EvaluationDatasetsCreate: "evaluationDatasets.create",
    EvaluationDatasetsList: "evaluationDatasets.list",
    EvaluationBatchesCreate: "evaluationBatches.create",
    EvaluationBatchesList: "evaluationBatches.list",
    EvaluationBatchesGet: "evaluationBatches.get",
    EvaluationBatchesCancel: "evaluationBatches.cancel",
    EvaluationBatchesRun: "evaluationBatches.run",
    EvaluationBatchesCompare: "evaluationBatches.compare",
    EvaluationBatchResultsList: "evaluationBatchResults.list",
    EvaluationAttemptsList: "evaluationAttempts.list",
  } as const satisfies Record<string, CatalogActionName>,
);
export const evaluationImplementedActions = Object.freeze(
  Object.values(EvaluationImplementedAction),
);

/**
 * Ticket source, cached ticket, readiness, link, request and remote ticket
 * creation operations. The runtime registry and this list stay equal at every
 * commit.
 */
export const TicketImplementedAction = Object.freeze(
  {
    TicketSourcesList: "ticketSources.list",
    TicketSourcesCreate: "ticketSources.create",
    TicketSourcesGet: "ticketSources.get",
    TicketSourcesUpdate: "ticketSources.update",
    TicketSourcesPreview: "ticketSources.preview",
    TicketSourcesLookupPerson: "ticketSources.lookupPerson",
    TicketSourcesLabels: "ticketSources.labels",
    TicketSourcesSync: "ticketSources.sync",
    TicketRoutingRulesGet: "ticketRoutingRules.get",
    TicketRoutingRulesReplace: "ticketRoutingRules.replace",
    ExternalTicketsCreate: "externalTickets.create",
    ExternalTicketsList: "externalTickets.list",
    ExternalTicketsGet: "externalTickets.get",
    TicketReadinessCreate: "ticketReadiness.create",
    TicketTaskLinksCreate: "ticketTaskLinks.create",
    TicketTaskLinksList: "ticketTaskLinks.list",
    TicketTaskLinksResyncNote: "ticketTaskLinks.resyncNote",
    TicketRequestsCreate: "ticketRequests.create",
    TicketRequestsList: "ticketRequests.list",
    TicketRequestsGet: "ticketRequests.get",
    TicketRequestsCancel: "ticketRequests.cancel",
  } as const satisfies Record<string, CatalogActionName>,
);
export const ticketImplementedActions = Object.freeze(
  Object.values(TicketImplementedAction),
);

export const NotificationImplementedAction = Object.freeze(
  {
    NotificationsList: "notifications.list",
    NotificationsCount: "notifications.count",
    NotificationsGet: "notifications.get",
    NotificationsResolveTarget: "notifications.resolveTarget",
    NotificationsSetRead: "notifications.setRead",
    NotificationsMarkAllRead: "notifications.markAllRead",
    NotificationsUndoMarkAllRead: "notifications.undoMarkAllRead",
  } as const satisfies Record<string, CatalogActionName>,
);
export const notificationImplementedActions = Object.freeze(
  Object.values(NotificationImplementedAction),
);

export const RunRequestImplementedAction = Object.freeze(
  {
    RunRequestsCreate: "runRequests.create",
    RunRequestsList: "runRequests.list",
    RunRequestsMine: "runRequests.mine",
    RunRequestsWithdraw: "runRequests.withdraw",
  } as const satisfies Record<string, CatalogActionName>,
);
export const runRequestImplementedActions = Object.freeze(
  Object.values(RunRequestImplementedAction),
);

export const GroupImplementedAction = Object.freeze(
  {
    GroupsList: "groups.list",
    GroupsCreate: "groups.create",
    GroupsUpdate: "groups.update",
    GroupsDelete: "groups.delete",
  } as const satisfies Record<string, CatalogActionName>,
);
export const groupImplementedActions = Object.freeze(
  Object.values(GroupImplementedAction),
);

export const EmailSettingsImplementedAction = Object.freeze(
  {
    EmailSettingsGet: "emailSettings.get",
    EmailSettingsPut: "emailSettings.put",
    EmailSettingsTest: "emailSettings.test",
    EmailSettingsDelete: "emailSettings.delete",
  } as const satisfies Record<string, CatalogActionName>,
);
export const emailSettingsImplementedActions = Object.freeze(
  Object.values(EmailSettingsImplementedAction),
);

export const WorkflowImplementedAction = Object.freeze(
  {
    WorkflowsList: "workflows.list",
    WorkflowsGet: "workflows.get",
    WorkflowsCreate: "workflows.create",
    WorkflowsUpdate: "workflows.update",
    WorkflowsCopy: "workflows.copy",
    WorkflowVersionsList: "workflowVersions.list",
    WorkflowVersionsGet: "workflowVersions.get",
    WorkflowVersionsSkills: "workflowVersions.skills",
    WorkflowVersionsCreate: "workflowVersions.create",
    WorkflowVersionsUpdate: "workflowVersions.update",
    WorkflowVersionsPublish: "workflowVersions.publish",
    WorkflowActivationsCreate: "workflowActivations.create",
    WorkflowsValidate: "workflows.validate",
    WorkflowListingsCreate: "workflowListings.create",
    WorkflowDefinitionProposalsGet: "workflowDefinitionProposals.get",
    WorkflowDefinitionProposalDecisionsCreate:
      "workflowDefinitionProposalDecisions.create",
    DefinitionPublishGrantsCreate: "definitionPublishGrants.create",
    DefinitionPublishGrantsDelete: "definitionPublishGrants.delete",
    AgentPowerGrantsCreate: "agentPowerGrants.create",
    AgentPowerGrantsDelete: "agentPowerGrants.delete",
  } as const satisfies Record<string, CatalogActionName>,
);
export const workflowImplementedActions = Object.freeze(
  Object.values(WorkflowImplementedAction),
);

/**
 * Batches (#58): a bounded run of issues in one repository. A supervisor's record
 * over ordinary ticket requests; it starts nothing the existing admission would not.
 */
export const BatchImplementedAction = Object.freeze(
  {
    BatchesList: "batches.list",
    BatchesStartable: "batches.startable",
    BatchesGet: "batches.get",
    BatchesCreate: "batches.create",
    BatchesPause: "batches.pause",
    BatchesResume: "batches.resume",
    BatchesStop: "batches.stop",
    BatchesStartNext: "batches.startNext",
    BatchesFinish: "batches.finish",
  } as const satisfies Record<string, CatalogActionName>,
);
export const batchImplementedActions = Object.freeze(
  Object.values(BatchImplementedAction),
);

/**
 * MCP server definitions (#434): the shared, organization-scoped record of what a
 * remote server is. Connections, discovery and classification are separate groups
 * as they land; the runtime registry and this list stay equal at every commit.
 */
export const McpServerImplementedAction = Object.freeze(
  {
    McpServersList: "mcpServers.list",
    McpServersGet: "mcpServers.get",
    McpServersCreate: "mcpServers.create",
    McpServersUpdate: "mcpServers.update",
  } as const satisfies Record<string, CatalogActionName>,
);
export const mcpServerImplementedActions = Object.freeze(
  Object.values(McpServerImplementedAction),
);

/**
 * MCP connections (#434): one use of a server definition, organization or personal.
 * Discovery pins what a server offers; the capabilities read shows the pin.
 */
export const McpConnectionImplementedAction = Object.freeze(
  {
    McpConnectionsList: "mcpConnections.list",
    McpConnectionsGet: "mcpConnections.get",
    McpConnectionsCreate: "mcpConnections.create",
    McpConnectionsUpdate: "mcpConnections.update",
    McpConnectionsDiscover: "mcpConnections.discover",
    McpConnectionsCapabilities: "mcpConnections.capabilities",
    McpToolClassificationsList: "mcpToolClassifications.list",
    McpToolClassificationsPut: "mcpToolClassifications.put",
    McpUseGrantsList: "mcpUseGrants.list",
    McpUseGrantsCreate: "mcpUseGrants.create",
    McpUseGrantsRevoke: "mcpUseGrants.revoke",
  } as const satisfies Record<string, CatalogActionName>,
);
export const mcpConnectionImplementedActions = Object.freeze(
  Object.values(McpConnectionImplementedAction),
);

/** Registered workflow action discovery served by the handwritten Hono routes. */
export const WorkflowActionDiscoveryImplementedAction = Object.freeze(
  {
    WorkflowActionsList: "workflowActions.list",
    WorkflowActionsGet: "workflowActions.get",
  } as const satisfies Record<string, CatalogActionName>,
);
export const workflowActionDiscoveryImplementedActions = Object.freeze(
  Object.values(WorkflowActionDiscoveryImplementedAction),
);

export const AutomationImplementedAction = Object.freeze(
  {
    AutomationsList: "automations.list",
    AutomationsGet: "automations.get",
    AutomationsCreate: "automations.create",
    AutomationsUpdate: "automations.update",
    AutomationVersionsList: "automationVersions.list",
    AutomationVersionsCreate: "automationVersions.create",
    AutomationFiringsList: "automationFirings.list",
    AutomationsRun: "automations.run",
  } as const satisfies Record<string, CatalogActionName>,
);
export const automationImplementedActions = Object.freeze(
  Object.values(AutomationImplementedAction),
);

export const ArtifactImplementedAction = Object.freeze(
  {
    ArtifactCommentsCreate: "artifactComments.create",
    ArtifactCommentsUpdate: "artifactComments.update",
    ArtifactCommentsList: "artifactComments.list",
    ArtifactCommentsListAcrossVersions: "artifactComments.listAcrossVersions",
    ArtifactCommentsMentionCandidates: "artifactComments.mentionCandidates",
    ArtifactAccessGrant: "artifactAccess.grant",
    ArtifactAccessList: "artifactAccess.list",
    ArtifactAccessRevoke: "artifactAccess.revoke",
    ArtifactAccessSharers: "artifactAccess.sharers",
    ArtifactsList: "artifacts.list",
    FilesSearch: "files.search",
    FilesFacts: "files.facts",
    FilesLibrary: "files.library",
    ArtifactsGet: "artifacts.get",
    ArtifactsUpdate: "artifacts.update",
    ArtifactStorageGet: "artifactStorage.get",
    ArtifactVersionsList: "artifactVersions.list",
    ArtifactVersionsImport: "artifactVersions.import",
    ArtifactVersionsExtract: "artifactVersions.extract",
    ArtifactVersionsContent: "artifactVersions.content",
    ArtifactVersionsProbe: "artifactVersions.probe",
    ArtifactPreviewsCreate: "artifactPreviews.create",
    ArtifactPreviewsRevoke: "artifactPreviews.revoke",
    ArtifactPreviewsAvailability: "artifactPreviews.availability",
  } as const satisfies Record<string, CatalogActionName>,
);

export const ContextPackImplementedAction = Object.freeze(
  {
    ContextPacksBuild: "contextPacks.build",
  } as const satisfies Record<string, CatalogActionName>,
);

export const DraftImplementedAction = Object.freeze(
  {
    Open: "drafts.open",
    Get: "drafts.get",
    CheckpointGet: "draftCheckpoints.get",
    Slice: "draftSlices.get",
    Edit: "drafts.edit",
    Rollover: "drafts.rollover",
    PublicationCreate: "draftPublications.create",
    PublicationGet: "draftPublications.get",
    SuggestionCreate: "draftSuggestions.create",
    SuggestionList: "draftSuggestions.list",
    SuggestionAccept: "draftSuggestions.accept",
    SuggestionReject: "draftSuggestions.reject",
    CommentCreate: "draftComments.create",
    CommentList: "draftComments.list",
    CommentUpdate: "draftComments.update",
    ReferenceCreate: "draftReferences.create",
    ReferenceGet: "draftReferences.get",
  } as const satisfies Record<string, CatalogActionName>,
);

export const SecretsImplementedAction = Object.freeze(
  {
    List: "secrets.list",
    Get: "secrets.get",
    Create: "secrets.create",
    Rotate: "secrets.rotate",
    UpdatePolicy: "secrets.updatePolicy",
    Revoke: "secrets.revoke",
  } as const satisfies Record<string, CatalogActionName>,
);
export const secretsImplementedActions = Object.freeze(
  Object.values(SecretsImplementedAction),
);

/**
 * The provider-neutral OAuth client credentials (#410).
 *
 * One installation-level get and put for every provider whose manifest asks for
 * `client-credentials`, so adding a provider adds no operation. The put is a
 * session-only command that is idempotent and version-guarded once credentials
 * exist, and the secret it takes is never returned.
 */
export const IntegrationClientCredentialsImplementedAction = Object.freeze(
  {
    IntegrationClientCredentialsGet: "integrationClientCredentials.get",
    IntegrationClientCredentialsPut: "integrationClientCredentials.put",
  } as const satisfies Record<string, CatalogActionName>,
);
export const integrationClientCredentialsImplementedActions = Object.freeze(
  Object.values(IntegrationClientCredentialsImplementedAction),
);

export const SkillStorageImplementedAction = Object.freeze(
  {
    SkillStorageSettingsGet: "skillStorageSettings.get",
    SkillStorageSettingsPut: "skillStorageSettings.put",
    SkillStorageSettingsVerify: "skillStorageSettings.verify",
  } as const satisfies Record<string, CatalogActionName>,
);
export const skillStorageImplementedActions = Object.freeze(
  Object.values(SkillStorageImplementedAction),
);

export const BackupImplementedAction = Object.freeze(
  {
    BackupsList: "backups.list",
    BackupsStatus: "backups.status",
    BackupsStart: "backups.start",
    BackupsDrillsList: "backups.drills.list",
    InstallationRestoreGet: "installationRestore.get",
    InstallationRestoreStep: "installationRestore.step",
    InstallationUncertainActionsGet: "installationUncertainActions.get",
    InstallationUpdatesStatus: "installationUpdates.status",
    InstallationUpdatesList: "installationUpdates.list",
    InstallationUpdatesDismiss: "installationUpdates.dismiss",
    BackupRunnerCredentialIssue: "backupRunnerCredential.issue",
    BackupScheduleGet: "backupSchedule.get",
    BackupSchedulePut: "backupSchedule.put",
    BackupPointInTimeGet: "backupPointInTime.get",
    BackupPointInTimePut: "backupPointInTime.put",
    BackupOffsiteGet: "backupOffsite.get",
    BackupOffsitePut: "backupOffsite.put",
    BackupOffsiteVerify: "backupOffsite.verify",
    BackupRunnerSettings: "backupRunner.settings",
    BackupRunnerClaim: "backupRunner.claim",
    BackupRunnerReport: "backupRunner.report",
    BackupRunnerMaintain: "backupRunner.maintain",
    BackupRunnerCutoff: "backupRunner.cutoff",
    BackupRunnerDrill: "backupRunner.drill",
  } as const satisfies Record<string, CatalogActionName>,
);
export const backupImplementedActions = Object.freeze(
  Object.values(BackupImplementedAction),
);
export const TelemetryDestinationImplementedAction = Object.freeze(
  {
    TelemetryDestinationsList: "telemetryDestinations.list",
    TelemetryDestinationsGet: "telemetryDestinations.get",
    TelemetryDestinationsDropped: "telemetryDestinations.dropped",
    TelemetryDestinationsCreate: "telemetryDestinations.create",
    TelemetryDestinationsUpdate: "telemetryDestinations.update",
    TelemetryDestinationsDelete: "telemetryDestinations.delete",
    TelemetryDestinationsTest: "telemetryDestinations.test",
  } as const satisfies Record<string, CatalogActionName>,
);
export const telemetryDestinationImplementedActions = Object.freeze(
  Object.values(TelemetryDestinationImplementedAction),
);

export const AlertChannelImplementedAction = Object.freeze(
  {
    AlertChannelsList: "alertChannels.list",
    AlertChannelsCreate: "alertChannels.create",
    AlertChannelsUpdate: "alertChannels.update",
    AlertChannelsDelete: "alertChannels.delete",
    AlertChannelsTest: "alertChannels.test",
    AlertChannelsRotateSecret: "alertChannels.rotateSecret",
  } as const satisfies Record<string, CatalogActionName>,
);
export const alertChannelImplementedActions = Object.freeze(
  Object.values(AlertChannelImplementedAction),
);

export const AlertRuleImplementedAction = Object.freeze(
  {
    AlertRulesList: "alertRules.list",
    AlertRulesUpdate: "alertRules.update",
    AlertsList: "alerts.list",
    AlertsSendTest: "alerts.sendTest",
  } as const satisfies Record<string, CatalogActionName>,
);
export const alertRuleImplementedActions = Object.freeze(
  Object.values(AlertRuleImplementedAction),
);

export const BlobUploadImplementedAction = Object.freeze(
  {
    BlobUploadStart: "blobUploads.start",
    BlobUploadPart: "blobUploads.part",
    BlobUploadComplete: "blobUploads.complete",
  } as const satisfies Record<string, CatalogActionName>,
);
export const blobUploadImplementedActions = Object.freeze(
  Object.values(BlobUploadImplementedAction),
);

export const StorageImplementedAction = Object.freeze(
  {
    StorageFilesPut: "storageFiles.put",
    StorageConnectionsMount: "storageConnections.mount",
    StorageConnectionPathsList: "storageConnectionPaths.list",
    StorageConnectionPathsStat: "storageConnectionPaths.stat",
    StorageConnectionPathsRead: "storageConnectionPaths.read",
    StorageConnectionSyncsCreate: "storageConnectionSyncs.create",
    StorageConnectionSyncsList: "storageConnectionSyncs.list",
    StorageConnectionSyncsPause: "storageConnectionSyncs.pause",
    StorageConnectionExportsCreate: "storageConnectionExports.create",
    StorageFoldersCreate: "storageFolders.create",
    StorageEntriesCopy: "storageEntries.copy",
    StorageEntriesMove: "storageEntries.move",
    StorageEntriesTrash: "storageEntries.trash",
    StorageEntriesRestore: "storageEntries.restore",
    StorageEntriesPurge: "storageEntries.purge",
    StorageTrashList: "storageTrash.list",
    StorageSettingsGet: "storageSettings.get",
    StorageSettingsPut: "storageSettings.put",
    AgentFileGrantsCreate: "agentFileGrants.create",
    AgentFileGrantsRevoke: "agentFileGrants.revoke",
    StorageRootsList: "storageRoots.list",
    StorageFolderEntriesList: "storageFolderEntries.list",
    StorageFileVersionsList: "storageFileVersions.list",
    StorageFileUsesList: "storageFileUses.list",
    StorageFilesContent: "storageFiles.content",
    StorageFilesProbe: "storageFiles.probe",
    StorageFilesByVersion: "storageFiles.byVersion",
    StorageFilesPin: "storageFiles.pin",
  } as const satisfies Record<string, CatalogActionName>,
);
export const storageImplementedActions = Object.freeze(
  Object.values(StorageImplementedAction),
);

export const CatalogImplementedAction = Object.freeze(
  {
    SkillSourcesList: "skillSources.list",
    SkillSourcesGet: "skillSources.get",
    SkillSourcesCreate: "skillSources.create",
    SkillSourcesUpdate: "skillSources.update",
    SkillsImport: "skills.import",
    SkillsList: "skills.list",
    SkillsGet: "skills.get",
    SkillsCreate: "skills.create",
    SkillsCopy: "skills.copy",
    SkillsUpdate: "skills.update",
    SkillsUsedBy: "skills.usedBy",
    SkillDraftsOpen: "skillDrafts.open",
    SkillDraftsGet: "skillDrafts.get",
    SkillDraftsUpdate: "skillDrafts.update",
    SkillDraftsDiscard: "skillDrafts.discard",
    SkillDraftsCheck: "skillDrafts.check",
    SkillsSourceUpdate: "skills.sourceUpdate",
    SkillDraftsPublish: "skillDrafts.publish",
    SkillDraftFilesSave: "skillDraftFiles.save",
    SkillDraftFilesGet: "skillDraftFiles.get",
    SkillDraftFilesDelete: "skillDraftFiles.delete",
    SkillVersionsCreate: "skillVersions.create",
    SkillUseGrantsList: "skills.useGrants.list",
    SkillUseGrantsDelete: "skills.useGrants.delete",
    SkillsSetActiveVersion: "skills.setActiveVersion",
    SkillImportsGet: "skillImports.get",
    SkillsTakeSourceUpdate: "skills.takeSourceUpdate",
    SkillDraftFilesRename: "skillDraftFiles.rename",
    SkillVersionsList: "skillVersions.list",
    SkillVersionsGet: "skillVersions.get",
    SkillFilesGet: "skillFiles.get",
    LibrarySearch: "library.search",
  } as const satisfies Record<string, CatalogActionName>,
);
export const catalogImplementedActions = Object.freeze(
  Object.values(CatalogImplementedAction),
);
export const catalogIdentityImplementedActions = Object.freeze(
  Object.values(CatalogImplementedAction).filter((action) =>
    action !== CatalogImplementedAction.SkillVersionsCreate &&
    action !== CatalogImplementedAction.SkillVersionsList &&
    action !== CatalogImplementedAction.SkillsCopy &&
    action !== CatalogImplementedAction.SkillDraftsPublish &&
    action !== CatalogImplementedAction.SkillsSourceUpdate &&
    action !== CatalogImplementedAction.SkillsTakeSourceUpdate
  ),
);

export const PluginPackageImplementedAction = Object.freeze(
  {
    PluginPackagesList: "pluginPackages.list",
    PluginPackagesCreate: "pluginPackages.create",
    PluginPackagesGet: "pluginPackages.get",
    PluginVersionsList: "pluginVersions.list",
    PluginVersionsCreate: "pluginVersions.create",
  } as const satisfies Record<string, CatalogActionName>,
);
export const pluginPackageImplementedActions = Object.freeze(
  Object.values(PluginPackageImplementedAction),
);

export const PluginInstallImplementedAction = Object.freeze(
  {
    PluginInstallsList: "pluginInstalls.list",
    PluginInstallsCreate: "pluginInstalls.create",
    PluginInstallsGet: "pluginInstalls.get",
    PluginInstallsUpdate: "pluginInstalls.update",
    PluginStateGet: "pluginState.get",
    PluginStateItemsList: "pluginStateItems.list",
    PluginStatePut: "pluginState.put",
    PluginPagesList: "pluginPages.list",
    PluginPagesGet: "pluginPages.get",
    PluginPageDocumentsGet: "pluginPageDocuments.get",
  } as const satisfies Record<string, CatalogActionName>,
);
export const pluginInstallImplementedActions = Object.freeze(
  Object.values(PluginInstallImplementedAction),
);

export const PluginAuthoringImplementedAction = Object.freeze(
  {
    PluginAuthoringRunsCreate: "pluginAuthoringRuns.create",
    PluginAuthoringRunsGet: "pluginAuthoringRuns.get",
  } as const satisfies Record<string, CatalogActionName>,
);
export const pluginAuthoringImplementedActions = Object.freeze(
  Object.values(PluginAuthoringImplementedAction),
);

export const PreviewImplementedAction = Object.freeze(
  {
    PreviewsList: "previews.list",
    PreviewsAccess: "previews.access",
    PreviewsStop: "previews.stop",
    PreviewsRevokeAccess: "previews.revokeAccess",
    PreviewsAvailability: "previews.availability",
  } as const satisfies Record<string, CatalogActionName>,
);
export const previewImplementedActions = Object.freeze(
  Object.values(PreviewImplementedAction),
);

export const MemoryImplementedAction = Object.freeze(
  {
    MemoriesList: "memories.list",
    MemoriesGet: "memories.get",
    MemoriesCreate: "memories.create",
    MemoriesUpdate: "memories.update",
    MemoryRevisionsCreate: "memoryRevisions.create",
    MemoryRevisionsList: "memoryRevisions.list",
  } as const satisfies Record<string, CatalogActionName>,
);
export const memoryImplementedActions = Object.freeze(
  Object.values(MemoryImplementedAction),
);

export const authImplementedActions = Object.freeze(
  Object.values(AuthImplementedAction),
);
export const taskImplementedActions = Object.freeze(
  Object.values(TaskImplementedAction),
);
export const projectsImplementedActions = Object.freeze(
  Object.values(ProjectsImplementedAction),
);
export const artifactImplementedActions = Object.freeze(
  Object.values(ArtifactImplementedAction),
);
export const contextPackImplementedActions = Object.freeze(
  Object.values(ContextPackImplementedAction),
);
export const draftImplementedActions = Object.freeze(
  Object.values(DraftImplementedAction),
);
export const implementedActions = Object.freeze(
  [
    ...authImplementedActions,
    ...taskImplementedActions,
    ...coordinationImplementedActions,
    ...executionImplementedActions,
    ...machineImplementedActions,
    ...conversationImplementedActions,
    ...approvalImplementedActions,
    ...outputImplementedActions,
    ...attemptReadImplementedActions,
    ...projectsImplementedActions,
    ...agentImplementedActions,
    ...providerReadsImplementedActions,
    ...providerWritesImplementedActions,
    ...routeContinuationsImplementedActions,
    ...repositoryRulesImplementedActions,
    ...artifactKindImplementedActions,
    ...integrationsImplementedActions,
    ...deliveryImplementedActions,
    ...evaluationImplementedActions,
    ...ticketImplementedActions,
    ...notificationImplementedActions,
    ...groupImplementedActions,
    ...emailSettingsImplementedActions,
    ...runRequestImplementedActions,
    ...workflowImplementedActions,
    ...workflowActionDiscoveryImplementedActions,
    ...automationImplementedActions,
    ...artifactImplementedActions,
    ...contextPackImplementedActions,
    ...draftImplementedActions,
    ...secretsImplementedActions,
    ...catalogImplementedActions,
    ...pluginPackageImplementedActions,
    ...pluginInstallImplementedActions,
    ...pluginAuthoringImplementedActions,
    ...skillStorageImplementedActions,
    ...backupImplementedActions,
    ...telemetryDestinationImplementedActions,
    ...alertChannelImplementedActions,
    ...alertRuleImplementedActions,
    ...integrationClientCredentialsImplementedActions,
    ...mcpServerImplementedActions,
    ...mcpConnectionImplementedActions,
    ...batchImplementedActions,
    ...blobUploadImplementedActions,
    ...storageImplementedActions,
    ...memoryImplementedActions,
    ...previewImplementedActions,
  ] as const,
);

export type ImplementedActionName = (typeof implementedActions)[number];

export class ImplementedActionRegistryError extends Error {
  override readonly name = "ImplementedActionRegistryError";
}

/** Proves a runtime registry implements its complete assigned action subset. */
export function assertImplementedActionRegistry(
  registry: { list(): readonly { name: string }[] },
  expected: readonly ImplementedActionName[],
): void {
  const actual = registry.list().map(({ name }) => name).sort();
  const assigned = [...expected].sort();
  if (
    actual.length !== assigned.length ||
    actual.some((name, index) => name !== assigned[index])
  ) {
    throw new ImplementedActionRegistryError(
      `implemented action registry mismatch: expected ${
        assigned.join(", ")
      }; received ${actual.join(", ")}`,
    );
  }
}

/** Workflow actions the server runtime executes; separate from catalog names. */
export const WorkflowRuntimeImplementedAction = Object.freeze(
  {
    Noop: "workflow.noop",
    Stop: "workflow.stop",
    HumanApproval: "human.approval",
    Research: "rpi.research",
    Plan: "rpi.plan",
    Design: "rpi.design",
    Implement: "harness.implement",
    Repair: "harness.repair",
    Check: "quality.check",
    Review: "review.independent",
    Freeform: "agent.freeform",
    TaskBrief: "task.brief",
    EvaluationCheck: "evaluation.check",
    EvaluationScore: "evaluation.score",
    SecretIdentityRead: "secret.identity.read",
    // Settled by the engine itself, like a projection but over time: the step
    // calls the deployment target and completes when the deployment is terminal.
    DeliveryPrepare: "delivery.prepare",
    DeliveryDeploy: "delivery.deploy",
    DeliveryHealth: "delivery.health",
  } as const satisfies Record<string, WorkflowActionName>,
);

export const workflowRuntimeImplementedActions = Object.freeze(
  Object.values(WorkflowRuntimeImplementedAction),
);

/**
 * Actions the engine settles in its own admission, over time, through a runner a
 * pack registers: no worker job. A projection finishes in one pass; these may
 * answer "not yet" and are looked at again.
 */
export const ENGINE_SETTLED_STEP_ACTIONS = Object.freeze(
  [
    WorkflowRuntimeImplementedAction.DeliveryPrepare,
    WorkflowRuntimeImplementedAction.DeliveryDeploy,
    WorkflowRuntimeImplementedAction.DeliveryHealth,
  ] as const,
);

export function isEngineSettledStepAction(action: string): boolean {
  return (ENGINE_SETTLED_STEP_ACTIONS as readonly string[]).includes(action);
}

/** Proves a workflow action registry holds exactly its assigned subset. */
export function assertImplementedWorkflowActionRegistry(
  registry: { list(): readonly { action: string }[] },
  expected: readonly WorkflowActionName[],
): void {
  const actual = registry.list().map(({ action }) => action).sort();
  const assigned = [...expected].sort();
  if (
    actual.length !== assigned.length ||
    actual.some((name, index) => name !== assigned[index])
  ) {
    throw new ImplementedActionRegistryError(
      `implemented workflow action registry mismatch: expected ${
        assigned.join(", ")
      }; received ${actual.join(", ")}`,
    );
  }
}

/** Proves every registered handler schema name resolves to a contract schema. */
export function assertWorkflowActionSchemasResolve(
  registry: {
    list(): readonly {
      action: string;
      handler: { inputSchema: string; outputSchema: string };
    }[];
  },
  schemas: Readonly<Record<string, unknown>>,
): void {
  for (const { action, handler } of registry.list()) {
    for (const name of [handler.inputSchema, handler.outputSchema]) {
      const schema = Object.hasOwn(schemas, name)
        ? schemas[name] as
          | { parse?: unknown; description?: unknown }
          | undefined
        : undefined;
      if (
        !schema || typeof schema.parse !== "function" ||
        typeof schema.description !== "string" ||
        schema.description.trim() === ""
      ) {
        throw new ImplementedActionRegistryError(
          `workflow action ${action} schema does not resolve: ${name}`,
        );
      }
    }
  }
}

/** Proves every dispatchable registry action has a runtime registration. */
export function assertDispatchableWorkflowActionsRegistered(
  registry: { list(): readonly { action: string }[] },
  isDispatchable: (action: WorkflowActionName) => boolean,
): void {
  const registered = new Set(registry.list().map(({ action }) => action));
  const missing = WORKFLOW_ACTION_NAMES.filter((action) =>
    isDispatchable(action) && !registered.has(action)
  );
  if (missing.length > 0) {
    throw new ImplementedActionRegistryError(
      `dispatchable workflow actions missing from runtime: ${
        missing.join(", ")
      }`,
    );
  }
}
