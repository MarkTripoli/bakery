import { assertEquals } from "@std/assert";
import type {
  ApiFailure,
  ApiResult,
  AuthProblemCode,
  BakeryApiClient,
  PrincipalIdentity,
  SafeProblem,
} from "../../apps/web/src/api/client.ts";
import type { AuthProviderClient } from "../../packages/contracts/src/auth-provider-client.ts";
import {
  protectedQueryKey,
  QueryClient,
  QueryScopeController,
} from "../../apps/web/src/app/query-scope.ts";
import { SessionController } from "../../apps/web/src/app/session.ts";
import {
  clear,
  ORGANIZATION_PREFERENCE_KEY,
  remember,
} from "../../apps/web/src/app/organization-selection.ts";

function identityOf(principalId: string): PrincipalIdentity {
  return {
    principalId,
    principalType: "human",
    displayName: `Principal ${principalId}`,
    locale: "en",
    timeZone: null,
    direction: "ltr",
    catalogVersion: "v1",
    twoFactorEnabled: false,
    email: `principal-${principalId}@example.test`,
    backupCodesRemaining: null,
  };
}

function okIdentity(identity: PrincipalIdentity): ApiResult<PrincipalIdentity> {
  return { ok: true, data: identity };
}

function failIdentity(error: ApiFailure): ApiResult<PrincipalIdentity> {
  return { ok: false, error };
}

function authFailure(code: AuthProblemCode): ApiFailure {
  const problem: SafeProblem = {
    type: "https://bakery.example/problems/test",
    title: code,
    status: 401,
    code,
    retryable: false,
    detail: "test failure",
    requestId: "00000000-0000-4000-8000-000000000001",
    traceId: "00000000-0000-4000-8000-000000000002",
  };
  return { kind: "problem", problem };
}

const NETWORK_FAILURE: ApiFailure = { kind: "network" };

function rejecting(): Promise<never> {
  return Promise.reject(new Error("not stubbed for this test"));
}

function rejectingAuth(
  signOut: AuthProviderClient["signOut"] = () => Promise.resolve(),
): AuthProviderClient {
  return {
    signInEmail: rejecting,
    signUpEmail: rejecting,
    signOut,
    twoFactor: {
      verifyTotp: rejecting,
      verifyBackupCode: rejecting,
      enable: rejecting,
      generateBackupCodes: rejecting,
      disable: rejecting,
    },
    changePassword: rejecting,
    reauthenticate: rejecting,
    passkey: {
      generateRegisterOptions: rejecting,
      verifyRegistration: rejecting,
      listUserPasskeys: rejecting,
      updatePasskey: rejecting,
      deletePasskey: rejecting,
    },
  };
}

function fakeApi(
  identity: BakeryApiClient["identity"],
  signOut?: AuthProviderClient["signOut"],
): BakeryApiClient {
  return {
    readiness: rejecting,
    identity,
    installationStatus: rejecting,
    listOrganizations: rejecting,
    files: {
      roots: rejecting,
      entries: rejecting,
      versions: rejecting,
      uses: rejecting,
      atVersion: rejecting,
      library: rejecting,
      search: rejecting,
      content: rejecting,
      probe: rejecting,
      mediaUrl: () => "",
      facts: rejecting,
    },
    invitations: {
      preview: rejecting,
      recipientGet: rejecting,
      recipientAccept: rejecting,
      recipientReject: rejecting,
    },
    browserSessions: {
      list: rejecting,
      revoke: rejecting,
      revokeOthers: rejecting,
    },
    connectedClients: { list: rejecting, revoke: rejecting },
    access: {} as BakeryApiClient["access"],
    profile: { get: rejecting, update: rejecting },
    userPreferences: { get: rejecting, update: rejecting },
    plugins: {
      packages: rejecting,
      versions: rejecting,
      installs: rejecting,
      pages: rejecting,
      page: rejecting,
      install: rejecting,
      update: rejecting,
      savedData: rejecting,
    },
    previews: {
      availability: rejecting,
      list: rejecting,
      access: rejecting,
      stop: rejecting,
    },
    batches: {
      list: rejecting,
      startable: rejecting,
      get: rejecting,
      create: rejecting,
      control: rejecting,
      stop: rejecting,
    },
    tickets: {
      get: rejecting,
      check: rejecting,
      request: rejecting,
      list: rejecting,
      sources: rejecting,
      createSource: rejecting,
      updateSource: rejecting,
      source: rejecting,
      preview: rejecting,
      lookupPerson: rejecting,
      sync: rejecting,
      links: rejecting,
      requests: rejecting,
      labels: rejecting,
      resyncNote: rejecting,
      routingRules: rejecting,
      replaceRoutingRules: rejecting,
    },
    workers: {
      list: rejecting,
      get: rejecting,
      enroll: rejecting,
      repairEnrollment: rejecting,
      update: rejecting,
      revoke: rejecting,
    },
    machines: { dispatchBlockers: rejecting },
    workerEnrollments: {
      list: rejecting,
      get: rejecting,
      cancel: rejecting,
      replace: rejecting,
    },
    workerComponents: { list: rejecting },
    workerProviderBindings: { list: rejecting, create: rejecting },
    workerProviderAuth: {
      create: rejecting,
      get: rejecting,
      cancel: rejecting,
    },
    organizations: {
      get: rejecting,
      effectiveAccess: rejecting,
      update: rejecting,
    },
    installationCapabilities: { get: rejecting },
    telemetryDestinations: {
      list: rejecting,
      get: rejecting,
      create: rejecting,
      update: rejecting,
      remove: rejecting,
      test: rejecting,
    },
    installationRestore: { get: rejecting, step: rejecting },
    installationUpdates: {
      status: rejecting,
      list: rejecting,
      dismiss: rejecting,
    },
    installationUncertainActions: { get: rejecting },
    installationSettings: { get: rejecting, update: rejecting },
    storageSettings: { get: rejecting, put: rejecting },
    usage: { list: rejecting },
    metrics: { get: rejecting, sources: rejecting },
    integrationClientCredentials: { get: rejecting, put: rejecting },
    integrationAppRegistrations: {
      get: rejecting,
      begin: rejecting,
      put: rejecting,
    },
    skillStorage: { get: rejecting, put: rejecting, verify: rejecting },
    integrationConnections: {
      get: rejecting,
      list: rejecting,
      update: rejecting,
      check: rejecting,
    },
    integrationResources: { list: rejecting, update: rejecting },
    integrationAuthAttempts: { create: rejecting },
    scimConnection: {
      get: rejecting,
      create: rejecting,
      rotate: rejecting,
      revoke: rejecting,
    },
    auditEvents: { list: rejecting, export: rejecting },
    auditRetention: { get: rejecting, update: rejecting },
    installationAuditEvents: { list: rejecting },
    organizationRoles: {
      list: rejecting,
      create: rejecting,
      update: rejecting,
      delete: rejecting,
      assign: rejecting,
      unassign: rejecting,
    },
    principals: { list: rejecting },
    auth: rejectingAuth(signOut),
    output: {
      attempts: rejecting,
      list: rejecting,
      read: rejecting,
      socketUrl: () => {
        throw new Error("not stubbed for this test");
      },
    },
    sessions: { list: rejecting, feed: rejecting, stream: rejecting },
    getArtifactStorage: rejecting,
    getArtifactPreviewAvailability: rejecting,
    createArtifactPreview: rejecting,
    revokeArtifactPreview: rejecting,
    listArtifactComments: rejecting,
    listArtifactCommentsAcrossVersions: rejecting,
    createArtifactComment: rejecting,
    updateArtifactComment: rejecting,
    updateArtifact: rejecting,
    openArtifactDraft: rejecting,
    getDraft: rejecting,
    publishDraft: rejecting,
    getDraftPublication: rejecting,
    listDraftSuggestions: rejecting,
    acceptDraftSuggestion: rejecting,
    rejectDraftSuggestion: rejecting,
    collaborationSocketUrl: () => "ws://127.0.0.1/v1/collaboration",
    createMessage: rejecting,
    listMessages: rejecting,
    listConversationTurns: rejecting,
    cancelConversationTurn: rejecting,
    listPlanRevisions: rejecting,
    listApprovals: rejecting,
    decideApproval: rejecting,
    listConversationParticipants: rejecting,
    listCoordinationPlans: rejecting,
    cancelCoordinationPlan: rejecting,
    listTaskRepositories: rejecting,
    listApplicationRepositoryRoles: rejecting,
    listQuestions: rejecting,
    answerQuestion: rejecting,
    updateTask: rejecting,
    listArtifacts: rejecting,
    getArtifact: rejecting,
    listArtifactVersions: rejecting,
    getArtifactContent: rejecting,
    importArtifactVersion: rejecting,
    extractArtifactVersion: rejecting,
    readArtifactProbe: rejecting,
    listTasks: rejecting,
    getTask: rejecting,
    createTask: rejecting,
    // The notification reads and writes belong to the same client surface as
    // the other task calls; a fake that omits them stops type-checking the
    // moment the real client gains them.
    listNotifications: rejecting,
    notificationCount: rejecting,
    resolveNotificationTarget: rejecting,
    setNotificationRead: rejecting,
    markAllNotificationsRead: rejecting,
    createRun: rejecting,
    listRuns: rejecting,
    controlRun: rejecting,
    getRun: rejecting,
    getRunControlCapabilities: rejecting,
    listRouteContinuations: rejecting,
    admitRouteContinuation: rejecting,
    listRunSteps: rejecting,
    listRunChecks: rejecting,
    listRunReviews: rejecting,
    listReviewFindings: rejecting,
    listRunDeliveryDecisions: rejecting,
    listPullRequests: rejecting,
    listMergeAttempts: rejecting,
    listMergeEntries: rejecting,
    createMergeEntry: rejecting,
    mergePullRequest: rejecting,
    reconcileMergeAttempts: rejecting,
    sync: rejecting,
    listApplications: rejecting,
    createApplication: rejecting,
    getApplication: rejecting,
    updateApplication: rejecting,
    listRepositories: rejecting,
    getRepository: rejecting,
    createRepository: rejecting,
    updateRepository: rejecting,
    listRepositoryRoles: rejecting,
    createRepositoryRole: rejecting,
    updateRepositoryRole: rejecting,
    resolveRepositoryRole: rejecting,
    getOrganizationRepositoryRules: rejecting,
    getRepositoryEffectiveRules: rejecting,
    listOrganizationRepositoryRuleVersions: rejecting,
    previewOrganizationRepositoryRules: rejecting,
    publishOrganizationRepositoryRules: rejecting,
    listRepositoryProfiles: rejecting,
    createRepositoryProfile: rejecting,
    startRepositoryOnboarding: rejecting,
    getRepositoryOnboarding: rejecting,
    getRepositoryProfileObservation: rejecting,
    listWorkflowPresets: rejecting,
    getWorkflow: rejecting,
    listWorkflows: rejecting,
    listAgents: rejecting,
    listMemories: rejecting,
    getMemory: rejecting,
    listMemoryRevisions: rejecting,
    listMentionCandidates: rejecting,
    listConversationAccess: rejecting,
    listConversationSharers: rejecting,
    revokeConversationAccess: rejecting,
    listArtifactAccess: rejecting,
    listArtifactSharers: rejecting,
    grantArtifactAccess: rejecting,
    revokeArtifactAccess: rejecting,
    listEvaluationBatches: rejecting,
    getEvaluationBatch: rejecting,
    cancelEvaluationBatch: rejecting,
    listEvaluationResults: rejecting,
    listEvaluationAttempts: rejecting,
    updateMemory: rejecting,
    createMemoryRevision: rejecting,
    listSkills: rejecting,
    getSkill: rejecting,
    listSkillVersions: rejecting,
    listSkillUsedBy: rejecting,
    listSkillUseGrants: rejecting,
    getSkillSource: rejecting,
    listWorkflowVersions: rejecting,
    listWorkflowVersionSkills: rejecting,
    activateWorkflowVersion: rejecting,
    updateWorkflow: rejecting,
    listAgentVersions: rejecting,
    getAgent: rejecting,
    activateAgentVersion: rejecting,
    updateAgent: rejecting,
    createWorkflow: rejecting,
    createWorkflowVersion: rejecting,
    updateWorkflowVersion: rejecting,
    publishWorkflowVersion: rejecting,
    validateWorkflow: rejecting,
  };
}

Deno.test("refresh maps every auth code and keeps the snapshot on a non-auth failure", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  let identity: BakeryApiClient["identity"] = () =>
    Promise.resolve(okIdentity(identityOf("p-1")));
  const controller = new SessionController(
    fakeApi((signal) => identity(signal)),
    queryScope,
  );

  await controller.refresh();
  assertEquals(controller.getSnapshot(), {
    status: "authenticated",
    identity: identityOf("p-1"),
  });

  identity = () => Promise.resolve(failIdentity(authFailure("AUTH_REQUIRED")));
  await controller.refresh();
  assertEquals(controller.getSnapshot(), {
    status: "anonymous",
    identity: null,
  });

  identity = () =>
    Promise.resolve(failIdentity(authFailure("AUTH_FACTOR_REQUIRED")));
  await controller.refresh();
  assertEquals(controller.getSnapshot(), {
    status: "factor-pending",
    identity: null,
  });

  identity = () => Promise.resolve(failIdentity(authFailure("AUTH_INVALID")));
  await controller.refresh();
  assertEquals(controller.getSnapshot(), {
    status: "expired",
    identity: null,
  });

  identity = () => Promise.resolve(failIdentity(authFailure("AUTH_EXPIRED")));
  await controller.refresh();
  assertEquals(controller.getSnapshot(), {
    status: "expired",
    identity: null,
  });

  identity = () => Promise.resolve(failIdentity(authFailure("AUTH_FORBIDDEN")));
  await controller.refresh();
  assertEquals(controller.getSnapshot(), {
    status: "forbidden",
    identity: null,
  });

  // A transport failure must not erase the last known (forbidden) snapshot.
  identity = () => Promise.resolve(failIdentity(NETWORK_FAILURE));
  await controller.refresh();
  assertEquals(controller.getSnapshot(), {
    status: "forbidden",
    identity: null,
  });
});

Deno.test("refreshForContinuation marks an unclassified identity result indeterminate without replacing the stale snapshot", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  let identity: BakeryApiClient["identity"] = () =>
    Promise.resolve(failIdentity(authFailure("AUTH_FACTOR_REQUIRED")));
  const controller = new SessionController(
    fakeApi((signal) => identity(signal)),
    queryScope,
  );

  await controller.refresh();
  identity = () => Promise.resolve(failIdentity(NETWORK_FAILURE));

  const result = await controller.refreshForContinuation();

  assertEquals(result, {
    freshness: "indeterminate",
    snapshot: { status: "factor-pending", identity: null },
  });
  assertEquals(controller.getSnapshot(), result.snapshot);
});

Deno.test("refresh resets the protected scope when the authenticated principal changes across an expiry", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  let identity: BakeryApiClient["identity"] = () =>
    Promise.resolve(okIdentity(identityOf("p-1")));
  const controller = new SessionController(
    fakeApi((signal) => identity(signal)),
    queryScope,
  );

  await controller.refresh();
  const generationAfterP1 = queryScope.getSnapshot().sessionGeneration;

  identity = () => Promise.resolve(failIdentity(authFailure("AUTH_EXPIRED")));
  await controller.refresh();
  const generationAfterExpiry = queryScope.getSnapshot().sessionGeneration;
  assertEquals(generationAfterExpiry, generationAfterP1 + 1);

  identity = () => Promise.resolve(okIdentity(identityOf("p-2")));
  await controller.refresh();
  assertEquals(
    queryScope.getSnapshot().sessionGeneration,
    generationAfterExpiry + 1,
  );
});

Deno.test("refresh resets the protected scope when an identity-only failure is followed by a different principal's sign-in", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  let identity: BakeryApiClient["identity"] = () =>
    Promise.resolve(failIdentity(authFailure("AUTH_EXPIRED")));
  const controller = new SessionController(
    fakeApi((signal) => identity(signal)),
    queryScope,
  );

  const generationBefore = queryScope.getSnapshot().sessionGeneration;
  await controller.refresh();
  assertEquals(controller.getSnapshot(), { status: "expired", identity: null });

  identity = () => Promise.resolve(okIdentity(identityOf("p-2")));
  await controller.refresh();

  assertEquals(
    queryScope.getSnapshot().sessionGeneration > generationBefore,
    true,
  );
});

Deno.test("refresh resets the protected scope on the first authenticated principal, even with no prior principal recorded", async () => {
  const queryClient = new QueryClient();
  const queryScope = new QueryScopeController(queryClient);
  let identity: BakeryApiClient["identity"] = () =>
    Promise.resolve(failIdentity(NETWORK_FAILURE));
  const controller = new SessionController(
    fakeApi((signal) => identity(signal)),
    queryScope,
  );

  await controller.refresh();
  assertEquals(controller.getSnapshot(), {
    status: "unknown",
    identity: null,
  });
  const generationBefore = queryScope.getSnapshot().sessionGeneration;
  const key = protectedQueryKey(queryScope.getSnapshot(), "tasks.list", {});
  queryClient.setQueryData(key, { items: [] });

  identity = () => Promise.resolve(okIdentity(identityOf("p-2")));
  await controller.refresh();

  // A restored `#lastAuthenticatedPrincipalId !== null && ...` guard would
  // treat this as "no prior principal, nothing to protect" and skip the
  // reset — this row fails against that guard.
  assertEquals(
    queryScope.getSnapshot().sessionGeneration,
    generationBefore + 1,
  );
  assertEquals(queryClient.getQueryData(key), undefined);
});

Deno.test("refresh does not reset the protected scope when the principal is unchanged", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  const controller = new SessionController(
    fakeApi(() => Promise.resolve(okIdentity(identityOf("p-1")))),
    queryScope,
  );

  await controller.refresh();
  const generationAfterFirst = queryScope.getSnapshot().sessionGeneration;
  await controller.refresh();
  assertEquals(
    queryScope.getSnapshot().sessionGeneration,
    generationAfterFirst,
  );
});

Deno.test("signOut wins the race against a slower in-flight refresh", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  let resolveIdentity!: (value: ApiResult<PrincipalIdentity>) => void;
  const pending = new Promise<ApiResult<PrincipalIdentity>>((resolve) => {
    resolveIdentity = resolve;
  });
  const controller = new SessionController(fakeApi(() => pending), queryScope);

  const refreshing = controller.refresh();
  await controller.signOut();
  assertEquals(controller.getSnapshot(), {
    status: "anonymous",
    identity: null,
  });

  resolveIdentity(okIdentity(identityOf("p-1")));
  await refreshing;
  assertEquals(controller.getSnapshot(), {
    status: "anonymous",
    identity: null,
  });
});

Deno.test("signOut wins the race against a refresh started during its own pending provider call", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  let resolveSignOut!: () => void;
  const signOutPending = new Promise<void>((resolve) => {
    resolveSignOut = resolve;
  });
  let resolveIdentity!: (value: ApiResult<PrincipalIdentity>) => void;
  const identityPending = new Promise<ApiResult<PrincipalIdentity>>(
    (resolve) => {
      resolveIdentity = resolve;
    },
  );
  const controller = new SessionController(
    fakeApi(() => identityPending, () => signOutPending),
    queryScope,
  );

  const signingOut = controller.signOut();
  const refreshing = controller.refresh();

  resolveSignOut();
  await signingOut;
  assertEquals(controller.getSnapshot(), {
    status: "anonymous",
    identity: null,
  });

  resolveIdentity(okIdentity(identityOf("p-1")));
  await refreshing;
  assertEquals(controller.getSnapshot(), {
    status: "anonymous",
    identity: null,
  });
});

Deno.test("refresh does not publish when aborted while the identity call is in flight", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  let resolveIdentity!: (value: ApiResult<PrincipalIdentity>) => void;
  const pending = new Promise<ApiResult<PrincipalIdentity>>((resolve) => {
    resolveIdentity = resolve;
  });
  const controller = new SessionController(fakeApi(() => pending), queryScope);
  const abortController = new AbortController();

  const refreshing = controller.refresh(abortController.signal);
  abortController.abort();
  resolveIdentity(okIdentity(identityOf("p-1")));
  const snapshot = await refreshing;

  assertEquals(snapshot, { status: "unknown", identity: null });
  assertEquals(controller.getSnapshot(), { status: "unknown", identity: null });
});

Deno.test("signOut resets scope and clears the organization preference before publishing anonymous, even when the provider call rejects", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  const controller = new SessionController(
    fakeApi(
      () => Promise.resolve(okIdentity(identityOf("p-1"))),
      () => Promise.reject(new Error("provider unreachable")),
    ),
    queryScope,
  );
  await controller.refresh();
  const generationBeforeSignOut = queryScope.getSnapshot().sessionGeneration;
  remember("org-x");

  const observedAtPublish: Array<
    { generation: number; preference: string | null }
  > = [];
  controller.subscribe(() => {
    observedAtPublish.push({
      generation: queryScope.getSnapshot().sessionGeneration,
      preference: globalThis.localStorage.getItem(
        ORGANIZATION_PREFERENCE_KEY,
      ),
    });
  });

  try {
    await controller.signOut();

    assertEquals(controller.getSnapshot(), {
      status: "anonymous",
      identity: null,
    });
    assertEquals(observedAtPublish.length, 1);
    assertEquals(
      observedAtPublish[0].generation > generationBeforeSignOut,
      true,
    );
    assertEquals(observedAtPublish[0].preference, null);
  } finally {
    clear();
  }
});

Deno.test("reset drops every protected query and advances the generation", () => {
  const queryClient = new QueryClient();
  const queryScope = new QueryScopeController(queryClient);
  const key = protectedQueryKey(queryScope.getSnapshot(), "tasks.list", {
    cursor: null,
  });
  queryClient.setQueryData(key, { items: [] });
  assertEquals(queryClient.getQueryData(key) !== undefined, true);

  const generationBefore = queryScope.getSnapshot().sessionGeneration;
  const futureKey = protectedQueryKey(
    { sessionGeneration: generationBefore + 5, organizationId: "org-z" },
    "tasks.list",
    {},
  );
  queryClient.setQueryData(futureKey, { items: [] });
  assertEquals(queryClient.getQueryData(futureKey) !== undefined, true);

  queryScope.reset();

  assertEquals(queryClient.getQueryData(key), undefined);
  assertEquals(queryClient.getQueryData(futureKey), undefined);
  assertEquals(
    queryScope.getSnapshot().sessionGeneration > generationBefore,
    true,
  );
});

Deno.test("a different principal signing in never inherits the remembered organization", async () => {
  const queryScope = new QueryScopeController(new QueryClient());
  let identity: BakeryApiClient["identity"] = () =>
    Promise.resolve(okIdentity(identityOf("p-1")));
  const controller = new SessionController(
    fakeApi((signal) => identity(signal)),
    queryScope,
  );
  try {
    // First sign-in after a page load keeps the remembered choice.
    remember("org-first");
    await controller.refresh();
    assertEquals(
      globalThis.localStorage.getItem(ORGANIZATION_PREFERENCE_KEY),
      "org-first",
    );

    // The session lapses, then another person signs in on this browser.
    identity = () =>
      Promise.resolve(failIdentity(authFailure("AUTH_REQUIRED")));
    await controller.refresh();
    identity = () => Promise.resolve(okIdentity(identityOf("p-2")));
    await controller.refresh();
    assertEquals(
      globalThis.localStorage.getItem(ORGANIZATION_PREFERENCE_KEY),
      null,
    );
  } finally {
    clear();
  }
});
