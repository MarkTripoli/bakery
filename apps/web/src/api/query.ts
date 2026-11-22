import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { MembershipPage } from "./access-client.ts";
import type {
  AgentDefinitionResponse,
  AgentVersionResponse,
  ApiFailure,
  ApiResult,
  ApplicationListResponse,
  ApplicationRepositoryRoleListResponse,
  ApplicationResponse,
  ApprovalListResponse,
  ArtifactAccessGrant,
  ArtifactCommentListResponse,
  ArtifactCommentQuery,
  ArtifactCursorQuery,
  ArtifactExtractionResponse,
  ArtifactExtractQuery,
  ArtifactListResponse,
  ArtifactPreviewAvailabilityResponse,
  ArtifactQuery,
  ArtifactResponse,
  ArtifactSharers,
  ArtifactStorageResponse,
  ArtifactVersionListResponse,
  BackupDrillPage,
  BackupOffsite,
  BackupPointInTime,
  BackupRunPage,
  BackupSchedule,
  BackupStatus,
  BakeryApiClient,
  BatchListResponse,
  BatchResponse,
  BatchStartableResponse,
  BrowserSessionList,
  CheckRunListResponse,
  ConnectedClientList,
  ConversationAccessGrant,
  ConversationParticipantListResponse,
  ConversationSharers,
  ConversationTurnListResponse,
  CoordinationPlanListResponse,
  DeliveryDecisionListResponse,
  DispatchBlockersResponse,
  EffectiveAccess,
  EnrollmentStatus,
  EvaluationAttempt,
  EvaluationBatch,
  EvaluationBatchPage,
  EvaluationBatchResultPage,
  EvaluationResultState,
  ExternalTicketListResponse,
  ExternalTicketResponse,
  FileFactPage,
  FileSearchInput,
  FileSearchPage,
  InstallationCapabilities,
  InstallationRestore,
  InstallationSettings,
  InstallationStatus,
  IntegrationAppRegistration,
  IntegrationClientCredentials,
  IntegrationConnection,
  IntegrationResource,
  LibraryPage,
  MemoryEntryResponse,
  MemoryRevisionResponse,
  MentionCandidatePage,
  MentionSource,
  MergeAttemptListResponse,
  MergeEntryListResponse,
  MessageListResponse,
  MetricSeries,
  MetricSourcePage,
  MetricSourcesQuery,
  MetricsQuery,
  NotificationCountResponse,
  NotificationCursorQuery,
  NotificationListResponse,
  NotificationTargetResponse,
  OrganizationAccessPage,
  OrganizationInvitationPreview,
  OrganizationInvitationRecipient,
  OrganizationRecord,
  OrganizationRepositoryRuleEntries,
  OrganizationRepositoryRulePreviewResponse,
  OrganizationRepositoryRulesResponse,
  OrganizationRepositoryRuleVersionListResponse,
  PlanRevisionListResponse,
  PluginInstallListResponse,
  PluginPackageListResponse,
  PluginPageAccessResponse,
  PluginPageListResponse,
  PluginVersionListResponse,
  PreviewAvailabilityResponse,
  PrincipalPage,
  PullRequestListResponse,
  QuestionListResponse,
  RepositoryEffectiveRulesResponse,
  RepositoryListResponse,
  RepositoryOnboardingResponse,
  RepositoryProfileListResponse,
  RepositoryProfileObservationResponse,
  RepositoryResponse,
  ReviewCycleListResponse,
  ReviewFindingListResponse,
  RoleBindingListResponse,
  RouteContinuationOffersResponse,
  RunControlCapabilities,
  RunListResponse,
  RunPreviewResponse,
  RunResponse,
  RunStepListResponse,
  SavedDataPage,
  ScimConnection,
  SkillResponse,
  SkillStorageSettings,
  StorageFileAtVersion,
  StorageFileUsePage,
  StorageFileVersionPage,
  StorageFolderItem,
  StorageFolderPage,
  StorageSettings,
  SyncQuery,
  SyncResponse,
  TaskCursorQuery,
  TaskListResponse,
  TaskRepositoryListResponse,
  TaskResponse,
  TelemetryDestinationDetail,
  TelemetryDestinationList,
  TelemetryDestinationListQuery,
  TicketRequestViewListResponse,
  TicketRoutingRuleSetResponse,
  TicketSourceLabelListResponse,
  TicketSourceListResponse,
  TicketSourceResponse,
  TicketTaskLinkListResponse,
  UsageQuery,
  UsageSummary,
  UserPreferences,
  UserProfile,
  WorkerComponentListResponse,
  WorkerEnrollmentListResponse,
  WorkerListResponse,
  WorkerProviderAuthAttemptResponse,
  WorkerProviderBindingListResponse,
  WorkerResponse,
  WorkflowDefinitionResponse,
  WorkflowPresetListResponse,
  WorkflowVersionResponse,
  WorkflowVersionSkills,
} from "./client.ts";
import { protectedQueryKey, type ProtectedScope } from "../app/query-scope.ts";

export type ApiScope = ProtectedScope;

function retryNetworkOnce(failureCount: number, error: unknown): boolean {
  return failureCount < 1 &&
    typeof error === "object" && error !== null &&
    (error as ApiFailure).kind === "network";
}

function unwrap<T>(result: ApiResult<T>): T {
  if (result.ok) return result.data;
  throw result.error;
}
const MAX_MACHINE_COLLECTION_PAGES = 10;
function machinePollInterval(
  state: string | undefined,
  dataUpdateCount: number,
): number | false {
  if (state !== "pending" && state !== "challenge_issued") return false;
  const backoffStep = Math.min(Math.max(dataUpdateCount - 1, 0), 3);
  return Math.min(5_000 * 2 ** backoffStep, 30_000);
}

async function collectMachinePages<
  T extends {
    readonly items: readonly unknown[];
    readonly nextCursor: string | null;
  },
>(
  first: T,
  load: (cursor: string) => Promise<T>,
): Promise<T> {
  const items = [...first.items];
  let nextCursor = first.nextCursor;
  let pageCount = 1;
  while (nextCursor && pageCount < MAX_MACHINE_COLLECTION_PAGES) {
    const next = await load(nextCursor);
    items.push(...next.items);
    nextCursor = next.nextCursor;
    pageCount += 1;
  }
  return { ...first, items, nextCursor } as T;
}

/** The saved copy of the organization's GitHub issues, read a page at a time. */
export function externalTicketsPagesQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  input: Readonly<{ sourceId?: string; state?: string; limit?: number }> = {},
) {
  const limit = input.limit ?? 25;
  return infiniteQueryOptions<
    ExternalTicketListResponse,
    ApiFailure,
    { pages: ExternalTicketListResponse[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "externalTickets.list", {
      sourceId: input.sourceId ?? null,
      state: input.state ?? null,
      limit,
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.tickets.list({
          organizationId: requireOrganization(scope),
          sourceId: input.sourceId,
          state: input.state,
          cursor: pageParam ?? undefined,
          limit,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** One issue with its latest check and running request. */
export function externalTicketQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<ExternalTicketResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "externalTickets.get", { id }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.tickets.get({
          organizationId: requireOrganization(scope),
          id,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The repositories Bakery takes issues from, with how their last read went. */
export function ticketSourcesListQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
) {
  return queryOptions<TicketSourceListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "ticketSources.list", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.tickets.sources({
          organizationId: scope.organizationId,
          limit: 100,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The organization's members with the names they go by, so "started by" can name a person. */
export function organizationMembersQueryOptions(
  client: Pick<BakeryApiClient, "access">,
  scope: ApiScope,
) {
  return queryOptions<MembershipPage, ApiFailure>({
    queryKey: protectedQueryKey(scope, "organizationMemberships.list", {}),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.access.members.list({
          organizationId: requireOrganization(scope),
          limit: 100,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The work started from one issue, newest first: progress, who started it, the repositories it went to. */
export function ticketRequestsQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  externalTicketId: string,
) {
  return queryOptions<TicketRequestViewListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "ticketRequests.list", {
      externalTicketId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.tickets.requests({
          organizationId: requireOrganization(scope),
          externalTicketId,
          limit: 25,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every task linked to one issue, with how Bakery's note on the issue is doing. */
export function ticketLinksByIssueQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  externalTicketId: string,
) {
  return queryOptions<TicketTaskLinkListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "ticketTaskLinks.list", {
      externalTicketId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.tickets.links({
          organizationId: requireOrganization(scope),
          externalTicketId,
          limit: 100,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every issue one task is linked to (the task page's "From issue"). */
export function ticketLinksByTaskQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  taskId: string,
) {
  return queryOptions<TicketTaskLinkListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "ticketTaskLinks.list", { taskId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.tickets.links({
          organizationId: requireOrganization(scope),
          taskId,
          limit: 100,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The labels GitHub lists for a repository, read live (a failure is a 503, not an empty list). */
export function ticketSourceLabelsQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  sourceId: string,
) {
  return queryOptions<TicketSourceLabelListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "ticketSources.labels", { sourceId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.tickets.labels({
          organizationId: requireOrganization(scope),
          sourceId,
          limit: 100,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Which labels send an issue to which repository. */
export function ticketRoutingRulesQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  sourceId: string,
) {
  return queryOptions<TicketRoutingRuleSetResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "ticketRoutingRules.get", { sourceId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.tickets.routingRules({
          organizationId: requireOrganization(scope),
          sourceId,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every plugin published to the organization (one page of up to 100). */
export function pluginPackagesQueryOptions(
  client: Pick<BakeryApiClient, "plugins">,
  scope: ApiScope,
) {
  return queryOptions<PluginPackageListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "pluginPackages.list", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.plugins.packages({
          organizationId: scope.organizationId,
          limit: 100,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The published versions of one plugin. */
export function pluginVersionsQueryOptions(
  client: Pick<BakeryApiClient, "plugins">,
  scope: ApiScope,
  packageId: string,
) {
  return queryOptions<PluginVersionListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "pluginVersions.list", { packageId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.plugins.versions({
          organizationId: scope.organizationId,
          packageId,
          limit: 100,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The installs this person may see: their own, and the organization's. */
export function pluginInstallsQueryOptions(
  client: Pick<BakeryApiClient, "plugins">,
  scope: ApiScope,
) {
  return queryOptions<PluginInstallListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "pluginInstalls.list", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.plugins.installs({
          organizationId: scope.organizationId,
          limit: 100,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The pages the sidebar lists: every page of every plugin that is on and that this person has. */
export function pluginPagesQueryOptions(
  client: Pick<BakeryApiClient, "plugins">,
  scope: ApiScope,
) {
  return queryOptions<PluginPageListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "pluginPages.list", {}),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.plugins.pages({
          organizationId: requireOrganization(scope),
          limit: 100,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Whether one plugin page may be shown now, and the reason when it may not. */
export function pluginPageQueryOptions(
  client: Pick<BakeryApiClient, "plugins">,
  scope: ApiScope,
  installId: string,
  pageId: string,
) {
  return queryOptions<PluginPageAccessResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "pluginPages.get", {
      installId,
      pageId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.plugins.page({
          organizationId: requireOrganization(scope),
          installId,
          pageId,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && installId !== "" && pageId !== "",
    retry: retryNetworkOnce,
  });
}

/** What one plugin install has saved: the first page, newest first, without the values. */
export function pluginSavedDataQueryOptions(
  client: Pick<BakeryApiClient, "plugins">,
  scope: ApiScope,
  installId: string,
) {
  return queryOptions<SavedDataPage, ApiFailure>({
    queryKey: protectedQueryKey(scope, "pluginStateItems.list", { installId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.plugins.savedData({
          organizationId: scope.organizationId,
          installId,
          limit: SAVED_DATA_PAGE,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: false,
  });
}

/** Whether this deployment can serve running-app previews. */
export function previewAvailabilityQueryOptions(
  client: Pick<BakeryApiClient, "previews">,
  scope: ApiScope,
) {
  return queryOptions<PreviewAvailabilityResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "previews.availability", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.previews.availability({
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: false,
  });
}

/** The newest preview of a run: the only one the card ever offers. */
export function runPreviewQueryOptions(
  client: Pick<BakeryApiClient, "previews">,
  scope: ApiScope,
  runId: string,
) {
  return queryOptions<RunPreviewResponse | null, ApiFailure>({
    queryKey: protectedQueryKey(scope, "previews.list", { runId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const page = unwrap(
        await client.previews.list({
          organizationId: scope.organizationId,
          runId,
          limit: 1,
          signal,
        }),
      );
      return page.items[0] ?? null;
    },
    enabled: Boolean(scope.organizationId),
    retry: false,
  });
}

/** Saved items shown before "Show more". */
export const SAVED_DATA_PAGE = 10;

export function readinessQueryOptions(
  client: Pick<BakeryApiClient, "readiness">,
) {
  return queryOptions({
    queryKey: ["public", "health", "ready"] as const,
    queryFn: async ({ signal }) => unwrap(await client.readiness(signal)),
    retry: retryNetworkOnce,
  });
}

export function workersListQueryOptions(
  client: Pick<BakeryApiClient, "workers">,
  scope: ApiScope,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
) {
  const normalizedInput = {
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<WorkerListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "workers.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const first = unwrap(
        await client.workers.list({
          organizationId: scope.organizationId,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
      return collectMachinePages(first, async (cursor) =>
        unwrap(
          await client.workers.list({
            organizationId: scope.organizationId as string,
            cursor,
            limit: input.limit,
            signal,
          }),
        ));
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
    refetchInterval: 15_000,
  });
}

export function workerQueryOptions(
  client: Pick<BakeryApiClient, "workers">,
  scope: ApiScope,
  workerId: string,
) {
  return queryOptions<WorkerResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "workers.get", { workerId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const worker = unwrap(
        await client.workers.get({
          organizationId: scope.organizationId,
          id: workerId,
          signal,
        }),
      );
      if (signal.aborted || worker.id !== workerId) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return worker;
    },
    enabled: Boolean(scope.organizationId && workerId),
    retry: retryNetworkOnce,
    refetchInterval: 15_000,
  });
}

export function dispatchBlockersQueryOptions(
  client: Pick<BakeryApiClient, "machines">,
  scope: ApiScope,
  workerId: string,
) {
  return queryOptions<DispatchBlockersResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "machines.dispatchBlockers", {
      workerId,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.machines.dispatchBlockers({
          organizationId: scope.organizationId,
          id: workerId,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId && workerId),
    retry: retryNetworkOnce,
    refetchInterval: 15_000,
  });
}

export function workerComponentsListQueryOptions(
  client: Pick<BakeryApiClient, "workerComponents">,
  scope: ApiScope,
  workerId: string,
) {
  return queryOptions<WorkerComponentListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "workerComponents.list", { workerId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const first = unwrap(
        await client.workerComponents.list({
          organizationId: scope.organizationId,
          id: workerId,
          limit: 100,
          signal,
        }),
      );
      return collectMachinePages(first, async (cursor) =>
        unwrap(
          await client.workerComponents.list({
            organizationId: scope.organizationId as string,
            id: workerId,
            cursor,
            limit: 100,
            signal,
          }),
        ));
    },
    enabled: Boolean(scope.organizationId && workerId),
    retry: retryNetworkOnce,
    refetchInterval: 15_000,
  });
}

export function workerProviderBindingsListQueryOptions(
  client: Pick<BakeryApiClient, "workerProviderBindings">,
  scope: ApiScope,
  workerId: string,
) {
  return queryOptions<WorkerProviderBindingListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "workerProviderBindings.list", {
      workerId,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const first = unwrap(
        await client.workerProviderBindings.list({
          organizationId: scope.organizationId,
          id: workerId,
          limit: 100,
          signal,
        }),
      );
      return collectMachinePages(first, async (cursor) =>
        unwrap(
          await client.workerProviderBindings.list({
            organizationId: scope.organizationId as string,
            id: workerId,
            cursor,
            limit: 100,
            signal,
          }),
        ));
    },
    enabled: Boolean(scope.organizationId && workerId),
    retry: retryNetworkOnce,
    refetchInterval: 15_000,
  });
}

export function workerEnrollmentsListQueryOptions(
  client: Pick<BakeryApiClient, "workerEnrollments">,
  scope: ApiScope,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
) {
  const normalizedInput = {
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<WorkerEnrollmentListResponse, ApiFailure>({
    queryKey: protectedQueryKey(
      scope,
      "workerEnrollments.list",
      normalizedInput,
    ),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const first = unwrap(
        await client.workerEnrollments.list({
          organizationId: scope.organizationId,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
      return collectMachinePages(first, async (cursor) =>
        unwrap(
          await client.workerEnrollments.list({
            organizationId: scope.organizationId as string,
            cursor,
            limit: input.limit,
            signal,
          }),
        ));
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
    refetchInterval: 15_000,
  });
}

export function workerEnrollmentQueryOptions(
  client: Pick<BakeryApiClient, "workerEnrollments">,
  scope: ApiScope,
  enrollmentId: string,
) {
  return queryOptions<EnrollmentStatus, ApiFailure>({
    queryKey: protectedQueryKey(scope, "workerEnrollments.get", {
      enrollmentId,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const enrollment = unwrap(
        await client.workerEnrollments.get({
          organizationId: scope.organizationId,
          id: enrollmentId,
          signal,
        }),
      );
      if (signal.aborted || enrollment.enrollmentId !== enrollmentId) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return enrollment;
    },
    enabled: Boolean(scope.organizationId && enrollmentId),
    retry: retryNetworkOnce,
    refetchInterval: (query) =>
      machinePollInterval(
        query.state.data?.state,
        query.state.dataUpdateCount,
      ),
  });
}

export function workerProviderAuthQueryOptions(
  client: Pick<BakeryApiClient, "workerProviderAuth">,
  scope: ApiScope,
  input: Readonly<{
    workerId: string;
    bindingId: string;
    authAttemptId: string;
  }>,
) {
  return queryOptions<WorkerProviderAuthAttemptResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "workerProviderAuth.get", input),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.workerProviderAuth.get({
          organizationId: scope.organizationId,
          workerId: input.workerId,
          bindingId: input.bindingId,
          authAttemptId: input.authAttemptId,
          signal,
        }),
      );
    },
    enabled: Boolean(
      scope.organizationId && input.workerId && input.bindingId &&
        input.authAttemptId,
    ),
    retry: retryNetworkOnce,
    refetchInterval: (query) =>
      machinePollInterval(
        query.state.data?.state,
        query.state.dataUpdateCount,
      ),
  });
}

export function tasksListQueryOptions(
  client: Pick<BakeryApiClient, "listTasks">,
  scope: ApiScope,
  input: Readonly<TaskCursorQuery> = {},
) {
  const normalizedInput = {
    status: input.status ?? null,
    repositoryId: input.repositoryId ?? null,
    search: input.search ?? null,
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<TaskListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "tasks.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listTasks({
          organizationId: scope.organizationId,
          ...input,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function notificationsListQueryOptions(
  client: Pick<BakeryApiClient, "listNotifications">,
  scope: ApiScope,
  input: Readonly<NotificationCursorQuery>,
) {
  const normalizedInput = {
    filter: input.filter,
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<NotificationListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "notifications.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listNotifications({
          organizationId: scope.organizationId,
          ...input,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

/**
 * The unread count. Deliberately has no placeholder count: an unknown count is
 * `null` and the bell draws its hollow ring for it, so the badge can never
 * show a confident zero before the server has answered.
 */
export function notificationCountQueryOptions(
  client: Pick<BakeryApiClient, "notificationCount">,
  scope: ApiScope,
) {
  return queryOptions<NotificationCountResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "notifications.count", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.notificationCount({
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
    // A new arrival should reach the badge without focus moving.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Reauthorized every time a row is opened; never cached beyond its own read. */
export function notificationTargetQueryOptions(
  client: Pick<BakeryApiClient, "resolveNotificationTarget">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<NotificationTargetResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "notifications.resolveTarget", { id }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.resolveNotificationTarget({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
    staleTime: 0,
    gcTime: 0,
  });
}

export function runsListQueryOptions(
  client: Pick<BakeryApiClient, "listRuns">,
  scope: ApiScope,
  taskId: string,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
) {
  const normalizedInput = {
    taskId,
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<RunListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "runs.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listRuns({
          organizationId: scope.organizationId,
          taskId,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

export function runQueryOptions(
  client: Pick<BakeryApiClient, "getRun">,
  scope: ApiScope,
  runId: string,
) {
  return queryOptions<RunResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "runs.get", { runId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const run = unwrap(
        await client.getRun({
          organizationId: scope.organizationId,
          runId,
          signal,
        }),
      );
      if (signal.aborted || run.id !== runId) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return run;
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/**
 * The choices a run is waiting on. Read only while a step waits on a model; the
 * page asks again every thirty seconds so a card goes when the incident closes.
 * A Viewer is not served the offers: the 403 reads as nothing to choose.
 */
export function routeContinuationsQueryOptions(
  client: Pick<BakeryApiClient, "listRouteContinuations">,
  scope: ApiScope,
  runId: string,
) {
  return queryOptions<RouteContinuationOffersResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "routeContinuations.list", { runId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const offers = unwrap(
        await client.listRouteContinuations({
          organizationId: scope.organizationId,
          runId,
          signal,
        }),
      );
      if (signal.aborted || offers.runId !== runId) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return offers;
    },
    enabled: Boolean(scope.organizationId),
    // A Viewer is refused every read: stop asking.
    refetchInterval: (query) => {
      const error = query.state.error;
      return error?.kind === "problem" && error.problem.status === 403
        ? false
        : 30_000;
    },
    retry: retryNetworkOnce,
  });
}

export function runControlCapabilitiesQueryOptions(
  client: Pick<BakeryApiClient, "getRunControlCapabilities">,
  scope: ApiScope,
  runId: string,
) {
  return queryOptions<RunControlCapabilities, ApiFailure>({
    queryKey: protectedQueryKey(scope, "runs.controlCapabilities", { runId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const capabilities = unwrap(
        await client.getRunControlCapabilities({
          organizationId: scope.organizationId,
          runId,
          signal,
        }),
      );
      if (signal.aborted || capabilities.runId !== runId) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return capabilities;
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

export function runStepsListQueryOptions(
  client: Pick<BakeryApiClient, "listRunSteps">,
  scope: ApiScope,
  runId: string,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
) {
  const normalizedInput = {
    runId,
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<RunStepListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "runSteps.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listRunSteps({
          organizationId: scope.organizationId,
          runId,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

// The delivery reads are listed oldest first, up to 100 a page, and the delivery
// section needs the newest rows, so they follow the cursor to the end. Five
// pages is far more than a run produces; past that the last cursor stays set.
const DELIVERY_PAGE_LIMIT = 100;
const DELIVERY_PAGE_CAP = 5;

async function allPages<
  Page extends { items: readonly unknown[]; nextCursor: string | null },
>(fetchPage: (cursor: string | undefined) => Promise<Page>): Promise<Page> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  let last: Page | undefined;
  for (let page = 0; page < DELIVERY_PAGE_CAP; page += 1) {
    last = await fetchPage(cursor);
    items.push(...last.items);
    if (!last.nextCursor) break;
    cursor = last.nextCursor;
  }
  return { ...last, items } as unknown as Page;
}

const deliveryScope = (scope: ApiScope): string => {
  if (!scope.organizationId) {
    throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
  }
  return scope.organizationId;
};

export function runChecksQueryOptions(
  client: Pick<BakeryApiClient, "listRunChecks">,
  scope: ApiScope,
  runId: string,
) {
  return queryOptions<CheckRunListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "checks.list", { runId }),
    queryFn: ({ signal }) => {
      const organizationId = deliveryScope(scope);
      return allPages(async (cursor) =>
        unwrap(
          await client.listRunChecks({
            organizationId,
            runId,
            cursor,
            limit: DELIVERY_PAGE_LIMIT,
            signal,
          }),
        )
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

export function runReviewsQueryOptions(
  client: Pick<BakeryApiClient, "listRunReviews">,
  scope: ApiScope,
  runId: string,
) {
  return queryOptions<ReviewCycleListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "runReviews.list", { runId }),
    queryFn: ({ signal }) => {
      const organizationId = deliveryScope(scope);
      return allPages(async (cursor) =>
        unwrap(
          await client.listRunReviews({
            organizationId,
            runId,
            cursor,
            limit: DELIVERY_PAGE_LIMIT,
            signal,
          }),
        )
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The findings of one review cycle; `runId` is in the key so a run sync refreshes it. */
export function reviewFindingsQueryOptions(
  client: Pick<BakeryApiClient, "listReviewFindings">,
  scope: ApiScope,
  runId: string,
  reviewCycleId: string | null,
) {
  return queryOptions<ReviewFindingListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "reviewFindings.list", {
      runId,
      reviewCycleId,
    }),
    queryFn: ({ signal }) => {
      const organizationId = deliveryScope(scope);
      if (reviewCycleId === null) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return allPages(async (cursor) =>
        unwrap(
          await client.listReviewFindings({
            organizationId,
            reviewCycleId,
            cursor,
            limit: DELIVERY_PAGE_LIMIT,
            signal,
          }),
        )
      );
    },
    enabled: Boolean(scope.organizationId) && reviewCycleId !== null,
    retry: retryNetworkOnce,
  });
}

export function runDeliveryDecisionsQueryOptions(
  client: Pick<BakeryApiClient, "listRunDeliveryDecisions">,
  scope: ApiScope,
  runId: string,
) {
  return queryOptions<DeliveryDecisionListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "runDeliveryDecisions.list", { runId }),
    queryFn: ({ signal }) => {
      const organizationId = deliveryScope(scope);
      return allPages(async (cursor) =>
        unwrap(
          await client.listRunDeliveryDecisions({
            organizationId,
            runId,
            cursor,
            limit: DELIVERY_PAGE_LIMIT,
            signal,
          }),
        )
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

export function syncQueryOptions(
  client: Pick<BakeryApiClient, "sync">,
  scope: ApiScope,
  input: Readonly<SyncQuery>,
) {
  const normalizedInput = {
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    after: input.after ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<SyncResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "sync.snapshot", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.sync({
          ...input,
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

export function taskQueryOptions(
  client: Pick<BakeryApiClient, "getTask">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<TaskResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "tasks.get", { id }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.getTask({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function artifactsListQueryOptions(
  client: Pick<BakeryApiClient, "listArtifacts">,
  scope: ApiScope,
  input: Readonly<ArtifactQuery> = {},
) {
  const normalizedInput = {
    repositoryId: input.repositoryId ?? null,
    taskId: input.taskId ?? null,
    artifactType: input.artifactType ?? null,
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<ArtifactListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "artifacts.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listArtifacts({
          ...input,
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function artifactStorageQueryOptions(
  client: Pick<BakeryApiClient, "getArtifactStorage">,
  scope: ApiScope,
) {
  return queryOptions<ArtifactStorageResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "artifactStorage.get", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.getArtifactStorage({
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function artifactPreviewAvailabilityQueryOptions(
  client: Pick<BakeryApiClient, "getArtifactPreviewAvailability">,
  scope: ApiScope,
) {
  return queryOptions<ArtifactPreviewAvailabilityResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "artifactPreviews.availability", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.getArtifactPreviewAvailability({
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function artifactQueryOptions(
  client: Pick<BakeryApiClient, "getArtifact">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<ArtifactResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "artifacts.get", { id }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.getArtifact({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function artifactVersionsQueryOptions(
  client: Pick<BakeryApiClient, "listArtifactVersions">,
  scope: ApiScope,
  artifactId: string,
  input: Readonly<ArtifactCursorQuery> = {},
) {
  const normalizedInput = {
    artifactId,
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<ArtifactVersionListResponse, ApiFailure>({
    queryKey: protectedQueryKey(
      scope,
      "artifactVersions.list",
      normalizedInput,
    ),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listArtifactVersions({
          ...input,
          organizationId: scope.organizationId,
          artifactId,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function artifactExtractionQueryOptions(
  client: Pick<BakeryApiClient, "extractArtifactVersion">,
  scope: ApiScope,
  versionId: string,
  input: Readonly<ArtifactExtractQuery> = {},
) {
  const normalizedInput = {
    versionId,
    startByte: input.startByte ?? null,
    maxBytes: input.maxBytes ?? null,
  };
  return queryOptions<ArtifactExtractionResponse, ApiFailure>({
    queryKey: protectedQueryKey(
      scope,
      "artifactVersions.extract",
      normalizedInput,
    ),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.extractArtifactVersion({
          ...input,
          organizationId: scope.organizationId,
          versionId,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function artifactCommentsQueryOptions(
  client: Pick<BakeryApiClient, "listArtifactComments">,
  scope: ApiScope,
  versionId: string,
  input: Readonly<ArtifactCommentQuery> = {},
) {
  return queryOptions<ArtifactCommentListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "artifactComments.list", {
      versionId,
      cursor: input.cursor ?? null,
      limit: input.limit ?? null,
      rootId: input.rootId ?? null,
      status: input.status ?? null,
      viewVersionId: input.viewVersionId ?? null,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listArtifactComments({
          ...input,
          organizationId: scope.organizationId,
          versionId,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function artifactCommentsAcrossVersionsQueryOptions(
  client: Pick<BakeryApiClient, "listArtifactCommentsAcrossVersions">,
  scope: ApiScope,
  artifactId: string,
  input: Readonly<ArtifactCommentQuery> = {},
) {
  return queryOptions<ArtifactCommentListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "artifactComments.listAcrossVersions", {
      artifactId,
      cursor: input.cursor ?? null,
      limit: input.limit ?? null,
      rootId: input.rootId ?? null,
      status: input.status ?? null,
      viewVersionId: input.viewVersionId ?? null,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listArtifactCommentsAcrossVersions({
          ...input,
          organizationId: scope.organizationId,
          artifactId,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function installationStatusQueryOptions(
  client: Pick<BakeryApiClient, "installationStatus">,
) {
  return queryOptions<InstallationStatus, ApiFailure>({
    queryKey: ["public", "installation", "status"] as const,
    queryFn: async ({ signal }) =>
      unwrap(await client.installationStatus(signal)),
    retry: retryNetworkOnce,
    // `/setup`'s "default" (not-yet-bootstrapped) screen has no manual
    // "check again" affordance per the Paper artboard; polling here is
    // what notices `pnpm createsuperuser` completing on the host instead.
    // Stops once bootstrapped, since nothing un-bootstraps an installation.
    refetchInterval: (query) =>
      query.state.data?.bootstrapped === true ? false : 5000,
  });
}

/** Public invitation-link preview: anonymous, so no protected scope in the key. */
export function invitationPreviewQueryOptions(
  client: Pick<BakeryApiClient, "invitations">,
  invitationId: string,
) {
  return queryOptions<OrganizationInvitationPreview, ApiFailure>({
    queryKey: [
      "public",
      "organizationInvitations.preview",
      { invitationId },
    ] as const,
    queryFn: async ({ signal }) =>
      unwrap(await client.invitations.preview(invitationId, signal)),
    retry: false,
  });
}

export function invitationRecipientQueryOptions(
  client: Pick<BakeryApiClient, "invitations">,
  scope: ApiScope,
  invitationId: string,
) {
  return queryOptions<OrganizationInvitationRecipient, ApiFailure>({
    queryKey: protectedQueryKey(
      scope,
      "organizationInvitations.recipientGet",
      { id: invitationId },
    ),
    queryFn: async ({ signal }) =>
      unwrap(await client.invitations.recipientGet(invitationId, signal)),
    retry: false,
  });
}

export function organizationsListQueryOptions(
  client: Pick<BakeryApiClient, "listOrganizations">,
  scope: ApiScope,
  input: Readonly<{ cursor?: string }> = {},
) {
  const normalizedInput = { cursor: input.cursor ?? null };
  return queryOptions<OrganizationAccessPage, ApiFailure>({
    queryKey: protectedQueryKey(scope, "organizations.list", normalizedInput),
    queryFn: async ({ signal }) =>
      unwrap(await client.listOrganizations(input.cursor, signal)),
    retry: retryNetworkOnce,
  });
}

export function browserSessionsListQueryOptions(
  client: Pick<BakeryApiClient, "browserSessions">,
  scope: ApiScope,
) {
  return queryOptions<BrowserSessionList, ApiFailure>({
    queryKey: protectedQueryKey(scope, "browserSessions.list", {}),
    queryFn: async ({ signal }) =>
      unwrap(await client.browserSessions.list(signal)),
    retry: retryNetworkOnce,
  });
}

export function connectedClientsListQueryOptions(
  client: Pick<BakeryApiClient, "connectedClients">,
  scope: ApiScope,
) {
  return queryOptions<ConnectedClientList, ApiFailure>({
    queryKey: protectedQueryKey(scope, "connectedClients.list", {}),
    queryFn: async ({ signal }) =>
      unwrap(await client.connectedClients.list(signal)),
    retry: retryNetworkOnce,
  });
}

export function userProfileQueryOptions(
  client: Pick<BakeryApiClient, "profile">,
  scope: ApiScope,
) {
  return queryOptions<UserProfile, ApiFailure>({
    queryKey: protectedQueryKey(scope, "profile.get", {}),
    queryFn: async ({ signal }) => unwrap(await client.profile.get(signal)),
    retry: retryNetworkOnce,
  });
}

export function userPreferencesQueryOptions(
  client: Pick<BakeryApiClient, "userPreferences">,
  scope: ApiScope,
) {
  return queryOptions<UserPreferences, ApiFailure>({
    queryKey: protectedQueryKey(scope, "userPreferences.get", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.userPreferences.get({
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The organization's storage limits and how much of its quota is used. */
export function storageSettingsQueryOptions(
  client: Pick<BakeryApiClient, "storageSettings">,
  scope: ApiScope,
) {
  return queryOptions<StorageSettings, ApiFailure>({
    queryKey: protectedQueryKey(scope, "storageSettings.get", {}),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.storageSettings.get({
          organizationId: requireOrganization(scope),
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

export function organizationQueryOptions(
  client: Pick<BakeryApiClient, "organizations">,
  scope: ApiScope,
) {
  return queryOptions<OrganizationRecord, ApiFailure>({
    queryKey: protectedQueryKey(scope, "organizations.get", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.organizations.get({
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Public and shared by every visitor, so the key carries no scope. */
export function installationCapabilitiesQueryOptions(
  client: Pick<BakeryApiClient, "installationCapabilities">,
) {
  return queryOptions<InstallationCapabilities, ApiFailure>({
    queryKey: ["public", "installation-capabilities"] as const,
    queryFn: async ({ signal }) =>
      unwrap(await client.installationCapabilities.get(signal)),
    retry: retryNetworkOnce,
  });
}

/** The organization's current repository rules baseline (revision 0 when none is published). */
export function organizationRepositoryRulesQueryOptions(
  client: Pick<BakeryApiClient, "getOrganizationRepositoryRules">,
  scope: ApiScope,
) {
  return queryOptions<OrganizationRepositoryRulesResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "repositoryRules.get", {}),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.getOrganizationRepositoryRules({
          organizationId: requireOrganization(scope),
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: false,
  });
}

/** The rules in force for one repository, with where each came from. */
export function repositoryEffectiveRulesQueryOptions(
  client: Pick<BakeryApiClient, "getRepositoryEffectiveRules">,
  scope: ApiScope,
  repositoryId: string,
) {
  return queryOptions<RepositoryEffectiveRulesResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "repositoryRules.getEffective", {
      repositoryId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.getRepositoryEffectiveRules({
          organizationId: requireOrganization(scope),
          repositoryId,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: false,
  });
}

/** Published repository rule revisions of the organization, newest first. */
export function organizationRepositoryRuleVersionsQueryOptions(
  client: Pick<BakeryApiClient, "listOrganizationRepositoryRuleVersions">,
  scope: ApiScope,
  limit = 25,
) {
  return infiniteQueryOptions<
    OrganizationRepositoryRuleVersionListResponse,
    ApiFailure,
    {
      pages: OrganizationRepositoryRuleVersionListResponse[];
      pageParams: (string | null)[];
    },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "repositoryRuleVersions.list", {
      limit,
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.listOrganizationRepositoryRuleVersions({
          organizationId: requireOrganization(scope),
          cursor: pageParam ?? undefined,
          limit,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: false,
  });
}

/**
 * What publishing a draft would do to the organization's repositories, a page
 * at a time. A query by shape only: the preview is carried by POST, writes
 * nothing, and is asked again whenever the draft or the revision under it
 * changes, so nothing is kept once the dialog closes.
 */
export function organizationRepositoryRulePreviewQueryOptions(
  client: Pick<BakeryApiClient, "previewOrganizationRepositoryRules">,
  scope: ApiScope,
  draft: {
    readonly expectedRevision: number;
    readonly entries: OrganizationRepositoryRuleEntries;
  },
  limit = 25,
) {
  return infiniteQueryOptions<
    OrganizationRepositoryRulePreviewResponse,
    ApiFailure,
    {
      pages: OrganizationRepositoryRulePreviewResponse[];
      pageParams: (string | null)[];
    },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(
      scope,
      "repositoryRulePreviews.createForOrganization",
      {
        expectedRevision: draft.expectedRevision,
        entries: draft.entries,
        limit,
      },
    ),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.previewOrganizationRepositoryRules({
          organizationId: requireOrganization(scope),
          expectedRevision: draft.expectedRevision,
          entries: draft.entries,
          cursor: pageParam ?? undefined,
          limit,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    gcTime: 0,
    retry: false,
    staleTime: 0,
  });
}

/** The selected organization's SCIM connection; the token is never part of this read. */
export function scimConnectionQueryOptions(
  client: Pick<BakeryApiClient, "scimConnection">,
  scope: ApiScope,
) {
  return queryOptions<ScimConnection, ApiFailure>({
    queryKey: protectedQueryKey(scope, "scimConnection.get", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.scimConnection.get({
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/**
 * One delivery metric over one window and repository.
 *
 * Window, repository and metric are all in the key: two windows are two
 * answers, and a cache that served the old period's figure under the new
 * period's heading would be a wrong number with a right label.
 */
export function metricSeriesQueryOptions(
  client: Pick<BakeryApiClient, "metrics">,
  scope: ApiScope,
  query: MetricsQuery,
) {
  return queryOptions<MetricSeries, ApiFailure>({
    queryKey: protectedQueryKey(scope, "metrics.get", { ...query }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.metrics.get({
          organizationId: requireOrganization(scope),
          query,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The records behind one metric, newest placed first, a page at a time. */
export function metricSourcesQueryOptions(
  client: Pick<BakeryApiClient, "metrics">,
  scope: ApiScope,
  query: Omit<MetricSourcesQuery, "cursor">,
) {
  return infiniteQueryOptions<
    MetricSourcePage,
    ApiFailure,
    { pages: MetricSourcePage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "metrics.sources", { ...query }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.metrics.sources({
          organizationId: requireOrganization(scope),
          query: {
            ...query,
            ...(pageParam === null ? {} : { cursor: pageParam }),
          },
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/**
 * The installation's usage summary for one window and provider filter.
 *
 * The window is in the key because two periods are two answers, and a cache
 * that answered the new period with the old figures would show a wrong number
 * under a right heading. `undefined` provider means "all", which is the
 * server's own default for the field.
 */
export function usageSummaryQueryOptions(
  client: Pick<BakeryApiClient, "usage">,
  scope: ApiScope,
  query: UsageQuery,
) {
  return queryOptions<UsageSummary, ApiFailure>({
    queryKey: protectedQueryKey(scope, "usage.list", { ...query }),
    queryFn: async ({ signal }) =>
      unwrap(await client.usage.list({ query, signal })),
    retry: retryNetworkOnce,
  });
}

/**
 * Whether a restore holds the installation right now (#64 E4), read from the
 * public installation status so every signed-in person, not only an
 * administrator, can see the banner before their first refused action. It
 * reads again every minute and when the window is focused again, so the banner
 * leaves soon after an administrator finishes the restore.
 */
export function installationHeldQueryOptions(
  client: Pick<BakeryApiClient, "installationStatus">,
) {
  return queryOptions<boolean, ApiFailure>({
    queryKey: ["installation", "restoreHeld"],
    queryFn: async ({ signal }) =>
      unwrap(await client.installationStatus(signal)).restoreHeld,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * The restore that holds the installation, or null when none does. "No restore
 * is held" is the normal answer of a running installation (RESTORE_NOT_HELD),
 * not a failure: the banner and the Restore item show only while this is a
 * record.
 */
export function installationRestoreQueryOptions(
  client: Pick<BakeryApiClient, "installationRestore">,
  scope: ApiScope,
  enabled = true,
) {
  return queryOptions<InstallationRestore | null, ApiFailure>({
    queryKey: protectedQueryKey(scope, "installationRestore.get", {}),
    enabled,
    queryFn: async ({ signal }) => {
      const read = await client.installationRestore.get(signal);
      if (read.ok) return read.data;
      if (
        read.error.kind === "problem" &&
        read.error.problem.code === "RESTORE_NOT_HELD"
      ) return null;
      throw read.error;
    },
    retry: retryNetworkOnce,
  });
}

/**
 * Whether the installation is protected by backups (#64). It reads again
 * every 30 seconds so a running backup's progress and its end show without a
 * reload; that is one small read, and only while the page is open.
 */
export function backupStatusQueryOptions(
  client: Pick<BakeryApiClient, "backups">,
  scope: ApiScope,
) {
  return queryOptions<BackupStatus, ApiFailure>({
    queryKey: protectedQueryKey(scope, "backups.status", {}),
    queryFn: async ({ signal }) => unwrap(await client.backups.status(signal)),
    refetchInterval: 30_000,
    retry: retryNetworkOnce,
  });
}

/** The backups, newest first, a page at a time ("Show older"). */
export function backupRunsQueryOptions(
  client: Pick<BakeryApiClient, "backups">,
  scope: ApiScope,
) {
  return infiniteQueryOptions<
    BackupRunPage,
    ApiFailure,
    { pages: BackupRunPage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "backups.list", {}),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.backups.list({
          ...(pageParam === null ? {} : { cursor: pageParam }),
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

/** The restore checks the server ran, newest first, a page at a time. */
export function backupDrillsQueryOptions(
  client: Pick<BakeryApiClient, "backups">,
  scope: ApiScope,
) {
  return infiniteQueryOptions<
    BackupDrillPage,
    ApiFailure,
    { pages: BackupDrillPage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "backups.drills.list", {}),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.backups.drills({
          ...(pageParam === null ? {} : { cursor: pageParam }),
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

export function backupScheduleQueryOptions(
  client: Pick<BakeryApiClient, "backups">,
  scope: ApiScope,
) {
  return queryOptions<BackupSchedule, ApiFailure>({
    queryKey: protectedQueryKey(scope, "backupSchedule.get", {}),
    queryFn: async ({ signal }) =>
      unwrap(await client.backups.schedule(signal)),
    retry: retryNetworkOnce,
  });
}

export function backupPointInTimeQueryOptions(
  client: Pick<BakeryApiClient, "backups">,
  scope: ApiScope,
) {
  return queryOptions<BackupPointInTime, ApiFailure>({
    queryKey: protectedQueryKey(scope, "backupPointInTime.get", {}),
    queryFn: async ({ signal }) =>
      unwrap(await client.backups.pointInTime(signal)),
    retry: retryNetworkOnce,
  });
}

export function backupOffsiteQueryOptions(
  client: Pick<BakeryApiClient, "backups">,
  scope: ApiScope,
) {
  return queryOptions<BackupOffsite, ApiFailure>({
    queryKey: protectedQueryKey(scope, "backupOffsite.get", {}),
    queryFn: async ({ signal }) => unwrap(await client.backups.offsite(signal)),
    retry: retryNetworkOnce,
  });
}

export function installationSettingsQueryOptions(
  client: Pick<BakeryApiClient, "installationSettings">,
  scope: ApiScope,
) {
  return queryOptions<InstallationSettings, ApiFailure>({
    queryKey: protectedQueryKey(scope, "installationSettings.get", {}),
    queryFn: async ({ signal }) =>
      unwrap(await client.installationSettings.get(signal)),
    retry: retryNetworkOnce,
  });
}

export function integrationAppRegistrationQueryOptions(
  client: Pick<BakeryApiClient, "integrationAppRegistrations">,
  scope: ApiScope,
) {
  return queryOptions<IntegrationAppRegistration, ApiFailure>({
    queryKey: protectedQueryKey(
      scope,
      "integrationAppRegistrations.get",
      {},
    ),
    queryFn: async ({ signal }) =>
      unwrap(await client.integrationAppRegistrations.get(signal)),
    retry: retryNetworkOnce,
  });
}

export function integrationClientCredentialsQueryOptions(
  client: Pick<BakeryApiClient, "integrationClientCredentials">,
  scope: ApiScope,
  provider: string,
) {
  return queryOptions<IntegrationClientCredentials, ApiFailure>({
    queryKey: protectedQueryKey(
      scope,
      "integrationClientCredentials.get",
      { provider },
    ),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.integrationClientCredentials.get({ provider, signal }),
      ),
    retry: retryNetworkOnce,
  });
}

export function skillStorageQueryOptions(
  client: Pick<BakeryApiClient, "skillStorage">,
  scope: ApiScope,
) {
  return queryOptions<SkillStorageSettings, ApiFailure>({
    queryKey: protectedQueryKey(scope, "skillStorageSettings.get", {}),
    queryFn: async ({ signal }) =>
      unwrap(await client.skillStorage.get(signal)),
    retry: retryNetworkOnce,
  });
}

export function applicationsListQueryOptions(
  client: Pick<BakeryApiClient, "listApplications">,
  scope: ApiScope,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
) {
  const normalizedInput = {
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<ApplicationListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "applications.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listApplications({
          organizationId: scope.organizationId,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function repositoriesListQueryOptions(
  client: Pick<BakeryApiClient, "listRepositories">,
  scope: ApiScope,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
) {
  const normalizedInput = {
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<RepositoryListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "repositories.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listRepositories({
          organizationId: scope.organizationId,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

/**
 * Every repository of the organization, collected 100 at a time up to a bound (as the Projects
 * lists do), for pages that must name any repository a record points at.
 */
export function repositoriesAllQueryOptions(
  client: Pick<BakeryApiClient, "listRepositories">,
  scope: ApiScope,
) {
  return queryOptions<RepositoryListResponse["items"], ApiFailure>({
    queryKey: protectedQueryKey(scope, "repositories.all", {}),
    queryFn: async ({ signal }) => {
      const items: RepositoryListResponse["items"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < PROJECTS_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listRepositories({
            organizationId: requireOrganization(scope),
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) break;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

export function repositoryQueryOptions(
  client: Pick<BakeryApiClient, "getRepository">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<RepositoryResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "repositories.get", { id }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const repository = unwrap(
        await client.getRepository({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
      if (signal.aborted || repository.id !== id) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return repository;
    },
    retry: retryNetworkOnce,
  });
}

export function repositoryProfilesListQueryOptions(
  client: Pick<BakeryApiClient, "listRepositoryProfiles">,
  scope: ApiScope,
  repositoryId: string,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
) {
  const normalizedInput = {
    repositoryId,
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<RepositoryProfileListResponse, ApiFailure>({
    queryKey: protectedQueryKey(
      scope,
      "repositoryProfiles.list",
      normalizedInput,
    ),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const page = unwrap(
        await client.listRepositoryProfiles({
          organizationId: scope.organizationId,
          repositoryId,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
      if (
        signal.aborted ||
        page.items.some((profile) => profile.repositoryId !== repositoryId)
      ) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return page;
    },
    retry: retryNetworkOnce,
  });
}

export function repositoryRolesListQueryOptions(
  client: Pick<BakeryApiClient, "listRepositoryRoles">,
  scope: ApiScope,
  applicationId: string,
  input: Readonly<{ cursor?: string; limit?: number }> = {},
) {
  const normalizedInput = {
    applicationId,
    cursor: input.cursor ?? null,
    limit: input.limit ?? null,
  };
  return queryOptions<RoleBindingListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "projects.roles.list", normalizedInput),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const page = unwrap(
        await client.listRepositoryRoles({
          organizationId: scope.organizationId,
          applicationId,
          cursor: input.cursor,
          limit: input.limit,
          signal,
        }),
      );
      if (
        signal.aborted ||
        page.items.some((role) =>
          role.organizationId !== scope.organizationId ||
          role.applicationId !== applicationId
        )
      ) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return page;
    },
    retry: retryNetworkOnce,
  });
}

export function applicationQueryOptions(
  client: Pick<BakeryApiClient, "getApplication">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<ApplicationResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "applications.get", { id }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const application = unwrap(
        await client.getApplication({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
      if (signal.aborted || application.id !== id) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return application;
    },
    retry: retryNetworkOnce,
  });
}

export function workflowQueryOptions(
  client: Pick<BakeryApiClient, "getWorkflow">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<WorkflowDefinitionResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "workflows.get", { id }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.getWorkflow({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

export function repositoryOnboardingQueryOptions(
  client: Pick<BakeryApiClient, "getRepositoryOnboarding">,
  scope: ApiScope,
  repositoryId: string,
  id: string,
  jobId: string,
) {
  return queryOptions<RepositoryOnboardingResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "repositoryOnboardings.get", {
      repositoryId,
      id,
      jobId,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId || !repositoryId || !id || !jobId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const onboarding = unwrap(
        await client.getRepositoryOnboarding({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
      if (
        signal.aborted || onboarding.id !== id ||
        onboarding.repositoryId !== repositoryId || onboarding.jobId !== jobId
      ) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return onboarding;
    },
    retry: retryNetworkOnce,
    refetchInterval: (query) =>
      query.state.status !== "error" &&
        (query.state.data?.status === "queued" ||
          query.state.data?.status === "running")
        ? 1_500
        : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });
}

/**
 * One readiness check of a repository, read by its own identity (the address
 * carries it, so a reload or a shared link shows the same check). The check's
 * progress is polled while it is queued or running.
 */
export function repositoryCheckQueryOptions(
  client: Pick<BakeryApiClient, "getRepositoryOnboarding">,
  scope: ApiScope,
  repositoryId: string,
  id: string,
) {
  return queryOptions<RepositoryOnboardingResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "repositoryChecks.get", {
      repositoryId,
      id,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId || !repositoryId || !id) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const check = unwrap(
        await client.getRepositoryOnboarding({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
      if (
        signal.aborted || check.id !== id || check.repositoryId !== repositoryId
      ) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return check;
    },
    retry: retryNetworkOnce,
    refetchInterval: (query) =>
      query.state.status !== "error" &&
        (query.state.data?.status === "queued" ||
          query.state.data?.status === "running")
        ? 1_500
        : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
  });
}

export function repositoryProfileObservationQueryOptions(
  client: Pick<BakeryApiClient, "getRepositoryProfileObservation">,
  scope: ApiScope,
  applicationId: string,
  onboarding: RepositoryOnboardingResponse | null,
) {
  return queryOptions<RepositoryProfileObservationResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "repositoryObservations.get", {
      applicationId,
      repositoryId: onboarding?.repositoryId ?? null,
      id: onboarding?.observationId ?? null,
      profileId: onboarding?.profileId ?? null,
      onboardingId: onboarding?.id ?? null,
      jobId: onboarding?.jobId ?? null,
    }),
    queryFn: async ({ signal }) => {
      if (
        !scope.organizationId || !applicationId ||
        onboarding?.status !== "completed" ||
        !onboarding.observationId || !onboarding.profileId
      ) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const observation = unwrap(
        await client.getRepositoryProfileObservation({
          organizationId: scope.organizationId,
          id: onboarding.observationId,
          signal,
        }),
      );
      if (
        signal.aborted || observation.id !== onboarding.observationId ||
        observation.repositoryId !== onboarding.repositoryId ||
        observation.profileId !== onboarding.profileId ||
        observation.payload.organizationId !== scope.organizationId ||
        observation.payload.applicationId !== applicationId ||
        observation.payload.inspectionId !== onboarding.id ||
        observation.payload.jobId !== onboarding.jobId
      ) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return observation;
    },
    retry: retryNetworkOnce,
    staleTime: Infinity,
  });
}

export function effectiveAccessQueryOptions(
  client: Pick<BakeryApiClient, "organizations">,
  scope: ApiScope,
) {
  return queryOptions<EffectiveAccess, ApiFailure>({
    queryKey: protectedQueryKey(scope, "organizations.effectiveAccess", {}),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.organizations.effectiveAccess({
          organizationId: scope.organizationId,
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

export function workflowPresetsQueryOptions(
  client: Pick<BakeryApiClient, "listWorkflowPresets">,
  scope: ApiScope,
  repositoryId: string | null,
) {
  return queryOptions<WorkflowPresetListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "workflowPresets.list", {
      repositoryId,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.listWorkflowPresets({
          organizationId: scope.organizationId,
          ...(repositoryId === null ? {} : { repositoryId }),
          signal,
        }),
      );
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Pages read, 100 at a time, before the Library says a list was cut short. */
const LIBRARY_COLLECTION_PAGES = 5;
const ALL_PAGES_GUARD = 200;

/** Every workflow definition of the organization (a few pages at most), and whether the list was cut short. */
export function libraryWorkflowsQueryOptions(
  client: Pick<BakeryApiClient, "listWorkflows">,
  scope: ApiScope,
) {
  return queryOptions<
    { items: WorkflowDefinitionResponse[]; truncated: boolean },
    ApiFailure
  >({
    queryKey: protectedQueryKey(scope, "library.workflows", {}),
    queryFn: async ({ signal }) => {
      const items: WorkflowDefinitionResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listWorkflows({
            organizationId: requireOrganization(scope),
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return { items, truncated: false };
        cursor = read.nextCursor;
      }
      return { items, truncated: true };
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every remembered fact of the organization (a few pages at most), each with its current revision, and whether the list was cut short. */
export function libraryMemoriesQueryOptions(
  client: Pick<BakeryApiClient, "listMemories">,
  scope: ApiScope,
) {
  return queryOptions<
    { items: MemoryEntryResponse[]; truncated: boolean },
    ApiFailure
  >({
    queryKey: protectedQueryKey(scope, "library.memories", {}),
    queryFn: async ({ signal }) => {
      const items: MemoryEntryResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listMemories({
            organizationId: requireOrganization(scope),
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return { items, truncated: false };
        cursor = read.nextCursor;
      }
      return { items, truncated: true };
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every repository of the organization, page after page: the names the Memory rows show. */
export function libraryRepositoriesQueryOptions(
  client: Pick<BakeryApiClient, "listRepositories">,
  scope: ApiScope,
) {
  return queryOptions<RepositoryListResponse["items"], ApiFailure>({
    queryKey: protectedQueryKey(scope, "library.repositories", {}),
    queryFn: async ({ signal }) => {
      const items: RepositoryListResponse["items"] = [];
      let cursor: string | undefined;
      // A guard against a cursor that never ends, not a limit anyone reaches.
      for (let page = 0; page < ALL_PAGES_GUARD; page += 1) {
        const read = unwrap(
          await client.listRepositories({
            organizationId: requireOrganization(scope),
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return items;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every document of one repository a correction can cite, page after page. */
export function memorySourcesQueryOptions(
  client: Pick<BakeryApiClient, "listArtifacts">,
  scope: ApiScope,
  repositoryId: string,
) {
  return queryOptions<ArtifactListResponse["items"], ApiFailure>({
    queryKey: protectedQueryKey(scope, "memory.sources", { repositoryId }),
    queryFn: async ({ signal }) => {
      const items: ArtifactListResponse["items"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < ALL_PAGES_GUARD; page += 1) {
        const read = unwrap(
          await client.listArtifacts({
            organizationId: requireOrganization(scope),
            repositoryId,
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return items;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** One remembered fact by id: for a link to a fact the loaded list does not hold. */
export function memoryQueryOptions(
  client: Pick<BakeryApiClient, "getMemory">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<MemoryEntryResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "memory.one", { id }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.getMemory({
          organizationId: requireOrganization(scope),
          id,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && id !== "",
    retry: retryNetworkOnce,
  });
}

/** Every wording one remembered fact has had (a few pages at most): the history shown under it. */
export function memoryRevisionsQueryOptions(
  client: Pick<BakeryApiClient, "listMemoryRevisions">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<MemoryRevisionResponse[], ApiFailure>({
    queryKey: protectedQueryKey(scope, "memory.revisions", { id }),
    queryFn: async ({ signal }) => {
      const items: MemoryRevisionResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listMemoryRevisions({
            organizationId: requireOrganization(scope),
            id,
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return items;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every agent definition of the organization (a few pages at most), and whether the list was cut short. */
export function libraryAgentsQueryOptions(
  client: Pick<BakeryApiClient, "listAgents">,
  scope: ApiScope,
) {
  return queryOptions<
    { items: AgentDefinitionResponse[]; truncated: boolean },
    ApiFailure
  >({
    queryKey: protectedQueryKey(scope, "library.agents", {}),
    queryFn: async ({ signal }) => {
      const items: AgentDefinitionResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listAgents({
            organizationId: requireOrganization(scope),
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return { items, truncated: false };
        cursor = read.nextCursor;
      }
      return { items, truncated: true };
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every version of one workflow (a few pages at most). */
/** One agent definition of the organization. */
export function agentQueryOptions(
  client: Pick<BakeryApiClient, "getAgent">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<AgentDefinitionResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "agents.get", { id }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.getAgent({
          organizationId: scope.organizationId,
          id,
          signal,
        }),
      );
    },
    retry: retryNetworkOnce,
  });
}

/**
 * The skills a person may attach to a step (#431): every enabled skill with an
 * active version, read across a few pages. A skill with no active version, or
 * switched off, cannot be attached and is left out.
 */
export function attachableSkillsQueryOptions(
  client: Pick<BakeryApiClient, "listSkills">,
  scope: ApiScope,
) {
  return queryOptions<SkillResponse[], ApiFailure>({
    queryKey: protectedQueryKey(scope, "library.attachableSkills", {}),
    queryFn: async ({ signal }) => {
      const items: SkillResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listSkills({
            organizationId: requireOrganization(scope),
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(
          ...read.items.filter((skill) =>
            skill.enabled && skill.activeVersionId !== null &&
            skill.activeRevision !== null
          ),
        );
        if (!read.nextCursor) break;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/**
 * The skills the steps of one workflow version name (#431), read for the
 * version being edited. The digest is in the key so a saved change to the
 * draft reads the skills again.
 */
export function workflowVersionSkillsQueryOptions(
  client: Pick<BakeryApiClient, "listWorkflowVersionSkills">,
  scope: ApiScope,
  workflowId: string,
  versionId: string,
  digest: string,
) {
  return queryOptions<WorkflowVersionSkills, ApiFailure>({
    queryKey: protectedQueryKey(scope, "library.workflowVersionSkills", {
      workflowId,
      versionId,
      digest,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listWorkflowVersionSkills({
          organizationId: requireOrganization(scope),
          workflowId,
          versionId,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && versionId !== "",
    retry: retryNetworkOnce,
  });
}

export function workflowVersionsQueryOptions(
  client: Pick<BakeryApiClient, "listWorkflowVersions">,
  scope: ApiScope,
  workflowId: string,
) {
  return queryOptions<
    { items: WorkflowVersionResponse[]; truncated: boolean },
    ApiFailure
  >({
    queryKey: protectedQueryKey(scope, "library.workflowVersions", {
      workflowId,
    }),
    queryFn: async ({ signal }) => {
      const items: WorkflowVersionResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listWorkflowVersions({
            organizationId: requireOrganization(scope),
            workflowId,
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return { items, truncated: false };
        cursor = read.nextCursor;
      }
      // The server lists newest first, so a cut-short list lacks the oldest.
      return { items, truncated: true };
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every version of one agent (a few pages at most), and whether the list was cut short. */
export function agentVersionsQueryOptions(
  client: Pick<BakeryApiClient, "listAgentVersions">,
  scope: ApiScope,
  agentId: string,
) {
  return queryOptions<
    { items: AgentVersionResponse[]; truncated: boolean },
    ApiFailure
  >({
    queryKey: protectedQueryKey(scope, "library.agentVersions", { agentId }),
    queryFn: async ({ signal }) => {
      const items: AgentVersionResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listAgentVersions({
            organizationId: requireOrganization(scope),
            agentId,
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return { items, truncated: false };
        cursor = read.nextCursor;
      }
      return { items, truncated: true };
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

// E05 run-output queries remain scoped to the current browser session.
export function outputStreamsQueryOptions(
  client: Pick<BakeryApiClient, "output">,
  scope: ApiScope,
  taskId: string,
  runStepId: string,
  cursor?: string,
) {
  return queryOptions({
    queryKey: protectedQueryKey(scope, "output.streams.list", {
      taskId,
      runStepId,
      cursor: cursor ?? null,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      return unwrap(
        await client.output.list(scope.organizationId, {
          taskId,
          runStepId,
          limit: 32,
          cursor,
        }, signal),
      );
    },
    retry: retryNetworkOnce,
    refetchInterval: 5000,
  });
}

export function runOutputStepIdsQueryOptions(
  client: Pick<BakeryApiClient, "listRunSteps">,
  scope: ApiScope,
  runId: string,
) {
  return queryOptions({
    queryKey: protectedQueryKey(scope, "runOutput.steps", { runId }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const ids: string[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 16; page++) {
        const result = unwrap(
          await client.listRunSteps({
            organizationId: scope.organizationId,
            runId,
            cursor,
            limit: 25,
            signal,
          }),
        );
        if (result.items.some((step) => step.runId !== runId)) {
          throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
        }
        ids.push(...result.items.map((step) => step.id));
        if (!result.nextCursor) return ids;
        if (seen.has(result.nextCursor)) break;
        seen.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
    },
    retry: retryNetworkOnce,
  });
}

export function runAttemptsQueryOptions(
  client: Pick<BakeryApiClient, "output">,
  scope: ApiScope,
  taskId: string,
  jobId: string,
  cursor?: string,
) {
  return queryOptions({
    queryKey: protectedQueryKey(scope, "jobAttempts.list", {
      taskId,
      jobId,
      cursor: cursor ?? null,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const page = unwrap(
        await client.output.attempts(
          scope.organizationId,
          taskId,
          jobId,
          cursor,
          signal,
        ),
      );
      if (
        page.items.some((attempt) =>
          attempt.taskId !== taskId || attempt.jobId !== jobId
        )
      ) throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      return page;
    },
    retry: retryNetworkOnce,
    refetchInterval: 5000,
  });
}

function requireOrganization(scope: ApiScope): string {
  if (!scope.organizationId) {
    throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
  }
  return scope.organizationId;
}

/** Conversation transcript, newest page first; older pages load on demand. */
export function conversationMessagesQueryOptions(
  client: Pick<BakeryApiClient, "listMessages">,
  scope: ApiScope,
  conversationId: string,
  limit = 25,
) {
  return infiniteQueryOptions<
    MessageListResponse,
    ApiFailure,
    { pages: MessageListResponse[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "messages.list", {
      conversationId,
      limit,
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.listMessages({
          organizationId: requireOrganization(scope),
          conversationId,
          cursor: pageParam ?? undefined,
          limit,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

export function conversationTurnsQueryOptions(
  client: Pick<BakeryApiClient, "listConversationTurns">,
  scope: ApiScope,
  conversationId: string,
) {
  return queryOptions<ConversationTurnListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "conversationTurns.list", {
      conversationId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listConversationTurns({
          organizationId: requireOrganization(scope),
          conversationId,
          limit: 10,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

export function planRevisionsQueryOptions(
  client: Pick<BakeryApiClient, "listPlanRevisions">,
  scope: ApiScope,
  taskId: string,
) {
  return queryOptions<PlanRevisionListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "planRevisions.list", { taskId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listPlanRevisions({
          organizationId: requireOrganization(scope),
          taskId,
          limit: 10,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

export function approvalsQueryOptions(
  client: Pick<BakeryApiClient, "listApprovals">,
  scope: ApiScope,
  taskId: string,
) {
  return queryOptions<ApprovalListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "approvals.list", { taskId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listApprovals({
          organizationId: requireOrganization(scope),
          taskId,
          limit: 25,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

/**
 * One pull request's merge attempts, newest first. Read whole (the newest is
 * what the section shows) and kept fresh, so a refused or unknown attempt is
 * what the page says after a reload, never a guess.
 */
export function mergeAttemptsQueryOptions(
  client: Pick<BakeryApiClient, "listMergeAttempts">,
  scope: ApiScope,
  pullRequestId: string,
) {
  return queryOptions<MergeAttemptListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "mergeAttempts.list", {
      pullRequestId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listMergeAttempts({
          organizationId: requireOrganization(scope),
          pullRequestId,
          limit: 10,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

/**
 * One pull request's merge queue entries, newest first. Kept fresh so the page
 * says what the queue is doing after a reload, and shows a stopped merge's
 * reason rather than guessing one.
 */
export function mergeEntriesQueryOptions(
  client: Pick<BakeryApiClient, "listMergeEntries">,
  scope: ApiScope,
  pullRequestId: string,
) {
  return queryOptions<MergeEntryListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "mergeEntries.list", {
      pullRequestId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listMergeEntries({
          organizationId: requireOrganization(scope),
          pullRequestId,
          limit: 10,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

/**
 * The task's pull requests, oldest first. Read by task rather than by run: a
 * pull request registered without a run would never match a run filter, and
 * choosing this run's one is the view model's job.
 */
export function pullRequestsQueryOptions(
  client: Pick<BakeryApiClient, "listPullRequests">,
  scope: ApiScope,
  taskId: string,
) {
  return queryOptions<PullRequestListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "pullRequests.list", { taskId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listPullRequests({
          organizationId: requireOrganization(scope),
          taskId,
          limit: 25,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

export function questionsQueryOptions(
  client: Pick<BakeryApiClient, "listQuestions">,
  scope: ApiScope,
  taskId: string,
  status?: "open",
) {
  return queryOptions<QuestionListResponse, ApiFailure>({
    queryKey: protectedQueryKey(
      scope,
      "questions.list",
      status === undefined ? { taskId } : { taskId, status },
    ),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listQuestions({
          organizationId: requireOrganization(scope),
          taskId,
          ...(status === undefined ? {} : { status }),
          limit: 25,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

/** The most pages of open questions one read follows; each holds up to 100. */
const OPEN_QUESTION_PAGES = 10;

/**
 * Every open question of a task, not just the newest page: the list is newest
 * first and a page holds at most 100, so a count or an oldest read from one
 * page would miss older open ones. Follows the cursor to the end or to the cap
 * of ten pages, so a task with more than 1,000 open questions has the newest
 * 1,000 counted; no task is expected to have that many.
 */
export function openQuestionsQueryOptions(
  client: Pick<BakeryApiClient, "listQuestions">,
  scope: ApiScope,
  taskId: string,
) {
  return queryOptions<
    { readonly items: QuestionListResponse["items"] },
    ApiFailure
  >({
    queryKey: protectedQueryKey(scope, "questions.list", {
      taskId,
      status: "open",
      allPages: true,
    }),
    queryFn: async ({ signal }) => {
      const items: QuestionListResponse["items"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < OPEN_QUESTION_PAGES; page++) {
        const result = unwrap(
          await client.listQuestions({
            organizationId: requireOrganization(scope),
            taskId,
            status: "open",
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
            signal,
          }),
        );
        items.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return { items };
    },
    retry: retryNetworkOnce,
  });
}

export function conversationParticipantsQueryOptions(
  client: Pick<BakeryApiClient, "listConversationParticipants">,
  scope: ApiScope,
  conversationId: string,
) {
  return queryOptions<ConversationParticipantListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "conversationParticipants.list", {
      conversationId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listConversationParticipants({
          organizationId: requireOrganization(scope),
          conversationId,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

/** Newest plan revision of a parent task, or an empty page. */
export function coordinationPlansQueryOptions(
  client: Pick<BakeryApiClient, "listCoordinationPlans">,
  scope: ApiScope,
  parentTaskId: string,
) {
  return queryOptions<CoordinationPlanListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "coordinationPlans.list", {
      parentTaskId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listCoordinationPlans({
          organizationId: requireOrganization(scope),
          parentTaskId,
          limit: 10,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

export function taskRepositoriesQueryOptions(
  client: Pick<BakeryApiClient, "listTaskRepositories">,
  scope: ApiScope,
  taskId: string,
) {
  return queryOptions<TaskRepositoryListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "taskRepositories.list", { taskId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listTaskRepositories({
          organizationId: requireOrganization(scope),
          taskId,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

export function applicationRepositoryRolesQueryOptions(
  client: Pick<BakeryApiClient, "listApplicationRepositoryRoles">,
  scope: ApiScope,
  applicationId: string,
) {
  return queryOptions<ApplicationRepositoryRoleListResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "applicationRepositoryRoles.list", {
      applicationId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listApplicationRepositoryRoles({
          organizationId: requireOrganization(scope),
          applicationId,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

/** Pages of applications for the Projects list, 25 at a time. */
export function projectApplicationsPagesQueryOptions(
  client: Pick<BakeryApiClient, "listApplications">,
  scope: ApiScope,
  limit = 25,
) {
  return infiniteQueryOptions<
    ApplicationListResponse,
    ApiFailure,
    { pages: ApplicationListResponse[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "projects.applications", { limit }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.listApplications({
          organizationId: requireOrganization(scope),
          cursor: pageParam ?? undefined,
          limit,
          signal,
        }),
      ),
    retry: retryNetworkOnce,
  });
}

/** Most pages of 100 the Projects list reads of repositories, connections and their repositories. */
const PROJECTS_COLLECTION_PAGES = 10;

/**
 * Every repository, archived ones too, read 100 at a time up to a bound
 * (1000): the list groups them under their application and the Add repository
 * picker needs to know which ones exist. `truncated` says the bound was hit.
 */
export function projectRepositoriesQueryOptions(
  client: Pick<BakeryApiClient, "listRepositories">,
  scope: ApiScope,
) {
  return queryOptions<
    { items: RepositoryResponse[]; truncated: boolean },
    ApiFailure
  >({
    queryKey: protectedQueryKey(scope, "projects.repositories", {}),
    queryFn: async ({ signal }) => {
      const items: RepositoryResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < PROJECTS_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listRepositories({
            organizationId: requireOrganization(scope),
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return { items, truncated: false };
        cursor = read.nextCursor;
      }
      return { items, truncated: true };
    },
    retry: retryNetworkOnce,
  });
}

/** One integration connection, for its page. */
export function integrationConnectionQueryOptions(
  client: Pick<BakeryApiClient, "integrationConnections">,
  scope: ApiScope,
  connectionId: string,
) {
  return queryOptions<IntegrationConnection, ApiFailure>({
    queryKey: protectedQueryKey(scope, "integrationConnections.get", {
      connectionId,
    }),
    queryFn: async ({ signal }) => {
      if (!scope.organizationId) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const connection = unwrap(
        await client.integrationConnections.get({
          organizationId: scope.organizationId,
          id: connectionId,
          signal,
        }),
      );
      if (signal.aborted || connection.id !== connectionId) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      return connection;
    },
    enabled: Boolean(scope.organizationId && connectionId),
    retry: retryNetworkOnce,
  });
}

/**
 * The repositories the organization's enabled GitHub connections have
 * selected and made available, with the connection each belongs to. Read when
 * the Add repository dialog opens.
 */
export function connectionRepositoriesQueryOptions(
  client: Pick<
    BakeryApiClient,
    "integrationConnections" | "integrationResources"
  >,
  scope: ApiScope,
  enabled: boolean,
) {
  return queryOptions<
    { connections: IntegrationConnection[]; resources: IntegrationResource[] },
    ApiFailure
  >({
    queryKey: protectedQueryKey(scope, "projects.connectionRepositories", {}),
    queryFn: async ({ signal }) => {
      const organizationId = requireOrganization(scope);
      const connections: IntegrationConnection[] = [];
      let cursor: string | undefined;
      do {
        const read = unwrap(
          await client.integrationConnections.list({
            organizationId,
            cursor,
            signal,
          }),
        );
        connections.push(...read.items);
        cursor = read.nextCursor ?? undefined;
      } while (cursor);
      const usable = connections.filter((connection) =>
        connection.provider === "github" && connection.status === "enabled"
      );
      const resources: IntegrationResource[] = [];
      for (const connection of usable) {
        let next: string | undefined;
        for (let page = 0; page < PROJECTS_COLLECTION_PAGES; page += 1) {
          const read = unwrap(
            await client.integrationResources.list({
              organizationId,
              connectionId: connection.id,
              query: {
                kind: "repository",
                selected: true,
                available: true,
                limit: 100,
                ...(next === undefined ? {} : { cursor: next }),
              },
              signal,
            }),
          );
          resources.push(...read.items);
          if (read.nextCursor === null) break;
          next = read.nextCursor;
        }
      }
      return { connections: usable, resources };
    },
    enabled: enabled && Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** One page of batches, newest first; `repositoryId` narrows to one repository. */
export function batchesListQueryOptions(
  client: Pick<BakeryApiClient, "batches">,
  scope: ApiScope,
  filter: { readonly repositoryId: string | null; readonly limit: number },
) {
  return infiniteQueryOptions<
    BatchListResponse,
    ApiFailure,
    { pages: BatchListResponse[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "batches.list", filter),
    initialPageParam: null,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.batches.list({
          organizationId: requireOrganization(scope),
          ...(filter.repositoryId === null
            ? {}
            : { repositoryId: filter.repositoryId }),
          cursor: pageParam ?? undefined,
          limit: filter.limit,
          signal,
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** How many startable issues the start page reads and lists; the design shows the first five. */
export const STARTABLE_PAGE_SIZE = 5;

/**
 * The first page of the issues a batch in one repository would take now, with
 * the smallest spend that can start one. Read again each time the page opens:
 * it is a forecast from the last stored readiness check.
 */
export function batchStartableQueryOptions(
  client: Pick<BakeryApiClient, "batches">,
  scope: ApiScope,
  repositoryId: string,
) {
  return queryOptions<BatchStartableResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "batches.startable", { repositoryId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.batches.startable({
          organizationId: requireOrganization(scope),
          repositoryId,
          limit: STARTABLE_PAGE_SIZE,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && repositoryId !== "",
    retry: retryNetworkOnce,
  });
}

/**
 * One batch. While it is live and the tab is showing, it is read again every
 * ten seconds so the page follows the supervisor; a finished batch is read once.
 */
export function batchQueryOptions(
  client: Pick<BakeryApiClient, "batches">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<BatchResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "batches.get", { id }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.batches.get({
          organizationId: requireOrganization(scope),
          id,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && id !== "",
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === undefined || state === "finished" ||
          state === "stopped"
        ? false
        : 10_000;
    },
    refetchIntervalInBackground: false,
    retry: retryNetworkOnce,
  });
}

/** One repository's issue settings, by id. */
export function ticketSourceQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<TicketSourceResponse, ApiFailure>({
    queryKey: protectedQueryKey(scope, "ticketSources.get", { id }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.tickets.source({
          organizationId: requireOrganization(scope),
          id,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && id !== "",
    retry: retryNetworkOnce,
  });
}

/**
 * Every repository source of issues, collected 100 at a time up to a bound,
 * for the Choose repositories sheet (it needs each repository's source and
 * labels at once).
 */
export function ticketSourcesAllQueryOptions(
  client: Pick<BakeryApiClient, "tickets">,
  scope: ApiScope,
  enabled: boolean,
) {
  return queryOptions<TicketSourceResponse[], ApiFailure>({
    queryKey: protectedQueryKey(scope, "ticketSources.all", {}),
    queryFn: async ({ signal }) => {
      const items: TicketSourceResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < PROJECTS_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.tickets.sources({
            organizationId: requireOrganization(scope),
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) break;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: enabled && Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The caller's top-level folders in the files browser, on one page. */
export function storageRootsQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
) {
  return queryOptions<StorageFolderPage, ApiFailure>({
    queryKey: protectedQueryKey(scope, "storageRoots.list", {}),
    queryFn: async ({ signal }) =>
      unwrap(await client.files.roots(requireOrganization(scope), signal)),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** One folder's entries, folders first and then files by name; more on demand. */
export function storageFolderEntriesQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
  folderId: string,
) {
  return infiniteQueryOptions<
    StorageFolderPage,
    ApiFailure,
    { pages: StorageFolderPage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "storageFolderEntries.list", {
      folderId,
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.files.entries(
          requireOrganization(scope),
          folderId,
          pageParam ?? undefined,
          signal,
        ),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** Every version of one file, newest first; more on demand. */
export function storageFileVersionsQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
  fileId: string,
) {
  return infiniteQueryOptions<
    StorageFileVersionPage,
    ApiFailure,
    { pages: StorageFileVersionPage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "storageFileVersions.list", { fileId }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.files.versions(
          requireOrganization(scope),
          fileId,
          pageParam ?? undefined,
          signal,
        ),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The runs and steps that read one file, newest first; more on demand. */
export function storageFileUsesQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
  fileId: string,
) {
  return infiniteQueryOptions<
    StorageFileUsePage,
    ApiFailure,
    { pages: StorageFileUsePage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "storageFileUses.list", { fileId }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.files.uses(
          requireOrganization(scope),
          fileId,
          pageParam ?? undefined,
          signal,
        ),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/**
 * The folders from the top of the tree down to the one at `path` (`/projects/web`),
 * or null when there is none. Folders are read by id, so the path is walked one
 * level at a time, matching each entry's own path.
 */
export function storageFolderChainQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
  path: string,
) {
  return queryOptions<StorageFolderItem[] | null, ApiFailure>({
    queryKey: protectedQueryKey(scope, "storageFolderChain", { path }),
    queryFn: async ({ signal }) => {
      const organizationId = requireOrganization(scope);
      const roots = unwrap(await client.files.roots(organizationId, signal));
      let current = roots.items.find((item) =>
        item.kind === "folder" &&
        (item.path === path || path.startsWith(`${item.path}/`))
      );
      if (current === undefined) return null;
      const chain: StorageFolderItem[] = [current];
      while (current.path !== path) {
        const parent: StorageFolderItem = current;
        let cursor: string | undefined;
        let next: StorageFolderItem | undefined;
        // Page all the way through the level: a real folder is never reported
        // as missing because it sorts late in a long list.
        while (next === undefined) {
          const entries = unwrap(
            await client.files.entries(
              organizationId,
              parent.id,
              cursor,
              signal,
            ),
          );
          next = entries.items.find((item) =>
            item.kind === "folder" &&
            (item.path === path || path.startsWith(`${item.path}/`))
          );
          if (entries.nextCursor === null) break;
          cursor = entries.nextCursor;
        }
        if (next === undefined) return null;
        chain.push(next);
        current = next;
      }
      return chain;
    },
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/** The hits for a files search, newest first; more on demand. */
export function fileSearchQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
  input: Omit<FileSearchInput, "cursor">,
) {
  return infiniteQueryOptions<
    FileSearchPage,
    ApiFailure,
    { pages: FileSearchPage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "files.search", {
      query: input.query ?? null,
      path: input.path ?? null,
      kind: input.kind ?? null,
      mediaGroup: input.mediaGroup ?? null,
      producerId: input.producerId ?? null,
      factKey: input.factKey ?? null,
      factValue: input.factValue ?? null,
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.files.search(
          requireOrganization(scope),
          pageParam === null ? input : { ...input, cursor: pageParam },
          signal,
        ),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/**
 * The facts the files of one kind record, for the Fact filter.
 *
 * The kind is in the key because a fact belongs to a kind: the list for one
 * kind must never answer for another.
 */
export function fileFactsQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
  kind: string,
) {
  return queryOptions<FileFactPage, ApiFailure>({
    queryKey: protectedQueryKey(scope, "files.facts", { kind }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.files.facts(requireOrganization(scope), kind, signal),
      ),
    enabled: Boolean(scope.organizationId) && kind !== "",
    staleTime: 60_000,
    retry: retryNetworkOnce,
  });
}

/**
 * The most pages a filter list reads. Each page is 100, so this is 5,000 people
 * or kinds: far past any real organization, and a bound so a server that never
 * stops answering with a cursor cannot make the page read forever.
 */
const FILTER_LIST_MAX_PAGES = 50;

/**
 * Every page of a cursor-paged list, joined into one page. Bounded by
 * FILTER_LIST_MAX_PAGES; when the bound is hit the page keeps its cursor, so
 * the cut is visible rather than silent.
 */
export async function readAllPages<
  Item,
  Page extends {
    readonly items: readonly Item[];
    readonly nextCursor: string | null;
  },
>(
  read: (cursor: string | undefined) => Promise<ApiResult<Page>>,
): Promise<
  Omit<Page, "items" | "nextCursor"> & {
    items: Item[];
    nextCursor: string | null;
  }
> {
  let first: Page | null = null;
  const items: Item[] = [];
  let cursor: string | undefined;
  let next: string | null = null;
  for (let pages = 0; pages < FILTER_LIST_MAX_PAGES; pages++) {
    const page: Page = unwrap(await read(cursor));
    first ??= page;
    items.push(...page.items);
    next = page.nextCursor;
    if (next === null) break;
    cursor = next;
  }
  // null once the last page was read; the cursor still owed when the bound cut
  // the read short.
  return { ...first!, items, nextCursor: next };
}

/** The kinds of document the organization has, by name, for the Kind filter. */
export function fileKindsQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
) {
  return queryOptions<LibraryPage, ApiFailure>({
    queryKey: protectedQueryKey(scope, "files.library", {
      path: "/library/kinds",
    }),
    // Every page of kinds, so the Kind filter can choose any of them.
    queryFn: ({ signal }) => {
      const organizationId = requireOrganization(scope);
      return readAllPages((cursor) =>
        client.files.library(organizationId, "/library/kinds", cursor, signal)
      );
    },
    enabled: Boolean(scope.organizationId),
    staleTime: 60_000,
    retry: retryNetworkOnce,
  });
}

/** One folder of the Library copy under Files, page by page. */
export function fileLibraryEntriesQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
  path: string,
) {
  return infiniteQueryOptions<
    LibraryPage,
    ApiFailure,
    { pages: LibraryPage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "files.library.folder", { path }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.files.library(
          requireOrganization(scope),
          path,
          pageParam === null ? undefined : pageParam,
          signal,
        ),
      ),
    enabled: Boolean(scope.organizationId),
    retry: retryNetworkOnce,
  });
}

/**
 * Who can have made a file: the organization's people, workers and service
 * accounts, every page of them, so the Made by filter can choose anyone.
 */
export function filePeopleQueryOptions(
  client: Pick<BakeryApiClient, "principals">,
  scope: ApiScope,
) {
  return queryOptions<PrincipalPage, ApiFailure>({
    queryKey: protectedQueryKey(scope, "files.people", {}),
    queryFn: ({ signal }) => {
      const organizationId = requireOrganization(scope);
      return readAllPages((cursor) =>
        client.principals.list({ organizationId, cursor, signal })
      );
    },
    enabled: Boolean(scope.organizationId),
    staleTime: 60_000,
    retry: retryNetworkOnce,
  });
}

/** The file one saved version belongs to: what a link to a version opens. */
export function storageFileAtVersionQueryOptions(
  client: Pick<BakeryApiClient, "files">,
  scope: ApiScope,
  versionId: string,
) {
  return queryOptions<StorageFileAtVersion, ApiFailure>({
    queryKey: protectedQueryKey(scope, "storageFiles.byVersion", { versionId }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.files.atVersion(
          requireOrganization(scope),
          versionId,
          signal,
        ),
      ),
    enabled: Boolean(scope.organizationId),
    retry: false,
    staleTime: Infinity,
  });
}

/**
 * One page of the telemetry destinations that match the search and filters,
 * with the kinds, the measurements and the providers. Further pages follow the
 * cursor, so a long list is read a page at a time. No event is sent when a
 * destination's state changes, so it reads again every 15 seconds while visible
 * and when the tab regains focus.
 */
export function telemetryDestinationsQueryOptions(
  client: Pick<BakeryApiClient, "telemetryDestinations">,
  scope: ApiScope,
  filters: Readonly<
    {
      search?: string;
      state?: string;
      kind?: string;
      provider?: string;
      limit?: number;
    }
  > = {},
) {
  const limit = filters.limit ?? 25;
  return infiniteQueryOptions<
    TelemetryDestinationList,
    ApiFailure,
    { pages: TelemetryDestinationList[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "telemetryDestinations.list", {
      search: filters.search ?? null,
      state: filters.state ?? null,
      kind: filters.kind ?? null,
      provider: filters.provider ?? null,
      limit,
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.telemetryDestinations.list({
          ...(filters.search === undefined || filters.search === ""
            ? {}
            : { search: filters.search }),
          ...(filters.state === undefined ? {} : { state: filters.state }),
          ...(filters.kind === undefined ? {} : { kind: filters.kind }),
          ...(filters.provider === undefined
            ? {}
            : { provider: filters.provider }),
          limit,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        } as TelemetryDestinationListQuery, signal),
      ),
    enabled: Boolean(scope.organizationId),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: retryNetworkOnce,
  });
}

/** One telemetry destination with its kind, its provider and the measurements. */
export function telemetryDestinationQueryOptions(
  client: Pick<BakeryApiClient, "telemetryDestinations">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<TelemetryDestinationDetail, ApiFailure>({
    queryKey: protectedQueryKey(scope, "telemetryDestinations.get", { id }),
    queryFn: async ({ signal }) =>
      unwrap(await client.telemetryDestinations.get(id, signal)),
    enabled: Boolean(scope.organizationId),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: retryNetworkOnce,
  });
}

/** A run still moving reads again this often (design-ux #75, revision 4: no event exists, so the page polls). */
export const EVALUATION_POLL_MS = 10_000;

/** Whether a run is still waiting or running, so its page keeps reading. */
export function evaluationBatchIsLive(
  state: EvaluationBatch["state"] | undefined,
): boolean {
  return state === "queued" || state === "running";
}

/** The runs of the organization, newest first, a page at a time; it reads again while any listed run is live. */
export function evaluationBatchesQueryOptions(
  client: Pick<BakeryApiClient, "listEvaluationBatches">,
  scope: ApiScope,
  limit = 25,
) {
  return infiniteQueryOptions<
    EvaluationBatchPage,
    ApiFailure,
    { pages: EvaluationBatchPage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "evaluationBatches.list", { limit }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.listEvaluationBatches({
          organizationId: requireOrganization(scope),
          cursor: pageParam ?? undefined,
          limit,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId),
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
          page.items.some((run) => evaluationBatchIsLive(run.state))
        )
        ? EVALUATION_POLL_MS
        : false,
    retry: retryNetworkOnce,
  });
}

/** One run with its counts and gate; it reads again every ten seconds while the run is live. */
export function evaluationBatchQueryOptions(
  client: Pick<BakeryApiClient, "getEvaluationBatch">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<EvaluationBatch, ApiFailure>({
    queryKey: protectedQueryKey(scope, "evaluationBatches.one", { id }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.getEvaluationBatch({
          organizationId: requireOrganization(scope),
          id,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && id !== "",
    refetchInterval: (query) =>
      evaluationBatchIsLive(query.state.data?.state)
        ? EVALUATION_POLL_MS
        : false,
    retry: retryNetworkOnce,
  });
}

/** The results of one run, optionally in one state, fifty at a time; live runs read again with their page. */
export function evaluationResultsQueryOptions(
  client: Pick<BakeryApiClient, "listEvaluationResults">,
  scope: ApiScope,
  id: string,
  state: EvaluationResultState | undefined,
  live: boolean,
  limit = 50,
  required?: boolean,
) {
  return infiniteQueryOptions<
    EvaluationBatchResultPage,
    ApiFailure,
    { pages: EvaluationBatchResultPage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "evaluationBatchResults.list", {
      id,
      state: state ?? null,
      required: required ?? null,
      limit,
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.listEvaluationResults({
          organizationId: requireOrganization(scope),
          id,
          ...(state === undefined ? {} : { state }),
          ...(required === undefined ? {} : { required }),
          cursor: pageParam ?? undefined,
          limit,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && id !== "",
    refetchInterval: live ? EVALUATION_POLL_MS : false,
    retry: retryNetworkOnce,
  });
}

/** The attempts behind one result (a few pages at most), newest first. */
export function evaluationAttemptsQueryOptions(
  client: Pick<BakeryApiClient, "listEvaluationAttempts">,
  scope: ApiScope,
  id: string,
) {
  return queryOptions<EvaluationAttempt[], ApiFailure>({
    queryKey: protectedQueryKey(scope, "evaluationAttempts.list", { id }),
    queryFn: async ({ signal }) => {
      const items: EvaluationAttempt[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listEvaluationAttempts({
            organizationId: requireOrganization(scope),
            id,
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items);
        if (read.nextCursor === null) return items;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: Boolean(scope.organizationId) && id !== "",
    retry: retryNetworkOnce,
  });
}

/** How many people one page of the mention picker holds (design-ux #73: ten rows, more on scroll). */
export const MENTION_PAGE = 10;

/** The people the writer may mention, as they type: ten a page, never cached for long. */
export function mentionCandidatesQueryOptions(
  client: Pick<BakeryApiClient, "listMentionCandidates">,
  scope: ApiScope,
  source: MentionSource,
  text: string,
) {
  return infiniteQueryOptions<
    MentionCandidatePage,
    ApiFailure,
    { pages: MentionCandidatePage[]; pageParams: (string | null)[] },
    ReturnType<typeof protectedQueryKey>,
    string | null
  >({
    queryKey: protectedQueryKey(scope, "mentionCandidates.list", {
      kind: source.kind,
      id: source.id,
      text,
    }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await client.listMentionCandidates({
          organizationId: requireOrganization(scope),
          source,
          query: text,
          cursor: pageParam ?? undefined,
          limit: MENTION_PAGE,
          signal,
        }),
      ),
    enabled: Boolean(scope.organizationId) && source.id !== "",
    gcTime: 30_000,
    staleTime: 0,
    retry: false,
  });
}

/** Who can give access to one conversation (up to three people), read only while a writer who may not share needs them. */
export function conversationSharersQueryOptions(
  client: Pick<BakeryApiClient, "listConversationSharers">,
  scope: ApiScope,
  conversationId: string,
  enabled: boolean,
) {
  return queryOptions<ConversationSharers, ApiFailure>({
    queryKey: protectedQueryKey(scope, "conversationAccess.sharers", {
      conversationId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listConversationSharers({
          organizationId: requireOrganization(scope),
          conversationId,
          signal,
        }),
      ),
    enabled: enabled && Boolean(scope.organizationId) && conversationId !== "",
    staleTime: 30_000,
    retry: retryNetworkOnce,
  });
}

/** The people one conversation was opened to by a mention (a few pages at most), live grants only. */
export function conversationAccessQueryOptions(
  client: Pick<BakeryApiClient, "listConversationAccess">,
  scope: ApiScope,
  conversationId: string,
) {
  return queryOptions<ConversationAccessGrant[], ApiFailure>({
    queryKey: protectedQueryKey(scope, "conversationAccess.list", {
      conversationId,
    }),
    queryFn: async ({ signal }) => {
      const items: ConversationAccessGrant[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listConversationAccess({
            organizationId: requireOrganization(scope),
            conversationId,
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items.filter((grant) => grant.revokedAt === null));
        if (read.nextCursor === null) return items;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: Boolean(scope.organizationId) && conversationId !== "",
    retry: retryNetworkOnce,
  });
}

/** Who can give access to one document (up to three people), read only while a writer who may not share needs them. */
export function artifactSharersQueryOptions(
  client: Pick<BakeryApiClient, "listArtifactSharers">,
  scope: ApiScope,
  artifactId: string,
  enabled: boolean,
) {
  return queryOptions<ArtifactSharers, ApiFailure>({
    queryKey: protectedQueryKey(scope, "artifactAccess.sharers", {
      artifactId,
    }),
    queryFn: async ({ signal }) =>
      unwrap(
        await client.listArtifactSharers({
          organizationId: requireOrganization(scope),
          artifactId,
          signal,
        }),
      ),
    enabled: enabled && Boolean(scope.organizationId) && artifactId !== "",
    staleTime: 30_000,
    retry: retryNetworkOnce,
  });
}

/** The people one document was opened to directly (a few pages at most), live grants only. */
export function artifactAccessQueryOptions(
  client: Pick<BakeryApiClient, "listArtifactAccess">,
  scope: ApiScope,
  artifactId: string,
) {
  return queryOptions<ArtifactAccessGrant[], ApiFailure>({
    queryKey: protectedQueryKey(scope, "artifactAccess.list", { artifactId }),
    queryFn: async ({ signal }) => {
      const items: ArtifactAccessGrant[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < LIBRARY_COLLECTION_PAGES; page += 1) {
        const read = unwrap(
          await client.listArtifactAccess({
            organizationId: requireOrganization(scope),
            artifactId,
            cursor,
            limit: 100,
            signal,
          }),
        );
        items.push(...read.items.filter((grant) => grant.revokedAt === null));
        if (read.nextCursor === null) return items;
        cursor = read.nextCursor;
      }
      return items;
    },
    enabled: Boolean(scope.organizationId) && artifactId !== "",
    retry: retryNetworkOnce,
  });
}
