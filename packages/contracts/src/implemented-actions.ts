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
    SessionsSteer: "sessions.steer",
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
    WorkersRevoke: "workers.revoke",
    ModelProviderAccountsList: "modelProviderAccounts.list",
    WorkerProviderBindingsList: "workerProviderBindings.list",
    WorkerProviderBindingsCreate: "workerProviderBindings.create",
    WorkerProviderBindingsUpdate: "workerProviderBindings.update",
    WorkerProviderAuthCreate: "workerProviderAuth.create",
    WorkerProviderAuthGet: "workerProviderAuth.get",
    WorkerProviderAuthCancel: "workerProviderAuth.cancel",
    WorkerReportProviderAuth: "worker.reportProviderAuth",
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

export const IntegrationsImplementedAction = Object.freeze(
  {
    IntegrationAppRegistrationsGet: "integrationAppRegistrations.get",
    IntegrationAppRegistrationsBegin: "integrationAppRegistrations.begin",
    IntegrationAppRegistrationsPut: "integrationAppRegistrations.put",
    GitHubManifestCallback: "integrationAuth.githubManifestCallback",
    IntegrationAuthAttemptsCreate: "integrationAuthAttempts.create",
    IntegrationAuthAttemptsGet: "integrationAuthAttempts.get",
    GitHubSetup: "integrationAuth.githubSetup",
    GitHubCallback: "integrationAuth.githubCallback",
    IntegrationConnectionsGet: "integrationConnections.get",
    IntegrationConnectionsCreate: "integrationConnections.create",
    IntegrationConnectionsList: "integrationConnections.list",
    IntegrationResourcesList: "integrationResources.list",
    IntegrationEffectsList: "integrationEffects.list",
    IntegrationEffectsGet: "integrationEffects.get",
    IntegrationConnectionsUpdate: "integrationConnections.update",
    IntegrationResourcesUpdate: "integrationResources.update",
    IntegrationConnectionsCheck: "integrationConnections.check",
    IntegrationDiscoveriesCreate: "integrationDiscoveries.create",
    IntegrationInstallationsList: "integrationInstallations.list",
    IntegrationInstallationsGet: "integrationInstallations.get",
    IntakeGithub: "intake.github",
  } as const satisfies Record<string, CatalogActionName>,
);
export const integrationsImplementedActions = Object.freeze(
  Object.values(IntegrationsImplementedAction),
);

export const DeliveryImplementedAction = Object.freeze(
  {
    ChecksList: "checks.list",
    RunReviewsList: "runReviews.list",
    ReviewFindingsList: "reviewFindings.list",
    RunDeliveryDecisionsList: "runDeliveryDecisions.list",
  } as const satisfies Record<string, CatalogActionName>,
);
export const deliveryImplementedActions = Object.freeze(
  Object.values(DeliveryImplementedAction),
);

/**
 * Ticket source, cached ticket, readiness, link and request operations.
 * Remote ticket creation (`externalTickets.create`) is not part of this
 * group; the runtime registry and this list stay equal at every commit.
 */
export const TicketImplementedAction = Object.freeze(
  {
    TicketSourcesList: "ticketSources.list",
    TicketSourcesCreate: "ticketSources.create",
    TicketSourcesGet: "ticketSources.get",
    TicketSourcesUpdate: "ticketSources.update",
    TicketSourcesPreview: "ticketSources.preview",
    TicketSourcesSync: "ticketSources.sync",
    ExternalTicketsList: "externalTickets.list",
    ExternalTicketsGet: "externalTickets.get",
    TicketReadinessCreate: "ticketReadiness.create",
    TicketTaskLinksCreate: "ticketTaskLinks.create",
    TicketRequestsCreate: "ticketRequests.create",
  } as const satisfies Record<string, CatalogActionName>,
);
export const ticketImplementedActions = Object.freeze(
  Object.values(TicketImplementedAction),
);

export const WorkflowImplementedAction = Object.freeze(
  {
    WorkflowsList: "workflows.list",
    WorkflowsGet: "workflows.get",
    WorkflowsCreate: "workflows.create",
    WorkflowsUpdate: "workflows.update",
    WorkflowVersionsList: "workflowVersions.list",
    WorkflowVersionsGet: "workflowVersions.get",
    WorkflowVersionsCreate: "workflowVersions.create",
    WorkflowVersionsUpdate: "workflowVersions.update",
    WorkflowVersionsPublish: "workflowVersions.publish",
    WorkflowActivationsCreate: "workflowActivations.create",
    WorkflowsValidate: "workflows.validate",
  } as const satisfies Record<string, CatalogActionName>,
);
export const workflowImplementedActions = Object.freeze(
  Object.values(WorkflowImplementedAction),
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

export const ArtifactImplementedAction = Object.freeze(
  {
    ArtifactCommentsCreate: "artifactComments.create",
    ArtifactCommentsUpdate: "artifactComments.update",
    ArtifactCommentsList: "artifactComments.list",
    ArtifactCommentsListAcrossVersions: "artifactComments.listAcrossVersions",
    ArtifactsList: "artifacts.list",
    ArtifactsGet: "artifacts.get",
    ArtifactsUpdate: "artifacts.update",
    ArtifactStorageGet: "artifactStorage.get",
    ArtifactVersionsList: "artifactVersions.list",
    ArtifactVersionsImport: "artifactVersions.import",
    ArtifactVersionsExtract: "artifactVersions.extract",
    ArtifactVersionsContent: "artifactVersions.content",
    ArtifactPreviewsCreate: "artifactPreviews.create",
    ArtifactPreviewsRevoke: "artifactPreviews.revoke",
    ArtifactPreviewsAvailability: "artifactPreviews.availability",
  } as const satisfies Record<string, CatalogActionName>,
);

export const DraftImplementedAction = Object.freeze(
  {
    Open: "drafts.open",
    Get: "drafts.get",
    CheckpointGet: "draftCheckpoints.get",
    Slice: "draftSlices.get",
    Edit: "drafts.edit",
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
    SkillsUpdate: "skills.update",
    SkillVersionsCreate: "skillVersions.create",
  } as const satisfies Record<string, CatalogActionName>,
);
export const catalogImplementedActions = Object.freeze(
  Object.values(CatalogImplementedAction),
);
export const catalogIdentityImplementedActions = Object.freeze(
  Object.values(CatalogImplementedAction).filter((action) =>
    action !== CatalogImplementedAction.SkillVersionsCreate
  ),
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
    ...repositoryRulesImplementedActions,
    ...integrationsImplementedActions,
    ...deliveryImplementedActions,
    ...ticketImplementedActions,
    ...workflowImplementedActions,
    ...workflowActionDiscoveryImplementedActions,
    ...artifactImplementedActions,
    ...draftImplementedActions,
    ...secretsImplementedActions,
    ...catalogImplementedActions,
    ...skillStorageImplementedActions,
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
    Plan: "rpi.plan",
    Design: "rpi.design",
    Implement: "harness.implement",
    Repair: "harness.repair",
    Check: "quality.check",
    Review: "review.independent",
    Freeform: "agent.freeform",
    TaskBrief: "task.brief",
  } as const satisfies Record<string, WorkflowActionName>,
);

export const workflowRuntimeImplementedActions = Object.freeze(
  Object.values(WorkflowRuntimeImplementedAction),
);

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
