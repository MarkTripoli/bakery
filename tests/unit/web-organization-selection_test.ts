import { assertEquals, assertRejects } from "@std/assert";
import type {
  BakeryApiClient,
  OrganizationAccess,
  OrganizationAccessPage,
} from "../../apps/web/src/api/client.ts";
import {
  QueryClient,
  QueryScopeController,
} from "../../apps/web/src/app/query-scope.ts";
import {
  clear,
  handleForbidden,
  ORGANIZATION_PREFERENCE_KEY,
  remember,
  resolve,
  restore,
} from "../../apps/web/src/app/organization-selection.ts";

function recordingStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
    getItem(key: string): string | null {
      return entries.get(key) ?? null;
    },
  };
}

function membershipOf(id: string): OrganizationAccess {
  return {
    id,
    name: `Organization ${id}`,
    slug: id,
    logo: null,
    metadata: null,
    defaultLocale: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    version: 1,
    role: "admin",
  };
}

function rejecting(): Promise<never> {
  return Promise.reject(new Error("not stubbed for this test"));
}

/** A fake facade whose `listOrganizations` walks the given cursor pages. */
function fakeApi(
  pages: readonly (readonly OrganizationAccess[])[],
): BakeryApiClient {
  return {
    readiness: rejecting,
    identity: rejecting,
    installationStatus: rejecting,
    listOrganizations(cursor) {
      const index = cursor === undefined ? 0 : Number(cursor);
      const items = pages[index] ?? [];
      const nextCursor = index + 1 < pages.length ? String(index + 1) : null;
      const page: OrganizationAccessPage = { items: [...items], nextCursor };
      return Promise.resolve({ ok: true, data: page });
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
    workers: {
      list: rejecting,
      get: rejecting,
      enroll: rejecting,
      repairEnrollment: rejecting,
    },
    machines: { dispatchBlockers: rejecting },
    workerEnrollments: {
      list: rejecting,
      get: rejecting,
      cancel: rejecting,
      replace: rejecting,
    },
    workerComponents: { list: rejecting },
    workerProviderBindings: { list: rejecting },
    workerProviderAuth: { create: rejecting, get: rejecting },
    organizations: {
      get: rejecting,
      effectiveAccess: rejecting,
      update: rejecting,
    },
    installationCapabilities: { get: rejecting },
    installationSettings: { get: rejecting, update: rejecting },
    integrationAppRegistrations: {
      get: rejecting,
      begin: rejecting,
      put: rejecting,
    },
    skillStorage: { get: rejecting, put: rejecting, verify: rejecting },
    integrationConnections: {
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
    auth: {
      signInEmail: rejecting,
      signUpEmail: rejecting,
      signOut: rejecting,
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
    },
    output: {
      attempts: rejecting,
      list: rejecting,
      read: rejecting,
      socketUrl: () => {
        throw new Error("not stubbed for this test");
      },
    },
    getArtifactStorage: rejecting,
    getArtifactPreviewAvailability: rejecting,
    createArtifactPreview: rejecting,
    revokeArtifactPreview: rejecting,
    listArtifactComments: rejecting,
    listArtifactCommentsAcrossVersions: rejecting,
    createArtifactComment: rejecting,
    updateArtifactComment: rejecting,
    updateArtifact: rejecting,
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
    listTasks: rejecting,
    getTask: rejecting,
    createTask: rejecting,
    createRun: rejecting,
    listRuns: rejecting,
    controlRun: rejecting,
    getRun: rejecting,
    getRunControlCapabilities: rejecting,
    listRunSteps: rejecting,
    listRunChecks: rejecting,
    listRunReviews: rejecting,
    listReviewFindings: rejecting,
    listRunDeliveryDecisions: rejecting,
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
  };
}

Deno.test("resolve selects a remembered id found on a later cursor page", async () => {
  const storage = recordingStorage();
  storage.entries.set(ORGANIZATION_PREFERENCE_KEY, "org-b");
  const queryScope = new QueryScopeController(new QueryClient());
  const api = fakeApi([[membershipOf("org-a")], [
    membershipOf("org-b"),
    membershipOf("org-c"),
  ]]);

  const outcome = await resolve(api, queryScope, storage);

  assertEquals(outcome, "selected");
  assertEquals(queryScope.getSnapshot().organizationId, "org-b");
});

Deno.test("resolve auto-selects and remembers a sole membership", async () => {
  const storage = recordingStorage();
  const queryScope = new QueryScopeController(new QueryClient());
  const api = fakeApi([[membershipOf("org-only")]]);

  const outcome = await resolve(api, queryScope, storage);

  assertEquals(outcome, "selected");
  assertEquals(queryScope.getSnapshot().organizationId, "org-only");
  assertEquals(
    storage.entries.get(ORGANIZATION_PREFERENCE_KEY),
    "org-only",
  );
});

Deno.test("resolve asks the principal to choose among multiple memberships", async () => {
  const storage = recordingStorage();
  const queryScope = new QueryScopeController(new QueryClient());
  const api = fakeApi([[membershipOf("org-a"), membershipOf("org-b")]]);

  const outcome = await resolve(api, queryScope, storage);

  assertEquals(outcome, "choose");
  assertEquals(queryScope.getSnapshot().organizationId, null);
});

Deno.test("resolve asks the principal to choose when the remembered id is not a live membership", async () => {
  const storage = recordingStorage();
  storage.entries.set(ORGANIZATION_PREFERENCE_KEY, "org-gone");
  const queryScope = new QueryScopeController(new QueryClient());
  const api = fakeApi([[membershipOf("org-a"), membershipOf("org-b")]]);

  const outcome = await resolve(api, queryScope, storage);

  assertEquals(outcome, "choose");
  assertEquals(queryScope.getSnapshot().organizationId, null);
});

Deno.test("resolve propagates a listOrganizations failure instead of choosing", async () => {
  const storage = recordingStorage();
  const queryScope = new QueryScopeController(new QueryClient());
  const api: BakeryApiClient = {
    ...fakeApi([]),
    listOrganizations() {
      return Promise.resolve({ ok: false, error: { kind: "network" } });
    },
  };

  const error = await assertRejects(() => resolve(api, queryScope, storage));

  assertEquals(error, { kind: "network" });
  assertEquals(queryScope.getSnapshot().organizationId, null);
});

Deno.test("resolve does not mutate scope after cancellation", async () => {
  const storage = recordingStorage();
  const queryScope = new QueryScopeController(new QueryClient());
  const controller = new AbortController();
  const api: BakeryApiClient = {
    ...fakeApi([]),
    listOrganizations(_cursor, signal) {
      const { promise, resolve: resolvePage } = Promise.withResolvers<{
        readonly ok: true;
        readonly data: OrganizationAccessPage;
      }>();
      signal?.addEventListener(
        "abort",
        () =>
          resolvePage({
            ok: true,
            data: { items: [membershipOf("org-only")], nextCursor: null },
          }),
        { once: true },
      );
      return promise;
    },
  };
  const resolving = resolve(
    api,
    queryScope,
    storage,
    controller.signal,
  );
  controller.abort();

  await assertRejects(() => resolving);
  assertEquals(queryScope.getSnapshot().organizationId, null);
});

Deno.test("handleForbidden forgets the remembered organization and clears the scoped identity", () => {
  const queryScope = new QueryScopeController(new QueryClient());
  try {
    remember("org-a");
    queryScope.setIdentity("org-a");

    handleForbidden(queryScope);

    assertEquals(
      globalThis.localStorage.getItem(ORGANIZATION_PREFERENCE_KEY),
      null,
    );
    assertEquals(queryScope.getSnapshot().organizationId, null);
  } finally {
    clear();
  }
});

for (const replacement of ["session", "tenant"] as const) {
  Deno.test(`resolve refuses a late membership after ${replacement} replacement`, async () => {
    const storage = recordingStorage();
    const queryScope = new QueryScopeController(new QueryClient());
    const pending = Promise.withResolvers<{
      readonly ok: true;
      readonly data: OrganizationAccessPage;
    }>();
    const api: BakeryApiClient = {
      ...fakeApi([]),
      listOrganizations: () => pending.promise,
    };
    const resolving = resolve(api, queryScope, storage);
    if (replacement === "session") queryScope.reset();
    else queryScope.setIdentity("org-replacement");
    const replacementScope = queryScope.getSnapshot();
    pending.resolve({
      ok: true,
      data: { items: [membershipOf("org-only")], nextCursor: null },
    });

    await assertRejects(
      () => resolving,
      Error,
      "ORGANIZATION_SELECTION_SUPERSEDED",
    );
    assertEquals(queryScope.getSnapshot(), replacementScope);
    assertEquals(storage.entries.size, 0);
  });
}

Deno.test("restore: multi-organization person is not sent to choose when quiet", async () => {
  const scope = new QueryScopeController(new QueryClient());
  const storage = recordingStorage();
  let chose = 0;
  const outcome = await restore(
    fakeApi([[membershipOf("a"), membershipOf("b")]]),
    scope,
    null,
    undefined,
    storage,
  );
  assertEquals(outcome, "choose");
  assertEquals(chose, 0);
  assertEquals(scope.getSnapshot().organizationId, null);
  await restore(
    fakeApi([[membershipOf("a"), membershipOf("b")]]),
    scope,
    () => {
      chose += 1;
    },
    undefined,
    storage,
  );
  assertEquals(chose, 1);
});

Deno.test("restore: sole membership is selected without a redirect", async () => {
  const scope = new QueryScopeController(new QueryClient());
  const storage = recordingStorage();
  let chose = 0;
  const outcome = await restore(
    fakeApi([[membershipOf("only")]]),
    scope,
    () => {
      chose += 1;
    },
    undefined,
    storage,
  );
  assertEquals(outcome, "selected");
  assertEquals(chose, 0);
  assertEquals(scope.getSnapshot().organizationId, "only");
});

Deno.test("restore: remembered organization wins over choosing", async () => {
  const scope = new QueryScopeController(new QueryClient());
  const storage = recordingStorage();
  storage.setItem(ORGANIZATION_PREFERENCE_KEY, "b");
  const outcome = await restore(
    fakeApi([[membershipOf("a"), membershipOf("b")]]),
    scope,
    null,
    undefined,
    storage,
  );
  assertEquals(outcome, "selected");
  assertEquals(scope.getSnapshot().organizationId, "b");
});
