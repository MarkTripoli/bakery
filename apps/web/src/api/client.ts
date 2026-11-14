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
  /** STATE_CONFLICT rule slug such as `app_mismatch`; never free text. */
  reason?: string;
  /** Stable issue codes of a 422, such as a storage probe outcome. */
  issueCodes?: readonly string[];
}>;

export type ApiFailure =
  | { readonly kind: "problem"; readonly problem: SafeProblem }
  | { readonly kind: "network" }
  | { readonly kind: "invalid-response"; readonly status: number };

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiFailure };

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
export type TaskResponse = ClientOutputMap["Task"];
export type RunListResponse = ClientOutputMap["Page<Run>"];
export type RunResponse = ClientOutputMap["Run"];
export type RunControlCapabilities = ClientOutputMap["RunControlCapabilities"];
export type RunStepListResponse = ClientOutputMap["Page<RunStep>"];
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
export type IntegrationAppRegistration =
  ClientOutputMap["IntegrationAppRegistration"];
export type IntegrationAppManifestStart =
  ClientOutputMap["IntegrationAppManifestStart"];
export type IntegrationAppRegistrationBegin =
  ClientInputMap["IntegrationAppRegistrationBegin"];
export type IntegrationAppRegistrationPut =
  ClientInputMap["IntegrationAppRegistrationPut"];
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
export type TicketSourceListResponse = ClientOutputMap["Page<TicketSource>"];
export type TicketOperationReceiptResponse =
  ClientOutputMap["TicketOperationReceipt"];
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
export type WorkerEnrollmentCreate = ClientInputMap["WorkerEnrollmentCreate"];

/**
 * The strong `If-Match` value for a stored record version: the version
 * number in a quoted `v<n>` entity tag, which the server reads back as the
 * optimistic-concurrency precondition.
 */
export function versionEtag(version: number): string {
  return `"v${version}"`;
}
export type { AccessAdminClient } from "./access-client.ts";
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

export type BakeryApiClient = {
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
    /** `GET /v1/ticket-sources`: the repositories Bakery takes issues from. */
    readonly sources: (options: {
      readonly organizationId: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketSourceListResponse>>;
    /** `POST /v1/ticket-sources/{id}/syncs`: asks Bakery to read GitHub again. Admin only. */
    readonly sync: (options: {
      readonly organizationId: string;
      readonly sourceId: string;
      readonly idempotencyKey?: string;
      readonly signal?: AbortSignal;
    }) => Promise<ApiResult<TicketOperationReceiptResponse>>;
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
  };
  readonly principals: {
    /** `GET /v1/principals`: the organization's members, service accounts and workers. */
    readonly list: (options: {
      readonly organizationId: string;
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
  readonly createMessage: (
    options: CreateMessageOptions,
  ) => Promise<ApiResult<MessageResponse>>;
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
    ...(problem.code === "STATE_CONFLICT" &&
        typeof problem.reason === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/.test(problem.reason)
      ? { reason: problem.reason }
      : {}),
    ...(problem.issueCodes ? { issueCodes: problem.issueCodes } : {}),
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
    throw new ApiTransportError("protocol", status);
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
            data: await client.actions["principals.list"]({ limit: 100 }, {
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
            ]({ provider: "github" }, {
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
          { idempotencyKey: options.idempotencyKey, signal: options.signal },
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
