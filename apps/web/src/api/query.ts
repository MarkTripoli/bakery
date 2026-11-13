import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  ApiFailure,
  ApiResult,
  ApplicationListResponse,
  ApplicationRepositoryRoleListResponse,
  ApplicationResponse,
  ApprovalListResponse,
  ArtifactCommentListResponse,
  ArtifactCommentQuery,
  ArtifactCursorQuery,
  ArtifactExtractionResponse,
  ArtifactExtractQuery,
  ArtifactListResponse,
  ArtifactPreviewAvailabilityResponse,
  ArtifactQuery,
  ArtifactResponse,
  ArtifactStorageResponse,
  ArtifactVersionListResponse,
  BakeryApiClient,
  BrowserSessionList,
  CheckRunListResponse,
  ConnectedClientList,
  ConversationParticipantListResponse,
  ConversationTurnListResponse,
  CoordinationPlanListResponse,
  DeliveryDecisionListResponse,
  DispatchBlockersResponse,
  EffectiveAccess,
  EnrollmentStatus,
  InstallationCapabilities,
  InstallationSettings,
  InstallationStatus,
  IntegrationAppRegistration,
  MessageListResponse,
  OrganizationAccessPage,
  OrganizationInvitationPreview,
  OrganizationInvitationRecipient,
  OrganizationRecord,
  OrganizationRepositoryRuleEntries,
  OrganizationRepositoryRulePreviewResponse,
  OrganizationRepositoryRulesResponse,
  OrganizationRepositoryRuleVersionListResponse,
  PlanRevisionListResponse,
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
  RunControlCapabilities,
  RunListResponse,
  RunResponse,
  RunStepListResponse,
  ScimConnection,
  SkillStorageSettings,
  SyncQuery,
  SyncResponse,
  TaskCursorQuery,
  TaskListResponse,
  TaskRepositoryListResponse,
  TaskResponse,
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
