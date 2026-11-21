import {
  type ApiProblem,
  ApiProblemError,
  ApiTransportError,
  type BakeryClient,
  type ClientInputMap,
  type ClientOutputMap,
  createBakeryClient,
} from "@bakery/contracts/client";
import type { HealthResponse } from "@bakery/contracts";
import {
  type AccessAdminClient,
  createAccessAdminClient,
} from "./access-client.ts";
import {
  RepositoryProfileObservationPayloadSchema,
} from "@bakery/contracts/repository-inspection";
import {
  type AuthProviderClient,
  createAuthProviderClient,
} from "@bakery/contracts/auth-provider-client";

const MAX_PROBLEM_FIELD_LENGTH = 2_048;

export type SafeProblem = Readonly<{
  type: string;
  title: string;
  status: number;
  code: string;
  retryable: boolean;
  detail: string;
  requestId: string;
  traceId: string;
  resetRequired?: boolean;
  retainedFrom?: string;
  retryWithoutAfter?: boolean;
  /**
   * A STATE_CONFLICT or PRECONDITION_FAILED rule slug such as `app_mismatch` or
   * `source_policy_changed`; never free text.
   */
  reason?: string;
  /** Stable issue codes of a 422, such as a storage probe outcome. */
  issueCodes?: readonly string[];
  /** A 422's field paths (JSON Pointers) and plain messages. */
  issues?: readonly { readonly path: string; readonly message: string }[];
}>;

export type ApiFailure =
  | { readonly kind: "problem"; readonly problem: SafeProblem }
  | { readonly kind: "network" }
  | { readonly kind: "invalid-response"; readonly status: number };

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiFailure };

export type NotificationListResponse = ClientOutputMap["Page<Notification>"];
export type NotificationResponse = ClientOutputMap["Notification"];
export type NotificationCountResponse = ClientOutputMap["NotificationCount"];
export type NotificationTargetResponse = ClientOutputMap["NotificationTarget"];
export type NotificationMarkAllReadResponse =
  ClientOutputMap["NotificationMarkAllReadResult"];
export type NotificationCursorQuery = ClientInputMap["NotificationCursorQuery"];

export type TaskListResponse = ClientOutputMap["Page<Task>"];
export type TaskCursorQuery = ClientInputMap["TaskCursorQuery"];
export type TaskCreate = ClientInputMap["TaskCreate"];
export type TaskUpdate = ClientInputMap["TaskUpdate"];
export type RunControl = ClientInputMap["RunControl"];
export type RunCreate = ClientInputMap["RunCreate"];
export type WorkflowPresetListResponse =
  ClientOutputMap["Page<WorkflowPreset>"];
export type WorkflowPresetResponse =
  WorkflowPresetListResponse["items"][number];
export type WorkflowPresetsListQuery =
  ClientInputMap["WorkflowPresetsListQuery"];
export type NamedDefinitionCreate = ClientInputMap["NamedDefinitionCreate"];
export type WorkflowVersionCreate = ClientInputMap["WorkflowVersionCreate"];
export type WorkflowValidationInput = ClientInputMap["WorkflowValidation"];
export type WorkflowDraftUpdate = ClientInputMap["WorkflowDraftUpdate"];
export type ValidationReportResponse = ClientOutputMap["ValidationReport"];
export type TaskResponse = ClientOutputMap["Task"];
export type RunListResponse = ClientOutputMap["Page<Run>"];
export type RunResponse = ClientOutputMap["Run"];
export type RunControlCapabilities = ClientOutputMap["RunControlCapabilities"];
export type RouteContinuationOffersResponse =
  ClientOutputMap["RouteContinuationOffers"];
export type RouteContinuationAdmit = ClientInputMap["RouteContinuationAdmit"];
export type RouteContinuationResponse = ClientOutputMap["RouteContinuation"];
export type RunStepListResponse = ClientOutputMap["Page<RunStep>"];
export type AgentSessionPageResponse = ClientOutputMap["AgentSessionPage"];
export type SessionFeedResponse = ClientOutputMap["SessionFeed"];
export type CheckRunListResponse = ClientOutputMap["Page<CheckRun>"];
export type ReviewCycleListResponse = ClientOutputMap["Page<ReviewCycle>"];
export type ReviewFindingListResponse = ClientOutputMap["Page<ReviewFinding>"];
export type DeliveryDecisionListResponse =
  ClientOutputMap["Page<DeliveryDecision>"];
export type PullRequestListResponse = ClientOutputMap["Page<PullRequest>"];
export type MergeAttemptListResponse = ClientOutputMap["Page<MergeAttempt>"];
export type MergeAttemptResponse = ClientOutputMap["MergeAttempt"];
export type MergeEntryListResponse = ClientOutputMap["Page<MergeEntry>"];
export type MergeEntryResponse = ClientOutputMap["MergeEntry"];
export type MergeEntryCreate = ClientInputMap["MergeEntryCreate"];
export type MergeReconciliationResponse =
  ClientOutputMap["MergeReconciliation"];
export type SyncQuery = ClientInputMap["SyncQuery"];
export type SyncResponse = ClientOutputMap["SyncSnapshot"];
export type PrincipalIdentity = ClientOutputMap["PrincipalIdentity"];
export type InstallationStatus = ClientOutputMap["InstallationStatus"];
export type UserProfile = ClientOutputMap["UserProfile"];
export type UserProfileUpdate = ClientInputMap["UserProfileUpdate"];
export type UserPreferences = ClientOutputMap["UserPreferences"];
export type UserPreferencesUpdate = ClientInputMap["UserPreferencesUpdate"];
export type InstallationCapabilities =
  ClientOutputMap["InstallationCapabilities"];
export type InstallationSettings = ClientOutputMap["InstallationSettings"];
/** What the installation-wide usage summary answers: figures and budgets. */
export type UsageSummary = ClientOutputMap["UsageSummary"];
/** Window and filters for that summary; all three are optional on the server. */
export type UsageQuery = ClientInputMap["UsageQuery"];
/** One delivery metric over a window: points, provenance and what is missing. */
export type MetricSeries = ClientOutputMap["MetricSeries"];
/** The metric, window and repository a series is asked for. */
export type MetricsQuery = ClientInputMap["MetricsQuery"];
/** The same question, listing the records behind the numbers, one page at a time. */
export type MetricSourcesQuery = ClientInputMap["MetricSourcesQuery"];
/** One page of the pull requests or tasks counted in a metric. */
export type MetricSourcePage = ClientOutputMap["Page<MetricSource>"];
/** One pull request or task counted in a metric. */
export type MetricSource = MetricSourcePage["items"][number];
export type IntegrationAppRegistration =
  ClientOutputMap["IntegrationAppRegistration"];
export type IntegrationAppManifestStart =
  ClientOutputMap["IntegrationAppManifestStart"];
export type IntegrationAppRegistrationBegin =
  ClientInputMap["IntegrationAppRegistrationBegin"];
export type IntegrationAppRegistrationPut =
  ClientInputMap["IntegrationAppRegistrationPut"];
export type IntegrationClientCredentials =
  ClientOutputMap["IntegrationClientCredentials"];
export type IntegrationClientCredentialsPut =
  ClientInputMap["IntegrationClientCredentialsPut"];
export type IntegrationSlackApp = ClientOutputMap["IntegrationSlackApp"];
export type IntegrationSlackAppPut = ClientInputMap["IntegrationSlackAppPut"];
export type IntegrationSlackAppCheck =
  ClientOutputMap["IntegrationSlackAppCheck"];
export type TelemetryDestinationList =
  ClientOutputMap["TelemetryDestinationList"];
export type TelemetryDestination = ClientOutputMap["TelemetryDestination"];
export type TelemetryDestinationListQuery =
  ClientInputMap["TelemetryDestinationListQuery"];
export type TelemetryDestinationDetail =
  ClientOutputMap["TelemetryDestinationDetail"];
export type TelemetryDestinationCreate =
  ClientInputMap["TelemetryDestinationCreate"];
export type TelemetryDestinationUpdate =
  ClientInputMap["TelemetryDestinationUpdate"];
export type TelemetryDestinationTest =
  ClientInputMap["TelemetryDestinationTest"];
export type TelemetryDestinationTestResult =
  ClientOutputMap["TelemetryDestinationTestResult"];
export type StorageSettings = ClientOutputMap["StorageSettings"];
export type StorageSettingsPut = ClientInputMap["StorageSettingsPut"];
export type SkillStorageSettings = ClientOutputMap["SkillStorageSettings"];
export type SkillStorageSettingsPut = ClientInputMap["SkillStorageSettingsPut"];
export type SkillStorageVerification =
  ClientOutputMap["SkillStorageVerification"];
export type IntegrationConnection = ClientOutputMap["IntegrationConnection"];
export type IntegrationConnectionPage =
  ClientOutputMap["Page<IntegrationConnection>"];
export type IntegrationResource = ClientOutputMap["IntegrationResource"];
export type IntegrationResourcePage =
  ClientOutputMap["Page<IntegrationResource>"];
export type IntegrationResourceQuery =
  ClientInputMap["IntegrationResourceQuery"];
export type IntegrationConnectionUpdate =
  ClientInputMap["IntegrationConnectionUpdate"];
export type IntegrationResourceUpdate =
  ClientInputMap["IntegrationResourceUpdate"];
export type ConnectionCheck = ClientOutputMap["ConnectionCheck"];
export type IntegrationAuthAttemptCreated =
  ClientOutputMap["IntegrationAuthAttemptCreated"];
export type AuditEventPage = ClientOutputMap["Page<AuditEvent>"];
export type AuditEventItem = AuditEventPage["items"][number];
export type AuditEventsQuery = ClientInputMap["AuditQuery"];
export type OrganizationRoleItem = ClientOutputMap["OrganizationRole"];
export type OrganizationRolePage = ClientOutputMap["Page<OrganizationRole>"];
export type OrganizationRoleCreate = ClientInputMap["OrganizationRoleCreate"];
export type OrganizationRoleUpdate = ClientInputMap["OrganizationRoleUpdate"];
export type PrincipalPage = ClientOutputMap["Page<Principal>"];
export type AuditExportQuery = ClientInputMap["AuditExportQuery"];
export type AuditExport = ClientOutputMap["AuditExport"];
export type AuditRetention = ClientOutputMap["AuditRetention"];
export type AuditRetentionUpdate = ClientInputMap["AuditRetentionUpdate"];
export type ScimConnection = ClientOutputMap["ScimConnection"];
export type ScimConnectionCreated = ClientOutputMap["ScimConnectionCreated"];
export type ScimConnectionCreate = ClientInputMap["ScimConnectionCreate"];
export type ScimConnectionRotate = ClientInputMap["ScimConnectionRotate"];
export type InstallationSettingsUpdate =
  ClientInputMap["InstallationSettingsUpdate"];
export type OrganizationRecord = ClientOutputMap["Organization"];
export type EffectiveAccess = ClientOutputMap["EffectiveAccess"];
export type OrganizationUpdate = ClientInputMap["OrganizationUpdate"];
export type WorkerListResponse = ClientOutputMap["Page<WorkerHost>"];
export type ExternalTicketResponse = ClientOutputMap["ExternalTicket"];
export type ExternalTicketListResponse =
  ClientOutputMap["Page<ExternalTicket>"];
export type TicketSourceResponse = ClientOutputMap["TicketSource"];
export type TicketSourcePersonResponse = ClientOutputMap["TicketSourcePerson"];
export type TicketSourceListResponse = ClientOutputMap["Page<TicketSource>"];
export type BatchResponse = ClientOutputMap["Batch"];
export type BatchListResponse = ClientOutputMap["Page<Batch>"];
export type BatchIssueResponse = BatchResponse["issues"][number];
export type BatchCreateInput = ClientInputMap["BatchCreate"];
export type PluginPackageListResponse = ClientOutputMap["Page<PluginPackage>"];
export type PluginVersionListResponse = ClientOutputMap["Page<PluginVersion>"];
export type PluginInstallListResponse = ClientOutputMap["Page<PluginInstall>"];
export type PluginInstallResponse = ClientOutputMap["PluginInstall"];
export type PluginPageListResponse = ClientOutputMap["Page<PluginPageEntry>"];
export type PluginPageEntry = PluginPageListResponse["items"][number];
export type PluginPageAccessResponse = ClientOutputMap["PluginPageAccess"];
/**
 * One item a plugin has saved, as the page may know it: where it is kept, how
 * big it is and when it was last saved. The read it comes from carries no saved
 * value at all.
 */
export type SavedDataItem = Readonly<{
  id: string;
  namespace: string;
  key: string;
  sizeBytes: number;
  updatedAt: string;
}>;
export type SavedDataPage = Readonly<{
  items: readonly SavedDataItem[];
  nextCursor: string | null;
}>;
export type TicketSourceCreate = ClientInputMap["TicketSourceCreate"];
export type TicketSourceUpdate = ClientInputMap["TicketSourceUpdate"];
export type TicketOperationReceiptResponse =
  ClientOutputMap["TicketOperationReceipt"];
export type TicketPreviewResultResponse =
  ClientOutputMap["TicketPreviewResult"];
export type TicketRequestResponse = ClientOutputMap["TicketRequest"];
export type TicketRequestIntent = "start" | "plan";
export type TicketTaskLinkResponse = ClientOutputMap["TicketTaskLink"];
export type TicketTaskLinkListResponse =
  ClientOutputMap["Page<TicketTaskLink>"];
export type TicketRequestViewResponse = ClientOutputMap["TicketRequestView"];
export type TicketRequestViewListResponse =
  ClientOutputMap["Page<TicketRequestView>"];
export type TicketSourceLabelListResponse =
  ClientOutputMap["Page<TicketSourceLabel>"];
export type TicketRoutingRuleSetResponse =
  ClientOutputMap["TicketRoutingRuleSet"];
export type TicketRoutingRulesReplace =
  ClientInputMap["TicketRoutingRulesReplace"];
export type WorkerResponse = ClientOutputMap["WorkerHost"];
export type DispatchBlockersResponse = ClientOutputMap["DispatchBlockers"];
export type WorkerEnrollmentListResponse =
  ClientOutputMap["Page<WorkerEnrollmentSummary>"];
export type WorkerEnrollmentResponse = ClientOutputMap["WorkerEnrollment"];
export type EnrollmentStatus = ClientOutputMap["EnrollmentStatus"];
export type WorkerComponentListResponse =
  ClientOutputMap["Page<WorkerComponent>"];
export type WorkerProviderBindingListResponse =
  ClientOutputMap["Page<WorkerProviderBinding>"];
export type WorkerProviderAuthAttemptResponse =
  ClientOutputMap["WorkerProviderAuthAttempt"];
export type WorkerProviderAuthAttemptCreatedResponse =
  ClientOutputMap["WorkerProviderAuthAttemptCreated"];
export type WorkerProviderBindingResponse =
  ClientOutputMap["WorkerProviderBinding"];
export type WorkerProviderBindingCreate =
  ClientInputMap["WorkerProviderBindingCreate"];
export type WorkerEnrollmentCreate = ClientInputMap["WorkerEnrollmentCreate"];
export type WorkerUpdate = ClientInputMap["WorkerUpdate"];

/**
 * The strong `If-Match` value for a stored record version: the version
 * number in a quoted `v<n>` entity tag, which the server reads back as the
 * optimistic-concurrency precondition.
 */
export function versionEtag(version: number): string {
  return `"v${version}"`;
}
export type { AccessAdminClient } from "./access-client.ts";
export type MentionCandidatePage = ClientOutputMap["Page<MentionCandidate>"];
export type MentionCandidate = MentionCandidatePage["items"][number];
export type ConversationAccessPage =
  ClientOutputMap["Page<ConversationAccessGrant>"];
export type ConversationAccessGrant = ConversationAccessPage["items"][number];
/** Where a mention is being written: a task's conversation, or a document's comment thread. */
export type MentionSource =
  | { readonly kind: "conversation"; readonly id: string }
  | { readonly kind: "comment"; readonly id: string };

export type EvaluationBatch = ClientOutputMap["EvaluationBatch"];
export type EvaluationBatchPage = ClientOutputMap["Page<EvaluationBatch>"];
export type EvaluationBatchResultPage =
  ClientOutputMap["Page<EvaluationBatchResult>"];
export type EvaluationBatchResult = EvaluationBatchResultPage["items"][number];
export type EvaluationAttemptPage = ClientOutputMap["Page<EvaluationAttempt>"];
export type EvaluationAttempt = EvaluationAttemptPage["items"][number];
/** What one measured result can be: the seven states the server keeps. */
export type EvaluationResultState = EvaluationBatchResult["state"];

export type OrganizationAccessPage =
  ClientOutputMap["Page<OrganizationAccess>"];
export type OrganizationAccess = OrganizationAccessPage["items"][number];
export type OrganizationInvitationRecipient =
  ClientOutputMap["OrganizationInvitationRecipient"];
export type OrganizationInvitationRecipientResult =
  ClientOutputMap["OrganizationInvitationRecipientResult"];
export type OrganizationInvitationPreview =
  ClientOutputMap["OrganizationInvitationPreview"];
export type BrowserSessionList = ClientOutputMap["BrowserSessionList"];
export type BrowserSession = BrowserSessionList["items"][number];
export type ConnectedClientList = ClientOutputMap["ConnectedClientList"];
export type ConnectedClient = ConnectedClientList["items"][number];
export type ConnectedClientRevocation =
  ClientOutputMap["ConnectedClientRevocation"];
export type BrowserSessionRevocation =
  ClientOutputMap["BrowserSessionRevocation"];
export type BrowserSessionRevocationCount =
  ClientOutputMap["BrowserSessionRevocationCount"];
export type ApplicationListResponse = ClientOutputMap["Page<Application>"];
export type RepositoryListResponse = ClientOutputMap["Page<Repository>"];
export type RepositoryProfileListResponse =
  ClientOutputMap["Page<RepositoryProfile>"];
export type ApplicationResponse = ClientOutputMap["Application"];
export type WorkflowDefinitionResponse = ClientOutputMap["Workflow"];
export type WorkflowDefinitionListResponse = ClientOutputMap["Page<Workflow>"];
export type WorkflowVersionResponse = ClientOutputMap["WorkflowVersion"];
export type WorkflowVersionListResponse =
  ClientOutputMap["Page<WorkflowVersion>"];
export type DefinitionUpdate = ClientInputMap["DefinitionUpdate"];
export type AgentVersionResponse = ClientOutputMap["AgentVersion"];
export type AgentVersionListResponse = ClientOutputMap["Page<AgentVersion>"];
export type AgentDefinitionResponse = ClientOutputMap["AgentDefinition"];
export type MemoryEntryResponse = ClientOutputMap["MemoryEntry"];
export type MemoryEntryListResponse = ClientOutputMap["Page<MemoryEntry>"];
export type MemoryRevisionResponse = ClientOutputMap["MemoryRevision"];
export type MemoryRevisionCreateInput = ClientInputMap["MemoryRevisionCreate"];
export type MemoryRevisionListResponse =
  ClientOutputMap["Page<MemoryRevision>"];
export type AgentDefinitionListResponse =
  ClientOutputMap["Page<AgentDefinition>"];
export type RepositoryResponse = ClientOutputMap["Repository"];
export type RepositoryProfileResponse = ClientOutputMap["RepositoryProfile"];
/** The rules in force for one repository, each with where it came from, and what could check them. */
export type RepositoryEffectiveRulesResponse =
  ClientOutputMap["RepositoryEffectiveRules"];
/** The latest published organization rules baseline, or the empty one at revision 0. */
export type OrganizationRepositoryRulesResponse =
  ClientOutputMap["OrganizationRepositoryRulesRead"];
export type OrganizationRepositoryRuleVersionListResponse =
  ClientOutputMap["Page<OrganizationRepositoryRuleVersion>"];
/** What publishing a draft would do to the organization's repositories: counts, and one page of them. */
export type OrganizationRepositoryRulePreviewResponse =
  ClientOutputMap["RepositoryRulePreviewOrganization"];
/** A published revision of the organization's rules. */
export type OrganizationRepositoryRuleVersionResponse =
  ClientOutputMap["OrganizationRepositoryRuleVersion"];
/** The entries of a draft, as the preview and publication take them. */
export type OrganizationRepositoryRuleEntries =
  ClientInputMap["RepositoryRuleVersionCreate"]["entries"];
export type ApplicationCreate = ClientInputMap["ApplicationCreate"];
export type ApplicationUpdate = ClientInputMap["ApplicationUpdate"];
export type RepositoryCreate = ClientInputMap["RepositoryCreate"];
export type RepositoryUpdate = ClientInputMap["RepositoryUpdate"];
export type RepositoryProfileCreate = ClientInputMap["RepositoryProfileCreate"];
export type RepositoryOnboardingResponse =
  ClientOutputMap["RepositoryOnboarding"];
export type RepositoryProfileObservationResponse =
  ClientOutputMap["RepositoryProfileObservation"];
export type ArtifactQuery = ClientInputMap["ArtifactQuery"];
export type ArtifactVersionImport = ClientInputMap["ArtifactVersionImport"];
export type ArtifactExtractQuery = ClientInputMap["ArtifactExtractQuery"];
export type ArtifactContentQuery = ClientInputMap["ContentRangeQuery"];
export type ArtifactCursorQuery = ClientInputMap["CursorQuery"];
export type ArtifactListResponse = ClientOutputMap["Page<Artifact>"];
export type ArtifactResponse = ClientOutputMap["Artifact"];
export type ArtifactVersionListResponse =
  ClientOutputMap["Page<ArtifactVersionMetadata>"];
export type ArtifactVersionResponse =
  ClientOutputMap["ArtifactVersionMetadata"];
export type ArtifactExtractionResponse = ClientOutputMap["ArtifactExtraction"];
export type ArtifactCommentQuery = ClientInputMap["CommentQuery"];
export type ArtifactCommentCreate = ClientInputMap["ArtifactCommentCreate"];
export type ArtifactCommentUpdate = ClientInputMap["ArtifactCommentUpdate"];
export type ArtifactCommentResponse = ClientOutputMap["ArtifactComment"];
export type ArtifactCommentListResponse =
  ClientOutputMap["Page<ArtifactComment>"];
export type ArtifactUpdate = ClientInputMap["ArtifactUpdate"];
export type ArtifactPinResponse = ClientOutputMap["ArtifactPinResult"];
/** The active shared draft of an artifact (`POST /v1/artifacts/{id}/drafts`). */
export type DraftResponse = ClientOutputMap["Draft"];
/** One publication of a draft checkpoint as a new immutable version. */
export type DraftPublicationResponse = ClientOutputMap["DraftPublication"];
export type DraftPublicationCreate = ClientInputMap["DraftPublicationCreate"];
/** One agent suggestion on a draft, with the state it is in. */
export type DraftSuggestionResponse = ClientOutputMap["DraftSuggestion"];
/** A page of the agent suggestions made on a draft. */
export type DraftSuggestionPageResponse =
  ClientOutputMap["Page<DraftSuggestion>"];
export type ArtifactStorageResponse = ClientOutputMap["ArtifactStorage"];
export type ArtifactPreviewGrantResponse =
  ClientOutputMap["ArtifactPreviewGrant"];
export type ArtifactPreviewAvailabilityResponse =
  ClientOutputMap["ArtifactPreviewAvailability"];
export type MessageCreate = ClientInputMap["MessageCreate"];
export type MessageResponse = ClientOutputMap["Message"];
export type MessageListResponse = ClientOutputMap["Page<Message>"];
export type ConversationTurnResponse = ClientOutputMap["ConversationTurn"];
export type ConversationTurnListResponse =
  ClientOutputMap["Page<ConversationTurn>"];
export type PlanRevisionResponse = ClientOutputMap["PlanRevision"];
export type PlanRevisionListResponse = ClientOutputMap["Page<PlanRevision>"];
export type ApprovalResponse = ClientOutputMap["Approval"];
export type ApprovalListResponse = ClientOutputMap["Page<Approval>"];
export type ApprovalDecision = ClientInputMap["ApprovalDecision"];
export type QuestionResponse = ClientOutputMap["Question"];
export type QuestionListResponse = ClientOutputMap["Page<Question>"];
export type QuestionAnswer = ClientInputMap["QuestionAnswer"];
export type ConversationParticipantListResponse =
  ClientOutputMap["Page<ConversationParticipant>"];
export type CoordinationPlanResponse = ClientOutputMap["CoordinationPlan"];
export type CoordinationPlanListResponse =
  ClientOutputMap["Page<CoordinationPlan>"];
export type TaskRepositoryListResponse =
  ClientOutputMap["Page<TaskRepository>"];
export type ApplicationRepositoryRoleListResponse =
  ClientOutputMap["Page<ApplicationRepositoryRole>"];
export type RoleBindingListResponse = ClientOutputMap["Page<RoleBinding>"];
export type RoleBindingResponse = ClientOutputMap["RoleBinding"];
export type RoleBindingCreate = ClientInputMap["RoleBindingCreate"];
export type RoleBindingUpdate = ClientInputMap["RoleBindingUpdate"];
export type RepositoryBindingSelector =
  ClientInputMap["RepositoryBindingSelector"];
export type RepositoryBindingResolution =
  ClientOutputMap["RepositoryBindingResolution"];

export type ListRepositoryRolesOptions = Readonly<{
  organizationId: string;
  applicationId: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}>;
export type CreateRepositoryRoleOptions = Readonly<{
  organizationId: string;
  input: RoleBindingCreate;
  idempotencyKey?: string;
  signal?: AbortSignal;
}>;
export type UpdateRepositoryRoleOptions = Readonly<{
  organizationId: string;
  applicationId: string;
  roleId: string;
  input: RoleBindingUpdate;
  idempotencyKey?: string;
  signal?: AbortSignal;
}>;
export type ResolveRepositoryRoleOptions = Readonly<{
  organizationId: string;
  applicationId: string;
  input: RepositoryBindingSelector;
  signal?: AbortSignal;
}>;

export type ListArtifactsOptions = Readonly<
  ArtifactQuery & {
    organizationId: string;
    signal?: AbortSignal;
  }
>;
export type GetArtifactStorageOptions = Readonly<{
  organizationId: string;
  signal?: AbortSignal;
}>;
export type GetArtifactPreviewAvailabilityOptions = Readonly<{
  organizationId: string;
  signal?: AbortSignal;
}>;
export type CreateArtifactPreviewOptions = Readonly<{
  organizationId: string;
  versionId: string;
  signal?: AbortSignal;
}>;
export type RevokeArtifactPreviewOptions = Readonly<{
  organizationId: string;
  grantId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}>;
export type GetArtifactOptions = Readonly<{
  organizationId: string;
  id: string;
  signal?: AbortSignal;
}>;
export type ListArtifactVersionsOptions = Readonly<
  ArtifactCursorQuery & {
    organizationId: string;
    artifactId: string;
    signal?: AbortSignal;
  }
>;
export type GetArtifactContentOptions = Readonly<
  ArtifactContentQuery & {
    organizationId: string;
    versionId: string;
    ifRange?: string;
    ifNoneMatch?: string;
    expectedSha256?: string;
    /**
     * Caller bound on the body. A larger advertised length, or a stream that
     * crosses it, is cancelled and reported as an invalid response with status
     * {@link ARTIFACT_CONTENT_OVER_LIMIT_STATUS}.
     */
    maxBytes?: number;
    signal?: AbortSignal;
  }
>;
export type ImportArtifactVersionOptions = Readonly<{
  organizationId: string;
  artifactId: string;
  input: ArtifactVersionImport;
  ifMatch: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}>;
export type ExtractArtifactVersionOptions = Readonly<
  ArtifactExtractQuery & {
    organizationId: string;
    versionId: string;
    signal?: AbortSignal;
  }
>;

export type ArtifactProbeResponse = ClientOutputMap["ArtifactProbeAnswer"];

export type ReadArtifactProbeOptions = Readonly<{
  organizationId: string;
  versionId: string;
  signal?: AbortSignal;
}>;

export type ListArtifactCommentsOptions = Readonly<
  ArtifactCommentQuery & {
    organizationId: string;
    versionId: string;
    signal?: AbortSignal;
  }
>;
export type ListArtifactCommentsAcrossVersionsOptions = Readonly<
  ArtifactCommentQuery & {
    organizationId: string;
    artifactId: string;
    signal?: AbortSignal;
  }
>;
export type CreateArtifactCommentOptions = Readonly<{
  organizationId: string;
  versionId: string;
  input: ArtifactCommentCreate;
  idempotencyKey: string;
  signal?: AbortSignal;
}>;
export type UpdateArtifactCommentOptions = Readonly<{
  organizationId: string;
  id: string;
  input: ArtifactCommentUpdate;
  ifMatch: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}>;
export type UpdateArtifactOptions = Readonly<{
  organizationId: string;
  id: string;
  input: ArtifactUpdate;
  ifMatch: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}>;
export type CreateMessageOptions = Readonly<{
  organizationId: string;
  conversationId: string;
  input: MessageCreate;
  idempotencyKey: string;
  signal?: AbortSignal;
}>;

export type ArtifactContentResponse =
  | Readonly<{
    status: 200;
    contentType: string;
    contentLength: number;
    contentDigest: string;
    content: Uint8Array;
    contentRange?: undefined;
    contentDisposition: string | null;
  }>
  | Readonly<{
    status: 206;
    contentType: string;
    contentLength: number;
    contentDigest: string;
    content: Uint8Array;
    contentRange: string;
    contentDisposition: string | null;
  }>
  | Readonly<{
    status: 304;
    contentType: string;
    contentLength: 0;
    contentDigest: string;
    content: null;
    contentRange?: undefined;
    contentDisposition: string | null;
  }>
  | Readonly<{
    status: 416;
    contentType: string;
    contentLength: 0;
    contentDigest: string;
    content: Uint8Array;
    contentRange: string;
    contentDisposition: string | null;
  }>;
export type JobAttemptPage = ClientOutputMap["Page<JobAttemptRead>"];
export type JobAttemptRead = JobAttemptPage["items"][number];

export type OutputStreamPage = ClientOutputMap["OutputStreamPage"];
export type OutputStream = OutputStreamPage["items"][number];
export type OutputReadPage = ClientOutputMap["OutputReadPage"];

export type StorageFolderPage = ClientOutputMap["Page<StorageFolderItem>"];
export type StorageFolderItem = StorageFolderPage["items"][number];
export type StorageFileVersionPage =
  ClientOutputMap["Page<StorageFileVersion>"];
export type StorageFileVersion = StorageFileVersionPage["items"][number];
export type StorageFileUsePage = ClientOutputMap["Page<StorageFileUse>"];
export type StorageFileUse = StorageFileUsePage["items"][number];

export type StorageFileAtVersion = ClientOutputMap["StorageFileAtVersion"];
export type FileSearchPage = ClientOutputMap["Page<FileSearchHit>"];
export type FileSearchHit = FileSearchPage["items"][number];
export type FileSearchInput = Pick<
  ClientInputMap["FileSearchQuery"],
  | "query"
  | "path"
  | "kind"
  | "mediaGroup"
  | "producerId"
  | "factKey"
  | "factValue"
  | "cursor"
>;
/** What the files of one kind record: each key with each value it holds and how many files hold it. */
export type FileFactPage = ClientOutputMap["Page<FileFact>"];
export type FileFact = FileFactPage["items"][number];
export type LibraryPage = ClientOutputMap["Page<LibraryEntry>"];
export type LibraryEntry = LibraryPage["items"][number];

export type BakeryApiClient = {
  /** The stored files and their folders: the read-only files browser's reads. */
  readonly files: {
    /** The caller's top-level folders, in display order, on one page. */
    readonly roots: (
      organizationId: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<StorageFolderPage>>;
    /** One folder's entries, folders first, by name. */
    readonly entries: (
      organizationId: string,
      folderId: string,
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<StorageFolderPage>>;
    readonly versions: (
      organizationId: string,
      fileId: string,
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<StorageFileVersionPage>>;
    readonly uses: (
      organizationId: string,
      fileId: string,
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<StorageFileUsePage>>;
    /** The file a saved version belongs to, from the version id alone. */
    readonly atVersion: (
      organizationId: string,
      versionId: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<StorageFileAtVersion>>;
    /** Files and library items by name, with the filters of the files page. */
    readonly search: (
      organizationId: string,
      input: FileSearchInput,
      signal?: AbortSignal,
    ) => Promise<ApiResult<FileSearchPage>>;
    /**
     * The address a video or audio element plays a file from. A media element
     * cannot send the organization header, so the organization is in the query,
     * which the server checks against the caller's membership.
     */
    readonly mediaUrl: (
      organizationId: string,
      fileId: string,
      revision?: number,
    ) => string;
    /** The facts the files of one kind record, for the Fact filter. */
    readonly facts: (
      organizationId: string,
      kind: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<FileFactPage>>;
    /** One folder of the read-only library mirror (`/library`, `/library/kinds`). */
    readonly library: (
      organizationId: string,
      path: string,
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<LibraryPage>>;
    /**
     * A file's bytes: its current version, or the one at `revision`. A `range`
     * asks for part of them, as `bytes=0-0` does to check a digest without
     * reading a whole video into the page.
     */
    readonly content: (
      organizationId: string,
      fileId: string,
      revision: number | undefined,
      signal?: AbortSignal,
      range?: string,
    ) => Promise<ApiResult<ClientOutputMap["BinaryArtifact"]>>;
    /**
     * What the probe measured about this version's bytes, or nulls. A file
     * stored inline has no blob and so no answer yet, which is not a refusal.
     */
    readonly probe: (
      organizationId: string,
      fileId: string,
      revision: number | undefined,
      signal?: AbortSignal,
    ) => Promise<ApiResult<ClientOutputMap["ArtifactProbeAnswer"]>>;
  };
  readonly output: {
    readonly attempts: (
      organizationId: string,
      taskId: string,
      jobId: string,
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<JobAttemptPage>>;
    readonly list: (
      organizationId: string,
      input: ClientInputMap["OutputStreamListQuery"],
      signal?: AbortSignal,
    ) => Promise<ApiResult<OutputStreamPage>>;
    readonly read: (
      organizationId: string,
      streamId: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<OutputReadPage>>;
    readonly socketUrl: (organizationId: string) => string;
  };
  /** An agent session's own reads: who ran a step, and what the session did. */
  readonly sessions: {
    readonly list: (
      organizationId: string,
      runStepId: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<AgentSessionPageResponse>>;
    readonly feed: (
      organizationId: string,
      sessionId: string,
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<SessionFeedResponse>>;
    /**
     * Opens the session's server-sent event stream. It resumes after the last
     * event id when one is given, and ends when the signal aborts or the
     * connection drops; a refusal comes back as the read route's own problem.
     */
    readonly stream: (
      organizationId: string,
      sessionId: string,
      lastEventId: string | undefined,
      signal: AbortSignal,
    ) => Promise<ApiResult<ReadableStream<Uint8Array>>>;
  };
  readonly readiness: (
    signal?: AbortSignal,
  ) => Promise<ApiResult<HealthResponse>>;
  readonly identity: (
    signal?: AbortSignal,
  ) => Promise<ApiResult<PrincipalIdentity>>;
  readonly installationStatus: (
    signal?: AbortSignal,
  ) => Promise<ApiResult<InstallationStatus>>;
  readonly listOrganizations: (
    cursor?: string,
    signal?: AbortSignal,
  ) => Promise<ApiResult<OrganizationAccessPage>>;
  readonly invitations: {
    /** Public: no session, no organization scope. */
    readonly preview: (
      invitationId: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<OrganizationInvitationPreview>>;
    readonly recipientGet: (
      id: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<OrganizationInvitationRecipient>>;
    readonly recipientAccept: (
      invitationId: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<OrganizationInvitationRecipientResult>>;
    readonly recipientReject: (
      invitationId: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<OrganizationInvitationRecipientResult>>;
  };
  /** `GET`/`PATCH /v1/me/profile`: the signed-in person's own profile. */
  readonly profile: {
    readonly get: (signal?: AbortSignal) => Promise<ApiResult<UserProfile>>;
    /** `version` is the profile version the edit was made against. */
    readonly update: (options: {
      readonly input: UserProfileUpdate;
      readonly version: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<UserProfile>>;
  };
  /** Per-organization private presentation state (theme, language, zone). */
  readonly userPreferences: {
    readonly get: (options: {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<UserPreferences>>;
    /** `input.expectedCasVersion` is the `casVersion` the edit started from. */
    readonly update: (options: {
      readonly organizationId: string;
      readonly input: UserPreferencesUpdate;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<UserPreferences>>;
  };
  readonly organizations: {
    readonly get: (options: {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<OrganizationRecord>>;
    /** `GET /v1/organizations/{id}/effective-access`: the caller's live role and capabilities. */
    readonly effectiveAccess: (options: {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<EffectiveAccess>>;
    /** `version` is the organization version the edit was made against. */
    readonly update: (options: {
      readonly organizationId: string;
      readonly input: OrganizationUpdate;
      readonly version: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<OrganizationRecord>>;
  };
  readonly auditEvents: {
    /** `GET /v1/audit-events`: the selected organization's audit trail, newest first. */
    readonly list: (options: {
      readonly organizationId: string;
      readonly query: AuditEventsQuery;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<AuditEventPage>>;
    /** `GET /v1/audit-events/export` (paid `audit.export`): a bounded JSON Lines document. */
    readonly export: (options: {
      readonly organizationId: string;
      readonly query: AuditExportQuery;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<AuditExport>>;
  };
  readonly auditRetention: {
    /** `GET /v1/audit-retention`: the organization's retention window. */
    readonly get: (options: {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<AuditRetention>>;
    /** `PATCH /v1/audit-retention` (paid `audit.retention`). */
    readonly update: (options: {
      readonly organizationId: string;
      readonly input: AuditRetentionUpdate;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<AuditRetention>>;
  };
  readonly organizationRoles: {
    /** `GET /v1/organization-roles`: the organization's custom roles. */
    readonly list: (options: {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<OrganizationRolePage>>;
    /** `POST /v1/organization-roles` (paid `roles.custom`). */
    readonly create: (options: {
      readonly organizationId: string;
      readonly input: OrganizationRoleCreate;
      readonly idempotencyKey?: string;
    }) => Promise<ApiResult<OrganizationRoleItem>>;
    /** `PATCH /v1/organization-roles/{id}` (paid `roles.custom`). */
    readonly update: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly version: number;
      readonly input: OrganizationRoleUpdate;
      readonly idempotencyKey?: string;
    }) => Promise<ApiResult<OrganizationRoleItem>>;
    /** `DELETE /v1/organization-roles/{id}`; refused while the role has holders. */
    readonly delete: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly version: number;
      readonly idempotencyKey?: string;
    }) => Promise<ApiResult<void>>;
    /** `POST /v1/organization-roles/{id}/members` (paid `roles.custom`). */
    readonly assign: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly principalId: string;
      readonly idempotencyKey?: string;
    }) => Promise<ApiResult<OrganizationRoleItem>>;
    /** `DELETE /v1/organization-roles/{id}/members/{principalId}`. */
    readonly unassign: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly principalId: string;
      readonly idempotencyKey?: string;
    }) => Promise<ApiResult<void>>;
  };
  /** Private plugins published to the organization, and who has them installed. */
  readonly plugins: {
    /** `GET /v1/plugin-packages`: the plugins published in this organization. */
    readonly packages: (options: {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<PluginPackageListResponse>>;
    /** `GET /v1/plugin-packages/{id}/versions`: the published versions of one plugin. */
    readonly versions: (options: {
      readonly organizationId: string;
      readonly packageId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<PluginVersionListResponse>>;
    /** `GET /v1/plugin-installs`: the installs this person may see. */
    readonly installs: (options: {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<PluginInstallListResponse>>;
    /** `GET /v1/plugin-pages`: every page of every plugin that is on and that this person has, for the sidebar. */
    readonly pages: (options: {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<PluginPageListResponse>>;
    /** `GET /v1/plugin-installs/{id}/pages/{pageId}`: whether one page may be shown, and why not when it may not. */
    readonly page: (options: {
      readonly organizationId: string;
      readonly installId: string;
      readonly pageId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<PluginPageAccessResponse>>;
    /** `POST /v1/plugin-installs`: installs one published version, for everyone or for one person. */
    readonly install: (options: {
      readonly organizationId: string;
      readonly packageId: string;
      readonly versionId: string;
      readonly scope: "organization" | "personal";
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<PluginInstallResponse>>;
    /** `GET /v1/plugin-installs/{id}/state-items`: what the plugin has saved, with no values in the response. */
    readonly savedData: (options: {
      readonly organizationId: string;
      readonly installId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<SavedDataPage>>;
    /** `PATCH /v1/plugin-installs/{id}`: turns an install on or off, moves it to another version, or removes it. */
    readonly update: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly version: number;
      readonly change: {
        readonly versionId?: string;
        readonly status?: "enabled" | "disabled" | "uninstalled";
        readonly dismissUpdateFailure?: boolean;
      };
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<PluginInstallResponse>>;
  };
  /** Bounded runs of issues: start one, watch it, pause, resume or stop it. */
  readonly batches: {
    /** `GET /v1/batches`: batches newest first, optionally for one repository. */
    readonly list: (options: {
      readonly organizationId: string;
      readonly repositoryId?: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<BatchListResponse>>;
    /** `GET /v1/batches/{id}`: one batch with the issues it considered. */
    readonly get: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<BatchResponse>>;
    /** `POST /v1/batches`: starts a batch in one repository. */
    readonly create: (options: {
      readonly organizationId: string;
      readonly input: BatchCreateInput;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<BatchResponse>>;
    /** `POST /v1/batches/{id}/pause`, `resume`, `start-next` and `finish`: nothing to send but the batch. */
    readonly control: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly action: "pause" | "resume" | "startNext" | "finish";
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<BatchResponse>>;
    /** `POST /v1/batches/{id}/stop`: stops a batch; `cancelCurrent` also cancels the issue being worked on. */
    readonly stop: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly cancelCurrent: boolean;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<BatchResponse>>;
  };
  /** GitHub issues Bakery has read, and the repositories it takes them from. */
  readonly tickets: {
    /** `GET /v1/external-tickets`: the saved copy of the issues, newest first. */
    readonly list: (options: {
      readonly organizationId: string;
      readonly sourceId?: string;
      readonly state?: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<ExternalTicketListResponse>>;
    /** `GET /v1/external-tickets/{id}`: one issue with its latest check and running request. */
    readonly get: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<ExternalTicketResponse>>;
    /** `POST /v1/external-tickets/{id}/readiness-checks`: asks Bakery to check the issue again. */
    readonly check: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly expectedSourcePolicyRevision: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketOperationReceiptResponse>>;
    /** `POST /v1/external-tickets/{id}/requests`: starts work on the issue (or plans it first). */
    readonly request: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly intent: TicketRequestIntent;
      readonly expectedSourcePolicyRevision: number;
      readonly requirementsDigest: string;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketRequestResponse>>;
    /** `GET /v1/ticket-sources`: the repositories Bakery takes issues from. */
    readonly sources: (options: {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketSourceListResponse>>;
    /** `POST /v1/ticket-sources`: starts taking issues from a repository. Admin only. */
    readonly createSource: (options: {
      readonly organizationId: string;
      readonly input: TicketSourceCreate;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketSourceResponse>>;
    /** `PATCH /v1/ticket-sources/{id}`: turn a repository on or off, or change its labels. Admin only. */
    readonly updateSource: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly input: TicketSourceUpdate;
      readonly version: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketSourceResponse>>;
    /** `GET /v1/ticket-sources/{id}`: one repository's issue settings. */
    readonly source: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketSourceResponse>>;
    /** `POST /v1/ticket-sources/{id}/previews`: reads GitHub again and answers how each issue would be judged under the saved settings; stores nothing. */
    readonly preview: (options: {
      readonly organizationId: string;
      readonly sourceId: string;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketPreviewResultResponse>>;
    /** `GET /v1/ticket-sources/{id}/people/{login}`: turns a GitHub username into the id the settings store. */
    readonly lookupPerson: (options: {
      readonly organizationId: string;
      readonly sourceId: string;
      readonly login: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketSourcePersonResponse>>;
    /** `POST /v1/ticket-sources/{id}/syncs`: asks Bakery to read GitHub again. Admin only. */
    readonly sync: (options: {
      readonly organizationId: string;
      readonly sourceId: string;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketOperationReceiptResponse>>;
    /** `GET /v1/ticket-task-links`: the tasks linked to one issue, or the issues one task is linked to. Name exactly one of the two. */
    readonly links: (options: {
      readonly organizationId: string;
      readonly externalTicketId?: string;
      readonly taskId?: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketTaskLinkListResponse>>;
    /** `GET /v1/ticket-requests`: the work started from one issue, newest first, with its progress. */
    readonly requests: (options: {
      readonly organizationId: string;
      readonly externalTicketId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketRequestViewListResponse>>;
    /** `GET /v1/ticket-sources/{id}/labels`: the labels GitHub lists for the repository, read live. */
    readonly labels: (options: {
      readonly organizationId: string;
      readonly sourceId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketSourceLabelListResponse>>;
    /** `POST /v1/ticket-task-links/{id}/note-syncs`: asks Bakery to update its note on the GitHub issue again. */
    readonly resyncNote: (options: {
      readonly organizationId: string;
      readonly linkId: string;
      readonly version: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketTaskLinkResponse>>;
    /** `GET /v1/ticket-sources/{id}/routing-rules`: which labels send an issue to which repository. */
    readonly routingRules: (options: {
      readonly organizationId: string;
      readonly sourceId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketRoutingRuleSetResponse>>;
    /** `PUT /v1/ticket-sources/{id}/routing-rules`: replaces the whole list of rules. Admin only. */
    readonly replaceRoutingRules: (options: {
      readonly organizationId: string;
      readonly sourceId: string;
      readonly input: TicketRoutingRulesReplace;
      readonly version: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketRoutingRuleSetResponse>>;
  };
  readonly workers: {
    readonly list: (options: {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerListResponse>>;
    readonly get: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerResponse>>;
    readonly enroll: (options: {
      readonly organizationId: string;
      readonly input: WorkerEnrollmentCreate;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerEnrollmentResponse>>;
    readonly repairEnrollment: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerEnrollmentResponse>>;
    /** `PATCH /v1/workers/{id}`: the mode an administrator asks of a machine (`status`: online, offline, draining). */
    readonly update: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly input: WorkerUpdate;
      readonly version?: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerResponse>>;
    /** `POST /v1/workers/{id}/revocations`: retire a machine; its sign-in to Bakery ends for good. */
    readonly revoke: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly version?: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerResponse>>;
  };
  readonly machines: {
    readonly dispatchBlockers: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<DispatchBlockersResponse>>;
  };
  readonly workerEnrollments: {
    readonly list: (options: {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerEnrollmentListResponse>>;
    readonly get: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<EnrollmentStatus>>;
    readonly cancel: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly version?: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<EnrollmentStatus>>;
    readonly replace: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly version?: number;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerEnrollmentResponse>>;
  };
  readonly workerComponents: {
    readonly list: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerComponentListResponse>>;
  };
  readonly workerProviderBindings: {
    readonly list: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerProviderBindingListResponse>>;
    /** `POST /v1/workers/:id/provider-bindings`: one binding for a component the machine reported. */
    readonly create: (options: {
      readonly organizationId: string;
      readonly workerId: string;
      readonly input: WorkerProviderBindingCreate;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerProviderBindingResponse>>;
  };
  readonly workerProviderAuth: {
    readonly create: (options: {
      readonly organizationId: string;
      readonly workerId: string;
      readonly bindingId: string;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerProviderAuthAttemptCreatedResponse>>;
    readonly get: (options: {
      readonly organizationId: string;
      readonly workerId: string;
      readonly bindingId: string;
      readonly authAttemptId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerProviderAuthAttemptResponse>>;
    readonly cancel: (options: {
      readonly organizationId: string;
      readonly workerId: string;
      readonly bindingId: string;
      readonly authAttemptId: string;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<WorkerProviderAuthAttemptResponse>>;
  };
  readonly principals: {
    /** `GET /v1/principals`: the organization's members, service accounts and workers. */
    readonly list: (options: {
      readonly organizationId: string;
      /** The page after this cursor; omitted for the first. */
      readonly cursor?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<PrincipalPage>>;
  };
  readonly installationAuditEvents: {
    /** `GET /v1/installation/audit-events`: installation-level audit rows, newest first. */
    readonly list: (options: {
      readonly query: AuditEventsQuery;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<AuditEventPage>>;
  };
  readonly scimConnection: {
    /** `GET /v1/scim-connection`: the selected organization's SCIM connection, without secrets. */
    readonly get: (options: {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<ScimConnection>>;
    /** `POST /v1/scim-connection`: creates the connection; the secret is returned once. */
    readonly create: (options: {
      readonly organizationId: string;
      readonly input: ScimConnectionCreate;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<ScimConnectionCreated>>;
    /** `POST /v1/scim-connection/rotate`: issues a replacement secret, returned once. */
    readonly rotate: (options: {
      readonly organizationId: string;
      readonly input: ScimConnectionRotate;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<ScimConnectionCreated>>;
    /** `POST /v1/scim-connection/revoke`: ends provisioning access. */
    readonly revoke: (options: {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<ScimConnection>>;
  };
  readonly installationCapabilities: {
    readonly get: (
      signal?: AbortSignal,
    ) => Promise<ApiResult<InstallationCapabilities>>;
  };
  /**
   * Where Bakery sends its measurements (#739); installation administrators
   * with a browser session only. A result never carries a secret.
   */
  readonly telemetryDestinations: {
    /** `GET /v1/installation/telemetry-destinations`: the kinds, the measurements, the providers and one page of the destinations that match the search and filters. */
    readonly list: (
      query?: TelemetryDestinationListQuery,
      signal?: AbortSignal,
    ) => Promise<ApiResult<TelemetryDestinationList>>;
    /** `GET /v1/installation/telemetry-destinations/{id}`: one destination with its kind, provider and the measurements. */
    readonly get: (
      id: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<TelemetryDestinationDetail>>;
    /** `POST /v1/installation/telemetry-destinations`: adds one. */
    readonly create: (options: {
      readonly input: TelemetryDestinationCreate;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TelemetryDestination>>;
    /** `PATCH /v1/installation/telemetry-destinations/{id}`: changes one, with its version as If-Match. */
    readonly update: (options: {
      readonly id: string;
      readonly input: Omit<TelemetryDestinationUpdate, "id">;
      readonly version: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TelemetryDestination>>;
    /** `DELETE /v1/installation/telemetry-destinations/{id}`: removes one, with its version as If-Match. */
    readonly remove: (options: {
      readonly id: string;
      readonly version: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<undefined>>;
    /** `POST /v1/installation/telemetry-destination-tests`: sends one harmless message and reports the answer. */
    readonly test: (options: {
      readonly input: TelemetryDestinationTest;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TelemetryDestinationTestResult>>;
  };
  readonly storageSettings: {
    /** `GET /v1/storage/settings`: the organization's storage limits and how much of the quota is used. */
    readonly get: (options: {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<StorageSettings>>;
    /** `PUT /v1/storage/settings`: replace every limit; `version` 0 is the first save and sends no If-Match. */
    readonly put: (options: {
      readonly organizationId: string;
      readonly input: StorageSettingsPut;
      readonly version: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<StorageSettings>>;
  };
  readonly usage: {
    /** `GET /v1/usage`: the installation's usage summary (administrators only). */
    readonly list: (options: {
      readonly query: UsageQuery;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<UsageSummary>>;
  };
  readonly metrics: {
    /** `GET /v1/metrics`: one delivery metric over a window. */
    readonly get: (options: {
      readonly organizationId: string;
      readonly query: MetricsQuery;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<MetricSeries>>;
    /** `GET /v1/metrics/sources`: the records behind it, keyset paged. */
    readonly sources: (options: {
      readonly organizationId: string;
      readonly query: MetricSourcesQuery;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<MetricSourcePage>>;
  };
  readonly installationSettings: {
    readonly get: (
      signal?: AbortSignal,
    ) => Promise<ApiResult<InstallationSettings>>;
    readonly update: (options: {
      readonly input: InstallationSettingsUpdate;
      readonly version: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<InstallationSettings>>;
  };
  readonly integrationAppRegistrations: {
    /** `GET /v1/integration-app-registrations/github`: the installation GitHub App, never a secret. */
    readonly get: (
      signal?: AbortSignal,
    ) => Promise<ApiResult<IntegrationAppRegistration>>;
    /** `POST /v1/integration-app-registrations/github/manifest`: a single-use manifest and state. */
    readonly begin: (options: {
      readonly input: IntegrationAppRegistrationBegin;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationAppManifestStart>>;
    /**
     * `PUT /v1/integration-app-registrations/github`: registers an existing
     * App, or replaces the registered App's credentials when `version` is set.
     * The input carries write-only secrets; the result never does.
     */
    readonly put: (options: {
      readonly input: IntegrationAppRegistrationPut;
      readonly version?: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationAppRegistration>>;
  };
  /**
   * This installation's Slack app (#415): read, save, check and remove. An
   * administrator's own action; a result never carries a secret.
   */
  readonly integrationSlackApp: {
    /** `GET /v1/integrations/slack/app`: what is saved, never a secret. */
    readonly get: (
      signal?: AbortSignal,
    ) => Promise<ApiResult<IntegrationSlackApp>>;
    /**
     * `PUT /v1/integrations/slack/app`: app id, client id, and whichever
     * secrets changed. An omitted secret keeps the saved one.
     */
    readonly put: (options: {
      readonly input: IntegrationSlackAppPut;
      readonly version?: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationSlackApp>>;
    /**
     * `POST /v1/integrations/slack/app/check`: ask Slack whether it recognises
     * the saved client pair. The server answers only about the version the
     * caller has seen, so `version` is the value the page loaded.
     */
    readonly check: (options: {
      readonly version: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationSlackAppCheck>>;
    /** `DELETE /v1/integrations/slack/app`: forget the details, keep the links. */
    readonly remove: (options: {
      readonly version: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationSlackApp>>;
  };
  /**
   * Provider OAuth client credentials, per provider (#410); installation
   * administrators only. A result never carries the secret.
   */
  readonly integrationClientCredentials: {
    /** `GET /v1/integration-client-credentials/{provider}`: configured or not, the client ID, when the secret was saved. */
    readonly get: (options: {
      readonly provider: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationClientCredentials>>;
    /**
     * `PUT /v1/integration-client-credentials/{provider}`: registers the pair, or
     * replaces it when `version` is set. The input carries a write-only secret.
     */
    readonly put: (options: {
      readonly provider: string;
      readonly input: IntegrationClientCredentialsPut;
      readonly version?: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationClientCredentials>>;
  };
  /** Installation skill object storage; administrators only, never a secret in a result. */
  readonly skillStorage: {
    /** `GET /v1/installation/skill-storage`: the saved account, bucket and credential flags. */
    readonly get: (
      signal?: AbortSignal,
    ) => Promise<ApiResult<SkillStorageSettings>>;
    /**
     * `PUT /v1/installation/skill-storage`: saves the settings, with the
     * current `version` once settings exist. The input carries write-only
     * credentials; the result never does.
     */
    readonly put: (options: {
      readonly input: SkillStorageSettingsPut;
      readonly version?: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<SkillStorageSettings>>;
    /** `POST /v1/installation/skill-storage/verification`: one bounded probe; a failed probe is still a result. */
    readonly verify: (options: {
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<SkillStorageVerification>>;
  };
  /** Organization GitHub connections; every call names its organization. */
  readonly integrationConnections: {
    /** `GET /v1/integration-connections/:id`: one connection. */
    readonly get: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationConnection>>;
    /** `GET /v1/integration-connections`: one page, newest first. */
    readonly list: (options: {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationConnectionPage>>;
    /** `PATCH /v1/integration-connections/:id`: enable, disable or rename. */
    readonly update: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly input: IntegrationConnectionUpdate;
      readonly version: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationConnection>>;
    /** `POST /v1/integration-connections/:id/checks`: the provider health probe. */
    readonly check: (options: {
      readonly organizationId: string;
      readonly id: string;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<ConnectionCheck>>;
  };
  readonly integrationResources: {
    /** `GET /v1/integration-connections/:id/resources`: one page of discovered resources. */
    readonly list: (options: {
      readonly organizationId: string;
      readonly connectionId: string;
      readonly query: IntegrationResourceQuery;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationResourcePage>>;
    /** `PATCH /v1/integration-connections/:id/resources/:resourceId`: select or deselect. */
    readonly update: (options: {
      readonly organizationId: string;
      readonly connectionId: string;
      readonly resourceId: string;
      readonly input: IntegrationResourceUpdate;
      readonly version: number;
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationResource>>;
  };
  readonly integrationAuthAttempts: {
    /**
     * `POST /v1/integration-auth-attempts`: a session-bound GitHub connect
     * attempt. Its URLs carry the single-use state; keep them in memory or
     * session storage only.
     */
    readonly create: (options: {
      readonly organizationId: string;
      readonly idempotencyKey: string;
      /** Refresh this connection's access instead of adding a new one. */
      readonly reconnectConnectionId?: string;
      /** Where the setup callback returns to; an in-app path starting with "/". */
      readonly returnPath?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<IntegrationAuthAttemptCreated>>;
  };
  readonly browserSessions: {
    readonly list: (
      signal?: AbortSignal,
    ) => Promise<ApiResult<BrowserSessionList>>;
    readonly revoke: (
      id: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<BrowserSessionRevocation>>;
    readonly revokeOthers: (
      signal?: AbortSignal,
    ) => Promise<ApiResult<BrowserSessionRevocationCount>>;
  };
  /** Organization access administration: members, invitations, tokens, bindings. */
  readonly access: AccessAdminClient;
  /** The OAuth client grants the signed-in person holds, and their revocation. */
  readonly connectedClients: {
    readonly list: (
      signal?: AbortSignal,
    ) => Promise<ApiResult<ConnectedClientList>>;
    readonly revoke: (
      id: string,
      signal?: AbortSignal,
    ) => Promise<ApiResult<ConnectedClientRevocation>>;
  };
  readonly auth: AuthProviderClient;
  readonly getTask: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<TaskResponse>>;
  readonly listTasks: (
    options: TaskCursorQuery & {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    },
  ) => Promise<ApiResult<TaskListResponse>>;
  readonly listNotifications: (
    options: NotificationCursorQuery & {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    },
  ) => Promise<ApiResult<NotificationListResponse>>;
  readonly notificationCount: (options: {
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<NotificationCountResponse>>;
  readonly resolveNotificationTarget: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<NotificationTargetResponse>>;
  readonly setNotificationRead: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly read: boolean;
    readonly expectedCasVersion: number;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<NotificationResponse>>;
  readonly markAllNotificationsRead: (options: {
    readonly organizationId: string;
    readonly readBefore: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<NotificationMarkAllReadResponse>>;
  readonly createTask: (options: {
    readonly organizationId: string;
    readonly input: TaskCreate;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<TaskResponse>>;
  readonly updateTask: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly input: TaskUpdate;
    /** Task version the update is bound to (`If-Match`). */
    readonly version: number;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<TaskResponse>>;
  readonly listWorkflowPresets: (
    options: WorkflowPresetsListQuery & {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    },
  ) => Promise<ApiResult<WorkflowPresetListResponse>>;
  readonly createRun: (options: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly input: RunCreate;
    /** Reuse the same key and immutable input when an outcome is unknown. */
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RunResponse>>;
  readonly listRuns: (options: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RunListResponse>>;
  readonly controlRun: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly input: RunControl;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RunResponse>>;
  readonly getRun: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RunResponse>>;
  /**
   * The choices a run is waiting on: each step whose model has an open incident,
   * what it waits on and the other routes it could continue on. A read of
   * current state; nothing is switched by reading it. Developers and Admins only.
   */
  readonly listRouteContinuations: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RouteContinuationOffersResponse>>;
  /**
   * A person's choice to continue one waiting step on another route, against the
   * exact offer they saw. A stale or refused choice commits nothing and names why
   * (`ApiFailure.problem.reason`). Reuse the key and input when the outcome is
   * unknown.
   */
  readonly admitRouteContinuation: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly input: RouteContinuationAdmit;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RouteContinuationResponse>>;
  readonly getRunControlCapabilities: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RunControlCapabilities>>;
  readonly listRunSteps: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RunStepListResponse>>;
  readonly listRunChecks: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<CheckRunListResponse>>;
  readonly listRunReviews: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ReviewCycleListResponse>>;
  readonly listReviewFindings: (options: {
    readonly organizationId: string;
    readonly reviewCycleId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ReviewFindingListResponse>>;
  readonly listRunDeliveryDecisions: (options: {
    readonly organizationId: string;
    readonly runId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<DeliveryDecisionListResponse>>;
  /**
   * The task's pull requests. `runId` narrows them to the ones a run opened;
   * a pull request registered without a run never matches it.
   */
  readonly listPullRequests: (options: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly runId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<PullRequestListResponse>>;
  /**
   * One pull request's merge attempts, newest first. An attempt whose outcome
   * Bakery does not know reads as `unknown`, so the answer survives a reload.
   */
  readonly listMergeAttempts: (options: {
    readonly organizationId: string;
    readonly pullRequestId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MergeAttemptListResponse>>;
  /**
   * Asks Bakery to merge a pull request at the exact head the person saw. The
   * server re-reads GitHub, checks the results and records the attempt; the
   * page never chooses the method (it sends the one the pull request served).
   */
  readonly mergePullRequest: (options: {
    readonly organizationId: string;
    readonly pullRequestId: string;
    readonly expectedHeadSha: string;
    readonly expectedBaseSha?: string;
    readonly mergeMethod: "merge" | "squash" | "rebase";
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MergeAttemptResponse>>;
  /**
   * One pull request's merge queue entries, newest first. An entry still
   * queued, being checked or merging reads the same after a reload.
   */
  readonly listMergeEntries: (options: {
    readonly organizationId: string;
    readonly pullRequestId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MergeEntryListResponse>>;
  /**
   * Asks Bakery to queue a merge of the candidate the person saw: the exact
   * head and base, with the run, review and checks that vouch for it. Bakery
   * checks that nothing changed, then merges; a repeat with the same key
   * answers with the same entry.
   */
  readonly createMergeEntry: (options: {
    readonly organizationId: string;
    readonly input: MergeEntryCreate;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MergeEntryResponse>>;
  /** Settles an unknown attempt by reading GitHub; it never sends a second merge. */
  readonly reconcileMergeAttempts: (options: {
    readonly organizationId: string;
    readonly pullRequestId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MergeReconciliationResponse>>;
  readonly sync: (
    options: SyncQuery & {
      readonly organizationId: string;
      readonly signal?: AbortSignal;
    },
  ) => Promise<ApiResult<SyncResponse>>;
  readonly listApplications: (options: {
    readonly organizationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ApplicationListResponse>>;
  readonly getApplication: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ApplicationResponse>>;
  readonly getWorkflow: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowDefinitionResponse>>;
  /** The organization's workflow definitions, one page of a cursor list. */
  readonly listWorkflows: (options: {
    readonly organizationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowDefinitionListResponse>>;
  /** The versions of one workflow, one page of a cursor list. */
  readonly listWorkflowVersions: (options: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowVersionListResponse>>;
  /** Makes a published version the one new tasks use; `version` is the workflow's, sent as If-Match. */
  readonly activateWorkflowVersion: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly versionId: string;
    readonly version: number;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowDefinitionResponse>>;
  /** Renames, describes, turns on or off a workflow; `version` is the workflow's, sent as If-Match. */
  readonly updateWorkflow: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly input: DefinitionUpdate;
    readonly version: number;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowDefinitionResponse>>;
  /** One agent definition of the organization. */
  readonly getAgent: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<AgentDefinitionResponse>>;
  /** Makes a version the one new tasks use; `version` is the agent's, sent as If-Match. */
  readonly activateAgentVersion: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly versionId: string;
    readonly version: number;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<AgentDefinitionResponse>>;
  /** Renames, describes, turns on or off an agent; `version` is the agent's, sent as If-Match. */
  readonly updateAgent: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly input: DefinitionUpdate;
    readonly version: number;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<AgentDefinitionResponse>>;
  /** Creates a workflow of the organization (a name; its versions come next). */
  readonly createWorkflow: (options: {
    readonly organizationId: string;
    readonly input: NamedDefinitionCreate;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowDefinitionResponse>>;
  /** Adds a draft version to a workflow from a definition. */
  readonly createWorkflowVersion: (options: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly input: WorkflowVersionCreate;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowVersionResponse>>;
  /** Publishes a draft version (its digest expected back, so a stale page cannot publish). */
  readonly publishWorkflowVersion: (options: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly versionId: string;
    readonly expectedDigest: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowVersionResponse>>;
  /** Saves this workflow's draft version (PATCH, with the version's own If-Match). */
  readonly updateWorkflowVersion: (options: {
    readonly organizationId: string;
    readonly workflowId: string;
    readonly versionId: string;
    readonly input: WorkflowDraftUpdate;
    readonly version: number;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<WorkflowVersionResponse>>;
  /** Checks a definition without saving it; the report lists errors and warnings. */
  readonly validateWorkflow: (options: {
    readonly organizationId: string;
    readonly input: WorkflowValidationInput;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ValidationReportResponse>>;
  /** The versions of one agent, one page of a cursor list. */
  readonly listAgentVersions: (options: {
    readonly organizationId: string;
    readonly agentId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<AgentVersionListResponse>>;
  /** The organization's remembered facts, one page of a cursor list; each entry carries its current revision. */
  readonly listMemories: (options: {
    readonly organizationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MemoryEntryListResponse>>;
  /** One remembered fact with its current revision. */
  readonly getMemory: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MemoryEntryResponse>>;
  /** A fact's wordings, newest first: the history shown under it. */
  readonly listMemoryRevisions: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MemoryRevisionListResponse>>;
  /** The runs of the organization, newest first: one page of the Evaluations tab. */
  readonly listEvaluationBatches: (options: {
    readonly organizationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<EvaluationBatchPage>>;
  /** One run with its counts and its quality gate. */
  readonly getEvaluationBatch: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<EvaluationBatch>>;
  /** Stops a run that is waiting or running. `version` is the run's own, sent as If-Match. */
  readonly cancelEvaluationBatch: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly version: number;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<EvaluationBatch>>;
  /** The results of one run, optionally only those in one state. */
  readonly listEvaluationResults: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly state?: EvaluationResultState;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<EvaluationBatchResultPage>>;
  /** The attempts behind one result, newest first. */
  readonly listEvaluationAttempts: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<EvaluationAttemptPage>>;
  /**
   * Puts a fact in use (approving a suggestion, or using it again) or stops
   * using it. `version` is the fact's own, sent as If-Match; the server may
   * refuse with a reason (a source it cannot hold, a conflicting fact).
   */
  readonly updateMemory: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly status: "active" | "retired";
    readonly version: number;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MemoryEntryResponse>>;
  /** Corrects a fact: a new wording with the reason and the source version that says so. */
  readonly createMemoryRevision: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly input: MemoryRevisionCreateInput;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MemoryRevisionResponse>>;
  /** The organization's agent definitions, one page of a cursor list. */
  readonly listAgents: (options: {
    readonly organizationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<AgentDefinitionListResponse>>;
  readonly createApplication: (options: {
    readonly organizationId: string;
    readonly input: ApplicationCreate;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ApplicationResponse>>;
  readonly updateApplication: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly input: ApplicationUpdate;
    readonly ifMatch: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ApplicationResponse>>;
  readonly listRepositories: (options: {
    readonly organizationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryListResponse>>;
  readonly getRepository: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryResponse>>;
  readonly createRepository: (options: {
    readonly organizationId: string;
    readonly input: RepositoryCreate;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryResponse>>;
  readonly updateRepository: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly input: RepositoryUpdate;
    readonly ifMatch: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryResponse>>;
  readonly listRepositoryProfiles: (options: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryProfileListResponse>>;
  readonly createRepositoryProfile: (options: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly input: RepositoryProfileCreate;
    /** The repository's version, for a save that puts its version in use itself (one that keeps the version in use's rules). */
    readonly ifMatch?: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryProfileResponse>>;
  /** `GET /v1/organizations/:id/repository-rules`: the current baseline (revision 0 when none). */
  readonly getOrganizationRepositoryRules: (options: {
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<OrganizationRepositoryRulesResponse>>;
  /** `GET /v1/organizations/:id/repository-rule-versions`: published revisions, newest first. */
  readonly listOrganizationRepositoryRuleVersions: (options: {
    readonly organizationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<OrganizationRepositoryRuleVersionListResponse>>;
  /** `POST /v1/organizations/:id/repository-rule-previews`: what a draft would do, one page of repositories. Writes nothing. */
  readonly previewOrganizationRepositoryRules: (options: {
    readonly organizationId: string;
    readonly expectedRevision: number;
    readonly entries: OrganizationRepositoryRuleEntries;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<OrganizationRepositoryRulePreviewResponse>>;
  /** `GET /v1/repositories/:id/rules`: the rules in force for one repository (Developer access). */
  readonly getRepositoryEffectiveRules: (options: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryEffectiveRulesResponse>>;
  /** `POST /v1/organizations/:id/repository-rule-versions`: publishes a draft as the next revision. */
  readonly publishOrganizationRepositoryRules: (options: {
    readonly organizationId: string;
    readonly expectedRevision: number;
    readonly entries: OrganizationRepositoryRuleEntries;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<OrganizationRepositoryRuleVersionResponse>>;
  readonly startRepositoryOnboarding: (options: {
    readonly organizationId: string;
    readonly repositoryId: string;
    readonly idempotencyKey?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryOnboardingResponse>>;
  readonly getRepositoryOnboarding: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryOnboardingResponse>>;
  readonly getRepositoryProfileObservation: (options: {
    readonly organizationId: string;
    readonly id: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<RepositoryProfileObservationResponse>>;
  readonly listRepositoryRoles: (
    options: ListRepositoryRolesOptions,
  ) => Promise<ApiResult<RoleBindingListResponse>>;
  readonly createRepositoryRole: (
    options: CreateRepositoryRoleOptions,
  ) => Promise<ApiResult<RoleBindingResponse>>;
  readonly updateRepositoryRole: (
    options: UpdateRepositoryRoleOptions,
  ) => Promise<ApiResult<RoleBindingResponse>>;
  readonly resolveRepositoryRole: (
    options: ResolveRepositoryRoleOptions,
  ) => Promise<ApiResult<RepositoryBindingResolution>>;
  readonly listArtifacts: (
    options: ListArtifactsOptions,
  ) => Promise<ApiResult<ArtifactListResponse>>;
  readonly getArtifactStorage: (
    options: GetArtifactStorageOptions,
  ) => Promise<ApiResult<ArtifactStorageResponse>>;
  readonly getArtifactPreviewAvailability: (
    options: GetArtifactPreviewAvailabilityOptions,
  ) => Promise<ApiResult<ArtifactPreviewAvailabilityResponse>>;
  /** Issues a one-use 30 second grant; never cached, retried or stored. */
  readonly createArtifactPreview: (
    options: CreateArtifactPreviewOptions,
  ) => Promise<ApiResult<ArtifactPreviewGrantResponse>>;
  readonly revokeArtifactPreview: (
    options: RevokeArtifactPreviewOptions,
  ) => Promise<ApiResult<unknown>>;
  readonly getArtifact: (
    options: GetArtifactOptions,
  ) => Promise<ApiResult<ArtifactResponse>>;
  readonly listArtifactVersions: (
    options: ListArtifactVersionsOptions,
  ) => Promise<ApiResult<ArtifactVersionListResponse>>;
  readonly getArtifactContent: (
    options: GetArtifactContentOptions,
  ) => Promise<ApiResult<ArtifactContentResponse>>;
  readonly importArtifactVersion: (
    options: ImportArtifactVersionOptions,
  ) => Promise<ApiResult<ArtifactVersionResponse>>;
  readonly extractArtifactVersion: (
    options: ExtractArtifactVersionOptions,
  ) => Promise<ApiResult<ArtifactExtractionResponse>>;
  readonly readArtifactProbe: (
    options: ReadArtifactProbeOptions,
  ) => Promise<ApiResult<ArtifactProbeResponse>>;
  readonly listArtifactComments: (
    options: ListArtifactCommentsOptions,
  ) => Promise<ApiResult<ArtifactCommentListResponse>>;
  readonly listArtifactCommentsAcrossVersions: (
    options: ListArtifactCommentsAcrossVersionsOptions,
  ) => Promise<ApiResult<ArtifactCommentListResponse>>;
  readonly createArtifactComment: (
    options: CreateArtifactCommentOptions,
  ) => Promise<ApiResult<ArtifactCommentResponse>>;
  readonly updateArtifactComment: (
    options: UpdateArtifactCommentOptions,
  ) => Promise<ApiResult<ArtifactCommentResponse>>;
  readonly updateArtifact: (
    options: UpdateArtifactOptions,
  ) => Promise<ApiResult<ArtifactPinResponse>>;
  /** Opens (or returns) the artifact's shared draft; the same call from two people gives the same draft. */
  readonly openArtifactDraft: (options: {
    readonly organizationId: string;
    readonly artifactId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<DraftResponse>>;
  /** Reads a draft as it stands: its current checkpoint, text digest and whether this person may publish. */
  readonly getDraft: (options: {
    readonly organizationId: string;
    readonly draftId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<DraftResponse>>;
  /**
   * Publishes one draft checkpoint as the next version. Natural idempotency:
   * the same checkpoint gives the same version, never a second one.
   */
  readonly publishDraft: (options: {
    readonly organizationId: string;
    readonly draftId: string;
    readonly input: DraftPublicationCreate;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<DraftPublicationResponse>>;
  /** The publication of one checkpoint, if it happened (404 when it did not). */
  readonly getDraftPublication: (options: {
    readonly organizationId: string;
    readonly draftId: string;
    readonly checkpointId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<DraftPublicationResponse>>;
  /** One page of a draft's suggestions, optionally only those in one state. */
  readonly listDraftSuggestions: (options: {
    readonly organizationId: string;
    readonly draftId: string;
    readonly state?: "waiting" | "accepted" | "rejected" | "no_longer_fits";
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<DraftSuggestionPageResponse>>;
  /** Accepts one suggestion: the server applies it to the draft as this person's edit. */
  readonly acceptDraftSuggestion: (options: {
    readonly organizationId: string;
    readonly draftId: string;
    readonly suggestionId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<DraftSuggestionResponse>>;
  /** Rejects one suggestion: it leaves the list and the draft does not change. */
  readonly rejectDraftSuggestion: (options: {
    readonly organizationId: string;
    readonly draftId: string;
    readonly suggestionId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<DraftSuggestionResponse>>;
  /** The collaboration socket for one organization (`/v1/collaboration`). */
  readonly collaborationSocketUrl: (organizationId: string) => string;
  readonly createMessage: (
    options: CreateMessageOptions,
  ) => Promise<ApiResult<MessageResponse>>;
  /** The people a writer may mention here, by name or email, ten at a time. */
  readonly listMentionCandidates: (options: {
    readonly organizationId: string;
    readonly source: MentionSource;
    readonly query?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MentionCandidatePage>>;
  /** The people a conversation was opened to by a mention. */
  readonly listConversationAccess: (options: {
    readonly organizationId: string;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ConversationAccessPage>>;
  /** Takes one person's mention access back. `version` is the grant's own, sent as If-Match. */
  readonly revokeConversationAccess: (options: {
    readonly organizationId: string;
    readonly conversationId: string;
    readonly principalId: string;
    readonly version: number;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ConversationAccessGrant>>;
  readonly listMessages: (options: {
    readonly organizationId: string;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<MessageListResponse>>;
  readonly listConversationTurns: (options: {
    readonly organizationId: string;
    readonly conversationId: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ConversationTurnListResponse>>;
  readonly cancelConversationTurn: (options: {
    readonly organizationId: string;
    readonly turnId: string;
    /** Turn version the cancel is bound to (`If-Match`). */
    readonly version: number;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ConversationTurnResponse>>;
  readonly listPlanRevisions: (options: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<PlanRevisionListResponse>>;
  readonly listApprovals: (options: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ApprovalListResponse>>;
  readonly decideApproval: (options: {
    readonly organizationId: string;
    readonly approvalId: string;
    readonly input: ApprovalDecision;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ApprovalResponse>>;
  readonly listConversationParticipants: (options: {
    readonly organizationId: string;
    readonly conversationId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ConversationParticipantListResponse>>;
  readonly listCoordinationPlans: (options: {
    readonly organizationId: string;
    readonly parentTaskId: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<CoordinationPlanListResponse>>;
  readonly cancelCoordinationPlan: (options: {
    readonly organizationId: string;
    readonly planId: string;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<CoordinationPlanResponse>>;
  readonly listTaskRepositories: (options: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<TaskRepositoryListResponse>>;
  readonly listApplicationRepositoryRoles: (options: {
    readonly organizationId: string;
    readonly applicationId: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<ApplicationRepositoryRoleListResponse>>;
  readonly listQuestions: (options: {
    readonly organizationId: string;
    readonly taskId: string;
    readonly status?:
      | "open"
      | "answered"
      | "expired"
      | "withdrawn"
      | "superseded";
    readonly limit?: number;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<QuestionListResponse>>;
  readonly answerQuestion: (options: {
    readonly organizationId: string;
    readonly questionId: string;
    readonly input: QuestionAnswer;
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }) => Promise<ApiResult<QuestionResponse>>;
};

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_PROBLEM_FIELD_LENGTH;
}

/**
 * Projects a validated Problem onto the display-safe field set. Any missing or
 * oversized field fails closed so a partial response can never render as
 * trusted problem copy.
 */
function safeProblem(problem: ApiProblem): SafeProblem | null {
  if (
    !boundedString(problem.type) || !boundedString(problem.title) ||
    !boundedString(problem.code) || !boundedString(problem.detail) ||
    !boundedString(problem.requestId) || !boundedString(problem.traceId) ||
    typeof problem.retryable !== "boolean" ||
    !Number.isInteger(problem.status) ||
    problem.status < 400 || problem.status > 599
  ) return null;
  return {
    type: problem.type,
    title: problem.title,
    status: problem.status,
    code: problem.code,
    retryable: problem.retryable,
    detail: problem.detail,
    requestId: problem.requestId,
    traceId: problem.traceId,
    ...(problem.resetRequired === true &&
        problem.retryWithoutAfter === true &&
        typeof problem.retainedFrom === "string"
      ? {
        resetRequired: true,
        retainedFrom: problem.retainedFrom,
        retryWithoutAfter: true,
      }
      : {}),
    ...((problem.code === "STATE_CONFLICT" ||
        problem.code === "PRECONDITION_FAILED") &&
        typeof problem.reason === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/.test(problem.reason)
      ? { reason: problem.reason }
      : {}),
    ...(problem.issueCodes ? { issueCodes: problem.issueCodes } : {}),
    ...(problem.issues ? { issues: problem.issues } : {}),
  };
}

/**
 * Projects a thrown client error onto the display-safe failure surface. Kept
 * public so fixtures and route boundaries cannot invent a second projection.
 */
export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiProblemError) {
    const problem = safeProblem(error.problem);
    if (problem) return { kind: "problem", problem };
    return { kind: "invalid-response", status: error.problem.status };
  }
  if (error instanceof ApiTransportError) {
    if (error.kind === "protocol") {
      return { kind: "invalid-response", status: error.status ?? 0 };
    }
    return { kind: "network" };
  }
  return { kind: "network" };
}

export type AuthProblemCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "AUTH_EXPIRED"
  | "AUTH_FACTOR_REQUIRED"
  | "AUTH_FORBIDDEN";

const AUTH_PROBLEM_CODE_LOOKUP: Readonly<Record<AuthProblemCode, true>> = {
  AUTH_REQUIRED: true,
  AUTH_INVALID: true,
  AUTH_EXPIRED: true,
  AUTH_FACTOR_REQUIRED: true,
  AUTH_FORBIDDEN: true,
};

/**
 * Signals a session-derived `AUTH_*` Problem detected by a route guard before
 * any request was made (for example a cached session snapshot going stale).
 * `authProblemCode` recognises it exactly like a thrown `ApiProblemError` or a
 * projected `ApiFailure`, so every consumer needs only one mapping.
 */
export class RouteAuthProblem extends Error {
  override readonly name = "RouteAuthProblem";
  readonly code: AuthProblemCode;

  constructor(code: AuthProblemCode) {
    super(`Route requires session: ${code}`);
    this.code = code;
  }
}

function problemCodeOf(failure: unknown): string | null {
  if (failure instanceof ApiProblemError) return failure.problem.code;
  if (!failure || typeof failure !== "object") return null;
  if (!("kind" in failure) || failure.kind !== "problem") return null;
  if (!("problem" in failure)) return null;
  const problem: unknown = failure.problem;
  if (!problem || typeof problem !== "object" || !("code" in problem)) {
    return null;
  }
  const { code } = problem as { code: unknown };
  return typeof code === "string" ? code : null;
}

/**
 * Recognises a typed `AUTH_*` Problem across client boundaries: a thrown
 * `ApiProblemError`, a `RouteAuthProblem` synthesised by a route guard, or an
 * already-projected `ApiFailure`. Returns `null` for every other failure so a
 * transport or validation error never masquerades as a session state.
 */
export function authProblemCode(failure: unknown): AuthProblemCode | null {
  if (failure instanceof RouteAuthProblem) return failure.code;
  const code = problemCodeOf(failure);
  return code !== null && Object.hasOwn(AUTH_PROBLEM_CODE_LOOKUP, code)
    ? (code as AuthProblemCode)
    : null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `invalid-response` status meaning the body crossed the caller's `maxBytes`. */
export const ARTIFACT_CONTENT_OVER_LIMIT_STATUS = 413;

/**
 * Reads a body without ever holding more than `maxBytes` plus one chunk: the
 * stream is cancelled as soon as the running total crosses the bound.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number | undefined,
): Promise<ArrayBuffer> {
  if (maxBytes === undefined || response.body === null) {
    return await response.arrayBuffer();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiTransportError(
        "protocol",
        ARTIFACT_CONTENT_OVER_LIMIT_STATUS,
      );
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function contentDigestOf(response: Response): string {
  const digest = /^"([0-9a-f]{64})"$/.exec(
    response.headers.get("etag") ?? "",
  )?.[1];
  if (!digest) {
    throw new ApiTransportError("protocol", response.status);
  }
  return digest;
}

function contentLengthOf(response: Response): number {
  const header = response.headers.get("content-length");
  if (
    header === null || !/^(?:0|[1-9]\d*)$/.test(header)
  ) {
    throw new ApiTransportError("protocol", response.status);
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new ApiTransportError("protocol", response.status);
  }
  return length;
}

function assertExpectedDigest(
  expectedSha256: string | undefined,
  contentDigest: string,
  status: number,
): void {
  if (
    expectedSha256 !== undefined &&
    (!SHA256_HEX.test(expectedSha256.toLowerCase()) ||
      expectedSha256.toLowerCase() !== contentDigest)
  ) {
    throw new ApiTransportError("protocol", status);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function throwArtifactResponseError(response: Response): Promise<never> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiTransportError("protocol", response.status);
  }
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
  ) {
    throw new ApiTransportError("protocol", response.status);
  }
  throw new ApiProblemError(value as ApiProblem);
}

/** The problem a refused response carries, as the error a caller can classify. */
async function problemOf(response: Response): Promise<unknown> {
  try {
    await throwArtifactResponseError(response);
  } catch (error) {
    return error;
  }
  return new ApiTransportError("protocol", response.status);
}

async function getArtifactContentResponse(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: GetArtifactContentOptions,
): Promise<ArtifactContentResponse> {
  const headers = new Headers({
    Accept: "application/octet-stream",
    "Bakery-Organization-Id": options.organizationId,
  });
  if (options.range !== undefined) headers.set("Range", options.range);
  if (options.ifRange !== undefined) headers.set("If-Range", options.ifRange);
  if (options.ifNoneMatch !== undefined) {
    headers.set("If-None-Match", options.ifNoneMatch);
  }

  const response = await fetchImpl(
    `${baseUrl.replace(/\/$/, "")}/v1/artifact-versions/${
      encodeURIComponent(options.versionId)
    }/content`,
    {
      method: "GET",
      credentials: "include",
      headers,
      signal: options.signal,
    },
  );
  const status = response.status;
  if (status !== 200 && status !== 206 && status !== 304 && status !== 416) {
    return await throwArtifactResponseError(response);
  }

  const contentType = response.headers.get("content-type")?.trim();
  if (!contentType) {
    throw new ApiTransportError("protocol", status);
  }
  const contentDigest = contentDigestOf(response);
  assertExpectedDigest(options.expectedSha256, contentDigest, status);
  const contentDisposition =
    response.headers.get("content-disposition")?.trim() || null;
  const contentRange = response.headers.get("content-range")?.trim() ?? null;

  if (status === 304) {
    const contentLengthHeader = response.headers.get("content-length");
    if (
      contentLengthHeader !== null &&
      (!/^(?:0|[1-9]\d*)$/.test(contentLengthHeader) ||
        !Number.isSafeInteger(Number(contentLengthHeader)))
    ) {
      throw new ApiTransportError("protocol", status);
    }
    if (contentRange !== null) {
      throw new ApiTransportError("protocol", status);
    }
    let body: ArrayBuffer;
    try {
      body = await response.arrayBuffer();
    } catch {
      throw new ApiTransportError("protocol", status);
    }
    if (body.byteLength !== 0) {
      throw new ApiTransportError("protocol", status);
    }
    return {
      status: 304,
      contentType,
      contentLength: 0,
      contentDigest,
      content: null,
      contentDisposition,
    };
  }

  const contentLength = contentLengthOf(response);
  if (options.maxBytes !== undefined && contentLength > options.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiTransportError(
      "protocol",
      ARTIFACT_CONTENT_OVER_LIMIT_STATUS,
    );
  }
  if (status === 200 && contentRange !== null) {
    throw new ApiTransportError("protocol", status);
  }
  if (status === 206) {
    const range = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(
      contentRange ?? "",
    );
    if (!range) throw new ApiTransportError("protocol", status);
    const start = Number(range[1]);
    const end = Number(range[2]);
    const total = Number(range[3]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) ||
      start > end ||
      end >= total ||
      end - start + 1 !== contentLength
    ) {
      throw new ApiTransportError("protocol", status);
    }
  }
  if (status === 416) {
    if (
      !/^bytes \*\/(?:0|[1-9]\d*)$/.test(contentRange ?? "") ||
      contentLength !== 0
    ) {
      throw new ApiTransportError("protocol", status);
    }
  }

  let body: ArrayBuffer;
  try {
    body = await readBoundedBody(response, options.maxBytes);
  } catch (error) {
    if (
      error instanceof ApiTransportError &&
      error.status === ARTIFACT_CONTENT_OVER_LIMIT_STATUS
    ) throw error;
    throw new ApiTransportError("protocol", status);
  }
  const content = new Uint8Array(body);
  if (content.byteLength !== contentLength) {
    throw new ApiTransportError("protocol", status);
  }
  if (status === 200 && await sha256Hex(content) !== contentDigest) {
    // Named, not generic: the file is not the file the record describes, and the
    // screen has a state for exactly that (#437).
    throw new ApiTransportError("digest-mismatch", status);
  }

  if (status === 206) {
    return {
      status: 206,
      contentType,
      contentLength,
      contentDigest,
      content,
      contentRange: contentRange as string,
      contentDisposition,
    };
  }
  if (status === 416) {
    return {
      status: 416,
      contentType,
      contentLength: 0,
      contentDigest,
      content,
      contentRange: contentRange as string,
      contentDisposition,
    };
  }
  return {
    status: 200,
    contentType,
    contentLength,
    contentDigest,
    content,
    contentDisposition,
  };
}

export function createBakeryApiClient({
  baseUrl = "",
  fetchImpl = globalThis.fetch,
}: {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
} = {}): BakeryApiClient {
  let organizationId: string | undefined;
  const client = createBakeryClient({
    baseUrl,
    fetch: fetchImpl,
    getContext: () => ({ organizationId }),
  });

  /** A client bound to one organization, so concurrent calls cannot mix context. */
  const scoped = (org: string) =>
    createBakeryClient({
      baseUrl,
      fetch: fetchImpl,
      getContext: () => ({ organizationId: org }),
    });

  const failed = (error: unknown): ApiResult<never> => ({
    ok: false,
    error: toApiFailure(error),
  });

  const workerResult = async <T>(
    org: string,
    request: (scoped: BakeryClient) => Promise<T>,
  ): Promise<ApiResult<T>> => {
    organizationId = org;
    try {
      return { ok: true, data: await request(client) };
    } catch (error) {
      return failed(error);
    } finally {
      organizationId = undefined;
    }
  };

  return {
    plugins: {
      packages(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["pluginPackages.list"]({
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      versions(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["pluginVersions.list"]({
              id: options.packageId,
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      installs(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["pluginInstalls.list"]({
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      pages(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["pluginPages.list"]({
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      page(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["pluginPages.get"]({
              id: options.installId,
              pageId: options.pageId,
            }, { signal: options.signal }),
        );
      },
      install(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["pluginInstalls.create"]({
              packageId: options.packageId,
              versionId: options.versionId,
              scope: options.scope,
            }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      savedData(options) {
        return workerResult(
          options.organizationId,
          async (scoped): Promise<SavedDataPage> => {
            const page = await scoped.actions["pluginStateItems.list"]({
              id: options.installId,
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal });
            return {
              items: page.items.map((item) => ({
                id: item.id,
                namespace: item.namespace,
                key: item.key,
                sizeBytes: item.sizeBytes,
                updatedAt: item.updatedAt,
              })),
              nextCursor: page.nextCursor,
            };
          },
        );
      },
      update(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["pluginInstalls.update"]({
              id: options.id,
              ...options.change,
            }, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
    },
    batches: {
      list(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["batches.list"]({
              repositoryId: options.repositoryId,
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      get(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["batches.get"]({ id: options.id }, {
              signal: options.signal,
            }),
        );
      },
      create(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["batches.create"](options.input, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      control(options) {
        const name = {
          pause: "batches.pause",
          resume: "batches.resume",
          startNext: "batches.startNext",
          finish: "batches.finish",
        }[options.action] as "batches.pause";
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions[name]({ id: options.id }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      stop(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["batches.stop"]({
              id: options.id,
              cancelCurrent: options.cancelCurrent,
            }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
    },
    tickets: {
      list(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["externalTickets.list"]({
              sourceId: options.sourceId,
              state: options.state,
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      get(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["externalTickets.get"]({ id: options.id }, {
              signal: options.signal,
            }),
        );
      },
      check(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketReadiness.create"]({
              id: options.id,
              expectedSourcePolicyRevision:
                options.expectedSourcePolicyRevision,
            }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      request(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketRequests.create"]({
              id: options.id,
              intent: options.intent,
              expectedSourcePolicyRevision:
                options.expectedSourcePolicyRevision,
              requirementsDigest: options.requirementsDigest,
            }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      sources(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketSources.list"]({
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      createSource(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketSources.create"](options.input, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      source(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketSources.get"]({ id: options.id }, {
              signal: options.signal,
            }),
        );
      },
      preview(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketSources.preview"]({ id: options.sourceId }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      lookupPerson(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketSources.lookupPerson"]({
              id: options.sourceId,
              login: options.login,
            }, { signal: options.signal }),
        );
      },
      updateSource(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketSources.update"]({
              id: options.id,
              ...options.input,
            }, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      sync(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketSources.sync"]({ id: options.sourceId }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      links(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketTaskLinks.list"]({
              ...(options.externalTicketId === undefined
                ? {}
                : { externalTicketId: options.externalTicketId }),
              ...(options.taskId === undefined
                ? {}
                : { taskId: options.taskId }),
              ...(options.cursor === undefined
                ? {}
                : { cursor: options.cursor }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            }, { signal: options.signal }),
        );
      },
      requests(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketRequests.list"]({
              externalTicketId: options.externalTicketId,
              ...(options.cursor === undefined
                ? {}
                : { cursor: options.cursor }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            }, { signal: options.signal }),
        );
      },
      labels(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketSources.labels"]({
              id: options.sourceId,
              ...(options.cursor === undefined
                ? {}
                : { cursor: options.cursor }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            }, { signal: options.signal }),
        );
      },
      resyncNote(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketTaskLinks.resyncNote"](
              { id: options.linkId },
              {
                ifMatch: versionEtag(options.version),
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
        );
      },
      routingRules(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketRoutingRules.get"]({ id: options.sourceId }, {
              signal: options.signal,
            }),
        );
      },
      replaceRoutingRules(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["ticketRoutingRules.replace"]({
              id: options.sourceId,
              ...options.input,
            }, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
    },
    workers: {
      list(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workers.list"]({
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      get(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workers.get"]({ id: options.id }, {
              signal: options.signal,
            }),
        );
      },
      enroll(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workers.enroll"](options.input, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      repairEnrollment(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workers.repairEnrollment"]({ id: options.id }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      update(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workers.update"](
              { id: options.id, ...options.input },
              {
                ifMatch: options.version === undefined
                  ? undefined
                  : versionEtag(options.version),
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
        );
      },
      revoke(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workers.revoke"]({ id: options.id }, {
              ifMatch: options.version === undefined
                ? undefined
                : versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
    },
    machines: {
      dispatchBlockers(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["machines.dispatchBlockers"]({ id: options.id }, {
              signal: options.signal,
            }),
        );
      },
    },
    workerEnrollments: {
      list(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerEnrollments.list"]({
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      get(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerEnrollments.get"]({ id: options.id }, {
              signal: options.signal,
            }),
        );
      },
      cancel(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerEnrollments.cancel"]({ id: options.id }, {
              ifMatch: options.version === undefined
                ? undefined
                : versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      replace(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerEnrollments.replace"]({ id: options.id }, {
              ifMatch: options.version === undefined
                ? undefined
                : versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
    },
    workerComponents: {
      list(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerComponents.list"]({
              id: options.id,
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
    },
    workerProviderBindings: {
      list(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerProviderBindings.list"]({
              id: options.id,
              cursor: options.cursor,
              limit: options.limit,
            }, { signal: options.signal }),
        );
      },
      create(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerProviderBindings.create"]({
              id: options.workerId,
              ...options.input,
            }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
    },
    workerProviderAuth: {
      create(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerProviderAuth.create"]({
              id: options.workerId,
              bindingId: options.bindingId,
            }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
      get(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerProviderAuth.get"]({
              id: options.workerId,
              bindingId: options.bindingId,
              authAttemptId: options.authAttemptId,
            }, { signal: options.signal }),
        );
      },
      cancel(options) {
        return workerResult(
          options.organizationId,
          (scoped) =>
            scoped.actions["workerProviderAuth.cancel"]({
              id: options.workerId,
              bindingId: options.bindingId,
              authAttemptId: options.authAttemptId,
            }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
        );
      },
    },
    output: {
      async attempts(org, taskId, jobId, cursor, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["jobAttempts.list"]({
              id: jobId,
              taskId,
              cursor,
              limit: 25,
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async list(org, input, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["output.streams.list"](input, {
              signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async read(org, streamId, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["output.streams.read"]({ streamId }, {
              signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      socketUrl(org) {
        const url = new URL(
          `${baseUrl.replace(/\/$/, "")}/v1/events`,
          globalThis.location.origin,
        );
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("organizationId", org);
        return url.href;
      },
    },
    files: {
      async roots(org, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["storageRoots.list"]({}, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async entries(org, folderId, cursor, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["storageFolderEntries.list"]({
              id: folderId,
              cursor,
              limit: 50,
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async versions(org, fileId, cursor, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["storageFileVersions.list"]({
              id: fileId,
              cursor,
              limit: 50,
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async atVersion(org, versionId, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["storageFiles.byVersion"]({
              id: versionId,
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async search(org, input, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["files.search"]({
              ...input,
              limit: 25,
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      mediaUrl(org, fileId, revision) {
        const query = new URLSearchParams({ organizationId: org });
        if (revision !== undefined) query.set("revision", String(revision));
        return `${baseUrl.replace(/\/$/, "")}/v1/storage/files/${
          encodeURIComponent(fileId)
        }/content?${query.toString()}`;
      },
      async facts(org, kind, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["files.facts"]({ kind }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async library(org, path, cursor, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["files.library"]({
              path,
              cursor,
              limit: 100,
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async content(org, fileId, revision, signal, range) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["storageFiles.content"]({
              id: fileId,
              revision,
              ...(range === undefined ? {} : { range }),
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async probe(org, fileId, revision, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["storageFiles.probe"]({
              id: fileId,
              organizationId: org,
              ...(revision === undefined ? {} : { revision }),
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async uses(org, fileId, cursor, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["storageFileUses.list"]({
              id: fileId,
              cursor,
              limit: 50,
            }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    sessions: {
      async list(org, runStepId, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["sessions.list"]({ runStepId }, {
              signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async feed(org, sessionId, cursor, signal) {
        const scoped = createBakeryClient({
          baseUrl,
          fetch: fetchImpl,
          getContext: () => ({ organizationId: org }),
        });
        try {
          return {
            ok: true,
            data: await scoped.actions["sessions.feed"](
              { id: sessionId, ...(cursor === undefined ? {} : { cursor }) },
              { signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async stream(org, sessionId, lastEventId, signal) {
        try {
          const headers = new Headers({
            Accept: "text/event-stream",
            "Bakery-Organization-Id": org,
          });
          if (lastEventId !== undefined) {
            headers.set("Last-Event-ID", lastEventId);
          }
          const response = await fetchImpl(
            baseUrl.replace(/\/$/, "") + "/v1/sessions/" +
              encodeURIComponent(sessionId) + "/feed/stream",
            { method: "GET", credentials: "include", headers, signal },
          );
          if (!response.ok) return failed(await problemOf(response));
          if (!response.body) {
            return failed(new ApiTransportError("protocol", response.status));
          }
          return { ok: true, data: response.body };
        } catch (error) {
          return failed(error);
        }
      },
    },
    async readiness(signal) {
      try {
        return { ok: true, data: await client.health.ready({ signal }) };
      } catch (error) {
        return failed(error);
      }
    },

    async identity(signal) {
      try {
        return {
          ok: true,
          data: await client.actions["identity.get"]({}, { signal }),
        };
      } catch (error) {
        return failed(error);
      }
    },

    async installationStatus(signal) {
      try {
        return {
          ok: true,
          data: await client.actions["installation.status"]({}, { signal }),
        };
      } catch (error) {
        return failed(error);
      }
    },

    async listOrganizations(cursor, signal) {
      try {
        return {
          ok: true,
          data: await client.actions["organizations.list"](
            cursor === undefined ? {} : { cursor },
            { signal },
          ),
        };
      } catch (error) {
        return failed(error);
      }
    },

    invitations: {
      async preview(invitationId, signal) {
        try {
          return {
            ok: true,
            data: await client.actions[
              "organizationInvitations.preview"
            ]({ invitationId }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },

      async recipientGet(id, signal) {
        try {
          return {
            ok: true,
            data: await client.actions[
              "organizationInvitations.recipientGet"
            ]({ id }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },

      async recipientAccept(invitationId, signal) {
        try {
          return {
            ok: true,
            data: await client.actions[
              "organizationInvitations.recipientAccept"
            ]({ invitationId }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },

      async recipientReject(invitationId, signal) {
        try {
          return {
            ok: true,
            data: await client.actions[
              "organizationInvitations.recipientReject"
            ]({ invitationId }, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    profile: {
      async get(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["profile.get"]({}, { signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },

      async update(options) {
        try {
          return {
            ok: true,
            data: await client.actions["profile.update"](options.input, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    auditEvents: {
      async list(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["auditEvents.list"](options.query, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async export(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["auditEvents.export"](options.query, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
    },

    auditRetention: {
      async get(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["auditRetention.get"]({}, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async update(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["auditRetention.update"](
              options.input,
              {
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
    },

    organizationRoles: {
      async list(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["organizationRoles.list"](
              { limit: 100 },
              { signal: options.signal },
            ),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async create(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["organizationRoles.create"](
              options.input,
              { idempotencyKey: options.idempotencyKey },
            ),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async update(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["organizationRoles.update"]({
              id: options.id,
              ...options.input,
            }, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
            }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async delete(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["organizationRoles.delete"]({
              id: options.id,
            }, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
            }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async assign(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["organizationRoles.assign"]({
              id: options.id,
              principalId: options.principalId,
            }, { idempotencyKey: options.idempotencyKey }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async unassign(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["organizationRoles.unassign"]({
              id: options.id,
              principalId: options.principalId,
            }, { idempotencyKey: options.idempotencyKey }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
    },

    principals: {
      async list(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["principals.list"](
              {
                limit: 100,
                ...(options.cursor === undefined
                  ? {}
                  : { cursor: options.cursor }),
              },
              { signal: options.signal },
            ),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
    },

    scimConnection: {
      async get(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["scimConnection.get"]({}, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async create(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["scimConnection.create"](
              options.input,
              { signal: options.signal },
            ),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async rotate(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["scimConnection.rotate"](
              options.input,
              { signal: options.signal },
            ),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
      async revoke(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["scimConnection.revoke"]({}, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
    },

    installationAuditEvents: {
      async list(options) {
        try {
          return {
            ok: true,
            data: await client.actions["installationAuditEvents.list"](
              options.query,
              { signal: options.signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    userPreferences: {
      async get(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["userPreferences.get"]({}, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },

      async update(options) {
        organizationId = options.organizationId;
        try {
          return {
            ok: true,
            data: await client.actions["userPreferences.update"](
              options.input,
              {
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
    },

    organizations: {
      async get(options) {
        organizationId = options.organizationId;
        try {
          const data = await client.actions["organizations.get"](
            { id: options.organizationId },
            { signal: options.signal },
          );
          if (data.id !== options.organizationId) {
            throw new ApiTransportError("protocol", 200);
          }
          return { ok: true, data };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },

      async effectiveAccess(options) {
        organizationId = options.organizationId;
        try {
          const data = await client.actions["organizations.effectiveAccess"](
            { id: options.organizationId },
            { signal: options.signal },
          );
          if (data.organizationId !== options.organizationId) {
            throw new ApiTransportError("protocol", 200);
          }
          return { ok: true, data };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },

      async update(options) {
        organizationId = options.organizationId;
        try {
          const data = await client.actions["organizations.update"](
            { id: options.organizationId, ...options.input },
            {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            },
          );
          if (data.id !== options.organizationId) {
            throw new ApiTransportError("protocol", 200);
          }
          return { ok: true, data };
        } catch (error) {
          return failed(error);
        } finally {
          organizationId = undefined;
        }
      },
    },

    installationCapabilities: {
      async get(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["installation.capabilities"]({}, {
              signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    telemetryDestinations: {
      async list(query, signal) {
        try {
          return {
            ok: true,
            data: await client.actions["telemetryDestinations.list"](
              query ?? {},
              { signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async get(id, signal) {
        try {
          return {
            ok: true,
            data: await client.actions["telemetryDestinations.get"](
              { id },
              { signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async create(options) {
        try {
          return {
            ok: true,
            data: await client.actions["telemetryDestinations.create"](
              options.input,
              {
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async update(options) {
        try {
          return {
            ok: true,
            data: await client.actions["telemetryDestinations.update"](
              { id: options.id, ...options.input },
              {
                ifMatch: versionEtag(options.version),
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async remove(options) {
        try {
          await client.actions["telemetryDestinations.delete"](
            { id: options.id },
            {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            },
          );
          return { ok: true, data: undefined };
        } catch (error) {
          return failed(error);
        }
      },
      async test(options) {
        try {
          return {
            ok: true,
            data: await client.actions["telemetryDestinations.test"](
              options.input,
              {
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    storageSettings: {
      async get(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "storageSettings.get"
            ]({}, { signal: options.signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async put(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "storageSettings.put"
            ](options.input, {
              // The first save has no version yet and refuses an If-Match.
              ...(options.version === 0
                ? {}
                : { ifMatch: versionEtag(options.version) }),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    usage: {
      async list(options) {
        try {
          return {
            ok: true,
            data: await client.actions["usage.list"](options.query, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    metrics: {
      async get(options) {
        try {
          return {
            ok: true,
            // Bound to the caller's organization: the shared client's context
            // is set and cleared by other calls and may be empty here.
            data: await scoped(options.organizationId).actions["metrics.get"](
              options.query,
              { signal: options.signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async sources(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "metrics.sources"
            ](options.query, { signal: options.signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    installationSettings: {
      async get(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["installationSettings.get"]({}, {
              signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async update(options) {
        try {
          return {
            ok: true,
            data: await client.actions["installationSettings.update"](
              options.input,
              {
                ifMatch: versionEtag(options.version),
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    integrationAppRegistrations: {
      async get(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationAppRegistrations.get"]({}, {
              signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async begin(options) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationAppRegistrations.begin"](
              options.input,
              { signal: options.signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async put(options) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationAppRegistrations.put"](
              options.input,
              {
                ...(options.version === undefined
                  ? {}
                  : { ifMatch: versionEtag(options.version) }),
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    integrationSlackApp: {
      async get(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationSlackApp.get"]({}, {
              signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async put(options) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationSlackApp.put"](
              options.input,
              {
                ...(options.version === undefined
                  ? {}
                  : { ifMatch: versionEtag(options.version) }),
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async check(options) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationSlackApp.check"]({}, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async remove(options) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationSlackApp.delete"]({}, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    integrationClientCredentials: {
      async get(options) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationClientCredentials.get"]({
              provider: options.provider,
            }, { signal: options.signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async put(options) {
        try {
          return {
            ok: true,
            data: await client.actions["integrationClientCredentials.put"](
              { provider: options.provider, ...options.input },
              {
                ...(options.version === undefined
                  ? {}
                  : { ifMatch: versionEtag(options.version) }),
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    skillStorage: {
      async get(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["skillStorageSettings.get"]({}, {
              signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async put(options) {
        try {
          return {
            ok: true,
            data: await client.actions["skillStorageSettings.put"](
              options.input,
              {
                ...(options.version === undefined
                  ? {}
                  : { ifMatch: versionEtag(options.version) }),
                idempotencyKey: options.idempotencyKey,
                signal: options.signal,
              },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async verify(options) {
        try {
          return {
            ok: true,
            data: await client.actions["skillStorageSettings.verify"]({}, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    integrationConnections: {
      async get(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "integrationConnections.get"
            ]({ id: options.id }, { signal: options.signal }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async list(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "integrationConnections.list"
            ](options.cursor === undefined ? {} : { cursor: options.cursor }, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async update(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "integrationConnections.update"
            ]({ id: options.id, ...options.input }, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async check(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "integrationConnections.check"
            ]({ id: options.id }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    integrationResources: {
      async list(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "integrationResources.list"
            ]({ id: options.connectionId, ...options.query }, {
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
      async update(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "integrationResources.update"
            ]({
              id: options.connectionId,
              resourceId: options.resourceId,
              ...options.input,
            }, {
              ifMatch: versionEtag(options.version),
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    integrationAuthAttempts: {
      async create(options) {
        try {
          return {
            ok: true,
            data: await scoped(options.organizationId).actions[
              "integrationAuthAttempts.create"
            ]({
              provider: "github",
              ...(options.reconnectConnectionId === undefined
                ? {}
                : { reconnectConnectionId: options.reconnectConnectionId }),
              ...(options.returnPath === undefined
                ? {}
                : { returnPath: options.returnPath }),
            }, {
              idempotencyKey: options.idempotencyKey,
              signal: options.signal,
            }),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    browserSessions: {
      async list(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["browserSessions.list"](
              {},
              { signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },

      async revoke(id, signal) {
        try {
          return {
            ok: true,
            data: await client.actions["browserSessions.revoke"](
              { id },
              { signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },

      async revokeOthers(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["browserSessions.revokeOthers"](
              {},
              { signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    access: createAccessAdminClient({
      baseUrl,
      fetchImpl,
      versionEtag,
      failed,
    }),

    connectedClients: {
      async list(signal) {
        try {
          return {
            ok: true,
            data: await client.actions["connectedClients.list"](
              {},
              { signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },

      async revoke(id, signal) {
        try {
          return {
            ok: true,
            data: await client.actions["connectedClients.revoke"](
              { id },
              { signal },
            ),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },

    auth: createAuthProviderClient({ baseUrl, fetch: fetchImpl }),

    async listArtifacts(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifacts.list"](
          {
            ...(options.repositoryId === undefined
              ? {}
              : { repositoryId: options.repositoryId }),
            ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
            ...(options.artifactType === undefined
              ? {}
              : { artifactType: options.artifactType }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getArtifactStorage(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifactStorage.get"]({}, {
          signal: options.signal,
        });
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getArtifactPreviewAvailability(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifactPreviews.availability"]({}, {
          signal: options.signal,
        });
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createArtifactPreview(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifactPreviews.create"](
          { id: options.versionId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async revokeArtifactPreview(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifactPreviews.revoke"](
          { id: options.grantId },
          {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getArtifact(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifacts.get"](
          { id: options.id },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listArtifactVersions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifactVersions.list"](
          {
            id: options.artifactId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getArtifactContent(options) {
      organizationId = options.organizationId;
      try {
        return {
          ok: true,
          data: await getArtifactContentResponse(fetchImpl, baseUrl, options),
        };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async importArtifactVersion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifactVersions.import"](
          { id: options.artifactId, ...options.input },
          {
            ifMatch: options.ifMatch,
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async extractArtifactVersion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifactVersions.extract"](
          {
            id: options.versionId,
            ...(options.startByte === undefined
              ? {}
              : { startByte: options.startByte }),
            ...(options.maxBytes === undefined
              ? {}
              : { maxBytes: options.maxBytes }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    /**
     * What the probe learned about this version's bytes, or nulls.
     *
     * Separate from the content read on purpose: the answer is small, it needs
     * no bytes, and a caller wants it before deciding whether to fetch any.
     */
    async readArtifactProbe(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["artifactVersions.probe"](
          { id: options.versionId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listArtifactComments(options) {
      const { organizationId: scopeId, versionId, signal, ...input } = options;
      organizationId = scopeId;
      try {
        const data = await client.actions["artifactComments.list"](
          { id: versionId, ...input },
          { signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listArtifactCommentsAcrossVersions(options) {
      const { organizationId: scopeId, artifactId, signal, ...input } = options;
      organizationId = scopeId;
      try {
        const data = await client.actions
          ["artifactComments.listAcrossVersions"](
            { id: artifactId, ...input },
            { signal },
          );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createArtifactComment(options) {
      organizationId = options.organizationId;
      try {
        if (!options.idempotencyKey) {
          throw new ApiTransportError("protocol");
        }
        const data = await client.actions["artifactComments.create"](
          { id: options.versionId, ...options.input },
          {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateArtifactComment(options) {
      organizationId = options.organizationId;
      try {
        if (!options.idempotencyKey || !options.ifMatch) {
          throw new ApiTransportError("protocol");
        }
        const data = await client.actions["artifactComments.update"](
          { id: options.id, ...options.input },
          {
            idempotencyKey: options.idempotencyKey,
            ifMatch: options.ifMatch,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateArtifact(options) {
      organizationId = options.organizationId;
      try {
        if (!options.idempotencyKey || !options.ifMatch) {
          throw new ApiTransportError("protocol");
        }
        const data = await client.actions["artifacts.update"](
          { id: options.id, ...options.input },
          {
            idempotencyKey: options.idempotencyKey,
            ifMatch: options.ifMatch,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async openArtifactDraft(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["drafts.open"](
          { id: options.artifactId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getDraft(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["drafts.get"](
          { id: options.draftId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async publishDraft(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["draftPublications.create"](
          { id: options.draftId, ...options.input },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getDraftPublication(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["draftPublications.get"](
          { id: options.draftId, checkpointId: options.checkpointId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listDraftSuggestions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["draftSuggestions.list"](
          {
            id: options.draftId,
            ...(options.state ? { state: options.state } : {}),
            ...(options.limit ? { limit: options.limit } : {}),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async acceptDraftSuggestion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["draftSuggestions.accept"](
          { id: options.draftId, suggestionId: options.suggestionId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async rejectDraftSuggestion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["draftSuggestions.reject"](
          { id: options.draftId, suggestionId: options.suggestionId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    collaborationSocketUrl(org) {
      const url = new URL(
        `${baseUrl.replace(/\/$/, "")}/v1/collaboration`,
        globalThis.location.origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("organizationId", org);
      return url.href;
    },

    async createMessage(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["messages.create"](
          { id: options.conversationId, ...options.input },
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listMentionCandidates(options) {
      organizationId = options.organizationId;
      try {
        const query = {
          id: options.source.id,
          ...(options.query === undefined || options.query === ""
            ? {}
            : { query: options.query }),
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        };
        const data = options.source.kind === "conversation"
          ? await client.actions["conversations.mentionCandidates"](query, {
            signal: options.signal,
          })
          : await client.actions["artifactComments.mentionCandidates"](query, {
            signal: options.signal,
          });
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listConversationAccess(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["conversationAccess.list"](
          {
            id: options.conversationId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async revokeConversationAccess(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["conversationAccess.revoke"](
          { id: options.conversationId, principalId: options.principalId },
          {
            ifMatch: versionEtag(options.version),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listMessages(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["messages.list"](
          {
            id: options.conversationId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listConversationTurns(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["conversationTurns.list"](
          {
            id: options.conversationId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async cancelConversationTurn(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["conversationTurns.cancel"](
          { id: options.turnId },
          {
            idempotencyKey: options.idempotencyKey,
            ifMatch: versionEtag(options.version),
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listPlanRevisions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["planRevisions.list"](
          {
            taskId: options.taskId,
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listApprovals(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["approvals.list"](
          {
            taskId: options.taskId,
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async decideApproval(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["approvals.decide"](
          { id: options.approvalId, ...options.input },
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listConversationParticipants(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["conversationParticipants.list"](
          { id: options.conversationId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listCoordinationPlans(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["coordinationPlans.list"](
          {
            parentTaskId: options.parentTaskId,
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async cancelCoordinationPlan(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["coordinationPlans.cancel"](
          { id: options.planId },
          {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listTaskRepositories(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["taskRepositories.list"](
          { id: options.taskId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listApplicationRepositoryRoles(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["applicationRepositoryRoles.list"](
          { id: options.applicationId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listQuestions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["questions.list"](
          {
            taskId: options.taskId,
            ...(options.status === undefined ? {} : { status: options.status }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async answerQuestion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["questions.answer"](
          { id: options.questionId, ...options.input },
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listTasks(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["tasks.list"](
          {
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.status === undefined ? {} : { status: options.status }),
            ...(options.repositoryId === undefined
              ? {}
              : { repositoryId: options.repositoryId }),
            ...(options.search === undefined ? {} : { search: options.search }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getTask(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["tasks.get"]({ id: options.id }, {
          signal: options.signal,
        });
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listNotifications(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["notifications.list"](
          {
            filter: options.filter,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async notificationCount(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["notifications.count"]({}, {
          signal: options.signal,
        });
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async resolveNotificationTarget(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["notifications.resolveTarget"](
          { id: options.id },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async setNotificationRead(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["notifications.setRead"](
          {
            id: options.id,
            read: options.read,
            expectedCasVersion: options.expectedCasVersion,
          },
          {
            signal: options.signal,
            ...(options.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: options.idempotencyKey }),
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async markAllNotificationsRead(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["notifications.markAllRead"](
          { readBefore: options.readBefore },
          {
            signal: options.signal,
            ...(options.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: options.idempotencyKey }),
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRuns(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["runs.list"](
          {
            id: options.taskId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getRun(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["runs.get"](
          { id: options.runId },
          { signal: options.signal },
        );
        if (data.id !== options.runId) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRouteContinuations(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["routeContinuations.list"](
          { id: options.runId },
          { signal: options.signal },
        );
        if (data.runId !== options.runId) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async admitRouteContinuation(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["routeContinuations.admit"](
          { id: options.runId, ...options.input },
          {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.runId !== options.runId) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getRunControlCapabilities(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["runs.controlCapabilities"](
          { id: options.runId },
          { signal: options.signal },
        );
        if (data.runId !== options.runId) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listWorkflowPresets(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflowPresets.list"](
          options.repositoryId === undefined
            ? {}
            : { repositoryId: options.repositoryId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createRun(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["runs.create"](
          { id: options.taskId, ...options.input },
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        // A preset run records the version the server materialized; a pinned
        // version run must come back with exactly the version it asked for.
        if (
          options.signal?.aborted || data.taskId !== options.taskId ||
          (options.input.workflowVersionId !== undefined &&
            data.workflowVersionId !== options.input.workflowVersionId) ||
          (options.input.presetId !== undefined &&
            data.workflowVersionId === null) ||
          data.repositoryProfileId !==
            (options.input.repositoryProfileId ?? null)
        ) {
          throw new ApiTransportError("protocol", 201);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async controlRun(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["runs.control"](
          { id: options.runId, ...options.input },
          {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.id !== options.runId) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRunSteps(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["runSteps.list"](
          {
            id: options.runId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRunChecks(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["checks.list"](
          {
            id: options.runId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRunReviews(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["runReviews.list"](
          {
            id: options.runId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listReviewFindings(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["reviewFindings.list"](
          {
            id: options.reviewCycleId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRunDeliveryDecisions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["runDeliveryDecisions.list"](
          {
            id: options.runId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listPullRequests(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["pullRequests.list"](
          {
            taskId: options.taskId,
            ...(options.runId === undefined ? {} : { runId: options.runId }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listMergeAttempts(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["mergeAttempts.list"](
          {
            pullRequestId: options.pullRequestId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listMergeEntries(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["mergeEntries.list"](
          {
            pullRequestId: options.pullRequestId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createMergeEntry(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["mergeEntries.create"](
          options.input,
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async mergePullRequest(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["pullRequests.merge"](
          {
            id: options.pullRequestId,
            expectedHeadSha: options.expectedHeadSha,
            ...(options.expectedBaseSha === undefined
              ? {}
              : { expectedBaseSha: options.expectedBaseSha }),
            mergeMethod: options.mergeMethod,
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async reconcileMergeAttempts(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["mergeAttempts.reconcile"](
          { pullRequestId: options.pullRequestId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async sync(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["sync.snapshot"](
          {
            scopeType: options.scopeType,
            scopeId: options.scopeId,
            ...(options.after === undefined ? {} : { after: options.after }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createTask(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["tasks.create"](
          options.input,
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateTask(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["tasks.update"](
          { id: options.id, ...options.input },
          {
            idempotencyKey: options.idempotencyKey,
            ifMatch: versionEtag(options.version),
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listApplications(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["applications.list"](
          options.cursor === undefined && options.limit === undefined ? {} : {
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getApplication(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["applications.get"](
          { id: options.id },
          { signal: options.signal },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getWorkflow(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflows.get"](
          { id: options.id },
          { signal: options.signal },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listWorkflows(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflows.list"](
          options.cursor === undefined && options.limit === undefined ? {} : {
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listWorkflowVersions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflowVersions.list"](
          {
            id: options.workflowId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async activateWorkflowVersion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflowActivations.create"](
          { id: options.id, versionId: options.versionId },
          {
            ifMatch: versionEtag(options.version),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateWorkflow(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflows.update"](
          { id: options.id, ...options.input },
          {
            ifMatch: versionEtag(options.version),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getAgent(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["agents.get"](
          { id: options.id },
          { signal: options.signal },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async activateAgentVersion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["agents.activateVersion"](
          { id: options.id, versionId: options.versionId },
          {
            ifMatch: versionEtag(options.version),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateAgent(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["agents.update"](
          { id: options.id, ...options.input },
          {
            ifMatch: versionEtag(options.version),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createWorkflow(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflows.create"](options.input, {
          idempotencyKey: options.idempotencyKey,
          signal: options.signal,
        });
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createWorkflowVersion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflowVersions.create"](
          { id: options.workflowId, ...options.input },
          {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async publishWorkflowVersion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflowVersions.publish"](
          {
            id: options.workflowId,
            versionId: options.versionId,
            expectedDigest: options.expectedDigest,
          },
          {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateWorkflowVersion(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflowVersions.update"](
          {
            id: options.workflowId,
            versionId: options.versionId,
            ...options.input,
          },
          {
            ifMatch: versionEtag(options.version),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async validateWorkflow(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["workflows.validate"](options.input, {
          idempotencyKey: options.idempotencyKey,
          signal: options.signal,
        });
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listAgentVersions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["agentVersions.list"](
          {
            id: options.agentId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listMemories(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["memories.list"](
          options.cursor === undefined && options.limit === undefined ? {} : {
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getMemory(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["memories.get"](
          { id: options.id },
          { signal: options.signal },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listMemoryRevisions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["memoryRevisions.list"](
          {
            id: options.id,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listEvaluationBatches(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["evaluationBatches.list"](
          {
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getEvaluationBatch(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["evaluationBatches.get"](
          { id: options.id },
          { signal: options.signal },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async cancelEvaluationBatch(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["evaluationBatches.cancel"](
          { id: options.id },
          {
            ifMatch: versionEtag(options.version),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listEvaluationResults(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["evaluationBatchResults.list"](
          {
            id: options.id,
            ...(options.state === undefined ? {} : { state: options.state }),
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listEvaluationAttempts(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["evaluationAttempts.list"](
          {
            id: options.id,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateMemory(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["memories.update"](
          { id: options.id, status: options.status },
          {
            ifMatch: versionEtag(options.version),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createMemoryRevision(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["memoryRevisions.create"](
          { id: options.id, ...options.input },
          {
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.memoryId !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listAgents(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["agents.list"](
          options.cursor === undefined && options.limit === undefined ? {} : {
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createApplication(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["applications.create"](
          options.input,
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateApplication(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["applications.update"](
          { id: options.id, ...options.input },
          {
            ifMatch: options.ifMatch,
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRepositories(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositories.list"](
          options.cursor === undefined && options.limit === undefined ? {} : {
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getRepository(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositories.get"](
          { id: options.id },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createRepository(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositories.create"](
          options.input,
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateRepository(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositories.update"](
          { id: options.id, ...options.input },
          {
            ifMatch: options.ifMatch,
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },
    async startRepositoryOnboarding(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositories.onboard"](
          { id: options.repositoryId },
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        if (data.repositoryId !== options.repositoryId) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getRepositoryOnboarding(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositoryOnboardings.get"](
          { id: options.id },
          { signal: options.signal },
        );
        if (data.id !== options.id) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getRepositoryProfileObservation(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositoryObservations.get"](
          { id: options.id },
          { signal: options.signal },
        );
        const payload = RepositoryProfileObservationPayloadSchema.safeParse(
          data.payload,
        );
        if (
          data.id !== options.id || !payload.success ||
          payload.data.organizationId !== options.organizationId ||
          payload.data.repositoryId !== data.repositoryId ||
          payload.data.profileId !== data.profileId ||
          payload.data.profileRevision !== data.profileRevision ||
          payload.data.profileDigest !== data.profileDigest ||
          payload.data.source.baseSha !== data.baseSha
        ) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data: { ...data, payload: payload.data } };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRepositoryRoles(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["projects.roles.list"](
          {
            applicationId: options.applicationId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createRepositoryRole(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["projects.roles.create"](
          options.input,
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async updateRepositoryRole(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["projects.roles.update"](
          {
            applicationId: options.applicationId,
            roleId: options.roleId,
            ...options.input,
          },
          {
            ifMatch: String(options.input.expectedVersion),
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async resolveRepositoryRole(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["projects.roles.resolve"](
          { applicationId: options.applicationId, ...options.input },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listRepositoryProfiles(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositoryProfiles.list"](
          {
            id: options.repositoryId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getOrganizationRepositoryRules(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositoryRules.get"](
          { id: options.organizationId },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async previewOrganizationRepositoryRules(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions[
          "repositoryRulePreviews.createForOrganization"
        ](
          {
            id: options.organizationId,
            expectedRevision: options.expectedRevision,
            entries: options.entries,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async getRepositoryEffectiveRules(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositoryRules.getEffective"](
          { id: options.repositoryId },
          { signal: options.signal },
        );
        if (data.repositoryId !== options.repositoryId) {
          throw new ApiTransportError("protocol", 200);
        }
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async publishOrganizationRepositoryRules(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositoryRuleVersions.create"](
          {
            id: options.organizationId,
            expectedRevision: options.expectedRevision,
            entries: options.entries,
          },
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async listOrganizationRepositoryRuleVersions(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositoryRuleVersions.list"](
          {
            id: options.organizationId,
            ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          },
          { signal: options.signal },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },

    async createRepositoryProfile(options) {
      organizationId = options.organizationId;
      try {
        const data = await client.actions["repositoryProfiles.create"](
          { id: options.repositoryId, ...options.input },
          {
            ifMatch: options.ifMatch,
            idempotencyKey: options.idempotencyKey,
            signal: options.signal,
          },
        );
        return { ok: true, data };
      } catch (error) {
        return failed(error);
      } finally {
        organizationId = undefined;
      }
    },
  };
}
