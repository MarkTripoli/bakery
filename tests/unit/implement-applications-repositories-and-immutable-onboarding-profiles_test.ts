import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createApiRouter,
  StandardError,
} from "../../packages/contracts/src/http.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import {
  listRepositoryRoleBindings,
  MAX_REPOSITORY_BINDING_CANDIDATES,
} from "../../apps/server/src/modules/projects/roles.ts";
import {
  createProjectsActionRegistry,
  createProjectsHandlers,
} from "../../apps/server/src/modules/projects/index.ts";
import {
  resolveExecutableBinding,
  resolveRepositoryBinding,
} from "../../apps/server/src/modules/projects/binding.ts";
import { profileDigest } from "../../apps/server/src/modules/projects/postgres.ts";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const FOREIGN_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000011";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000002";
const FOREIGN_APPLICATION_ID = "00000000-0000-4000-8000-000000000012";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000022";
const CURSOR_SECRET = "role-list-cursor-secret";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000003";
const FOREIGN_REPOSITORY_ID = "00000000-0000-4000-8000-000000000013";
const BINDING_ID = "00000000-0000-4000-8000-000000000004";
const PROFILE_ID = "00000000-0000-4000-8000-000000000005";
const OBSERVATION_ID = "00000000-0000-4000-8000-000000000006";
const BASE_SHA = "a".repeat(40);
const profileConfig = {
  schemaVersion: 1,
  workflow: { kind: "fixed" },
  branches: { base: "main", allowedPatterns: ["feature/*"] },
  worktree: { root: ".bakery/worktrees" },
};
const PROFILE_DIGEST = await profileDigest(profileConfig);
const OBSERVATION_DIGEST = "c".repeat(64);

type QueryResponse = { rows: readonly unknown[]; rowCount?: number };

type QueryCall = { sql: string; values: readonly unknown[] };
type QueryResponseFactory = (call: QueryCall) => QueryResponse;

function fakeTransaction(
  responses: readonly QueryResponse[] | QueryResponseFactory,
): {
  transaction: PgTransactionClient;
  calls: QueryCall[];
} {
  const pending = typeof responses === "function" ? null : [...responses];
  const calls: QueryCall[] = [];
  const transaction = {
    query: (sql: string, values: unknown[] = []) => {
      const call = { sql, values };
      calls.push(call);
      const response = typeof responses === "function"
        ? responses(call)
        : pending?.shift() ?? { rows: [] };
      return Promise.resolve(response);
    },
  } as unknown as PgTransactionClient;
  return { transaction, calls };
}

function observedBindingRow(
  bindingId: string = BINDING_ID,
  repositoryId: string = REPOSITORY_ID,
) {
  return {
    organization_id: ORGANIZATION_ID,
    binding_id: bindingId,
    binding_role: "source",
    binding_alias: "primary",
    binding_provenance: "catalog",
    repository_id: repositoryId,
    repository_slug: "source-repo",
    application_id: APPLICATION_ID,
    archived_at: null,
    profile_id: PROFILE_ID,
    profile_revision: 7,
    profile_digest: PROFILE_DIGEST,
    profile_config: { ...profileConfig, schemaVersion: 2 },
    default_branch: "main",
    observation_id: OBSERVATION_ID,
    observation_digest: OBSERVATION_DIGEST,
    base_sha: BASE_SHA,
  };
}

Deno.test("role resolution reports unavailable for zero candidates", async () => {
  const { transaction } = fakeTransaction([{ rows: [] }]);
  const resolution = await resolveRepositoryBinding(
    transaction,
    ORGANIZATION_ID,
    APPLICATION_ID,
    { role: "source", alias: "missing" },
  );

  assertEquals(resolution, {
    status: "unavailable",
    reason: "no_matching_binding",
  });
});

Deno.test("malformed v2 without a canonical policy and authorized publication cannot execute", async () => {
  const { transaction } = fakeTransaction([{ rows: [observedBindingRow()] }]);
  const resolution = await resolveRepositoryBinding(
    transaction,
    ORGANIZATION_ID,
    APPLICATION_ID,
    { role: " SOURCE ", alias: " PRIMARY " },
  );

  assertEquals(resolution, {
    status: "resolved",
    binding: {
      organizationId: ORGANIZATION_ID,
      applicationId: APPLICATION_ID,
      repositoryId: REPOSITORY_ID,
      repositoryProfileId: null,
      repositoryProfileRevision: null,
      repositoryProfileDigest: null,
      observationId: null,
      observationDigest: null,
      baseSha: null,
    },
  });
  const executableFixture = fakeTransaction([{ rows: [observedBindingRow()] }]);
  const error = await assertRejects(
    () =>
      resolveExecutableBinding(
        executableFixture.transaction,
        ORGANIZATION_ID,
        APPLICATION_ID,
        REPOSITORY_ID,
      ),
    StandardError,
  );
  assertEquals(error.code, "STATE_CONFLICT");
});

Deno.test("many candidates return bounded ambiguity with no first/latest fallback", async () => {
  const rows = Array.from(
    { length: MAX_REPOSITORY_BINDING_CANDIDATES + 8 },
    (_, index) =>
      observedBindingRow(
        `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        `00000000-0000-4000-8000-${String(index + 200).padStart(12, "0")}`,
      ),
  );
  const { transaction } = fakeTransaction([{ rows }]);
  const resolution = await resolveRepositoryBinding(
    transaction,
    ORGANIZATION_ID,
    APPLICATION_ID,
    { aliases: ["primary"] },
  );

  assertEquals(resolution.status, "ambiguous");
  if (resolution.status !== "ambiguous") return;
  assertEquals(resolution.candidates.length, MAX_REPOSITORY_BINDING_CANDIDATES);
  assertEquals(resolution.candidates[0]?.profileRevision, null);
  assertEquals(resolution.candidates[0]?.hasEligibleObservation, false);
  assertEquals(resolution.truncated, true);
  assertEquals(
    resolution.candidates.map((candidate) => candidate.bindingId),
    rows.slice(0, MAX_REPOSITORY_BINDING_CANDIDATES).map((row) =>
      row.binding_id
    ),
  );
});

Deno.test("archived direct repositories are unavailable and foreign references return public not found", async () => {
  const archived = {
    ...observedBindingRow(),
    archived_at: new Date("2026-09-20T00:00:00.000Z"),
  };
  const archivedFixture = fakeTransaction([{ rows: [archived] }]);
  const archivedResolution = await resolveRepositoryBinding(
    archivedFixture.transaction,
    ORGANIZATION_ID,
    APPLICATION_ID,
    { repositoryId: REPOSITORY_ID },
  );
  assertEquals(archivedResolution, {
    status: "unavailable",
    reason: "repository_archived",
  });

  const foreignFixture = fakeTransaction([
    { rows: [] },
    {
      rows: [{
        organization_id: FOREIGN_ORGANIZATION_ID,
        application_id: FOREIGN_APPLICATION_ID,
      }],
    },
  ]);
  const registry = createProjectsActionRegistry(
    createProjectsHandlers(CURSOR_SECRET),
    {
      authorityRunner: {
        async run(_action, context, _input, next) {
          return await next(
            Object.assign({}, context, {
              authority: {
                organizationId: ORGANIZATION_ID,
                subject: { principalId: PRINCIPAL_ID },
              },
              transaction: foreignFixture.transaction,
            }),
          );
        },
      },
    },
  );
  const app = createApiRouter({ registry });
  const response = await app.fetch(
    new Request(
      `http://projects.test/v1/applications/${APPLICATION_ID}/roles/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositoryId: FOREIGN_REPOSITORY_ID }),
      },
    ),
  );
  const body = await response.json() as {
    code?: string;
    status?: number;
  };
  const serializedBody = JSON.stringify(body);
  assertEquals(
    response.status,
    404,
    `response.status=${response.status} body.code=${body.code ?? "<missing>"}` +
      ` body.status=${body.status ?? "<missing>"}` +
      ` foreignFixture.calls.length=${foreignFixture.calls.length}`,
  );
  assertEquals(body.code, "RESOURCE_NOT_FOUND");
  assert(!serializedBody.includes(FOREIGN_REPOSITORY_ID));
  assert(!serializedBody.includes("repository_scope_mismatch"));
});
Deno.test(
  "public role resolution returns identity only and rejects malformed selectors before querying",
  async () => {
    const fixture = fakeTransaction([{ rows: [observedBindingRow()] }]);
    const registry = createProjectsActionRegistry(
      createProjectsHandlers(CURSOR_SECRET),
      {
        authorityRunner: {
          async run(_action, context, _input, next) {
            return await next(
              Object.assign({}, context, {
                authority: {
                  organizationId: ORGANIZATION_ID,
                  subject: { principalId: PRINCIPAL_ID },
                },
                transaction: fixture.transaction,
              }),
            );
          },
        },
      },
    );
    const app = createApiRouter({ registry });
    const url =
      `http://projects.test/v1/applications/${APPLICATION_ID}/roles/resolve`;

    const malformed = await app.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryId: REPOSITORY_ID,
          role: "source",
        }),
      }),
    );
    const malformedBody = await malformed.json() as {
      code?: string;
    };
    assertEquals(malformed.status, 400);
    assertEquals(malformedBody.code, "MALFORMED_REQUEST");
    assertEquals(fixture.calls.length, 0);

    const resolved = await app.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "source", alias: "primary" }),
      }),
    );
    assertEquals(resolved.status, 201);
    assertEquals(await resolved.json(), {
      status: "resolved",
      binding: {
        organizationId: ORGANIZATION_ID,
        applicationId: APPLICATION_ID,
        repositoryId: REPOSITORY_ID,
        repositoryProfileId: null,
        repositoryProfileRevision: null,
        repositoryProfileDigest: null,
        observationId: null,
        observationDigest: null,
        baseSha: null,
      },
    });
  },
);

Deno.test("strict-v1 executable reads preserve the legacy profile pin", async () => {
  const { transaction } = fakeTransaction([{
    rows: [{
      ...observedBindingRow(),
      profile_config: profileConfig,
      profile_revision: 1,
    }],
  }]);
  const binding = await resolveExecutableBinding(
    transaction,
    ORGANIZATION_ID,
    APPLICATION_ID,
    REPOSITORY_ID,
  );

  assertEquals(binding, {
    repositoryProfileId: PROFILE_ID,
    repositoryProfileRevision: 1,
    repositoryProfileDigest: PROFILE_DIGEST,
    observationId: null,
    observationDigest: null,
    baseSha: null,
  });
});

Deno.test("repository identity survives missing, invalid, stale and v2 profiles without partial pins", async () => {
  for (
    const changes of [
      { profile_id: null, profile_revision: null, profile_digest: null },
      { profile_config: { ...profileConfig, unexpected: true } },
      { profile_digest: "0".repeat(64) },
      { default_branch: "develop" },
      { profile_config: { ...profileConfig, schemaVersion: 2 } },
    ]
  ) {
    const { transaction } = fakeTransaction([{
      rows: [{
        ...observedBindingRow(),
        profile_config: profileConfig,
        ...changes,
      }],
    }]);
    const resolution = await resolveRepositoryBinding(
      transaction,
      ORGANIZATION_ID,
      APPLICATION_ID,
      { repositoryId: REPOSITORY_ID },
    );
    assertEquals(resolution, {
      status: "resolved",
      binding: {
        organizationId: ORGANIZATION_ID,
        applicationId: APPLICATION_ID,
        repositoryId: REPOSITORY_ID,
        repositoryProfileId: null,
        repositoryProfileRevision: null,
        repositoryProfileDigest: null,
        observationId: null,
        observationDigest: null,
        baseSha: null,
      },
    });
  }
});

Deno.test("role list uses an opaque created-at cursor scoped to action, principal, organization, and application", async () => {
  const secondBindingId = "00000000-0000-4000-8000-000000000014";
  const firstRows = [{
    id: BINDING_ID,
    organization_id: ORGANIZATION_ID,
    application_id: APPLICATION_ID,
    repository_id: REPOSITORY_ID,
    repository_slug: "source-repo",
    role: "source",
    alias: "primary",
    provenance: null,
    archived_at: null,
    version: 2,
    cursor_created_at: "2026-09-20T00:00:00.000000Z",
  }, {
    id: secondBindingId,
    organization_id: ORGANIZATION_ID,
    application_id: APPLICATION_ID,
    repository_id: REPOSITORY_ID,
    repository_slug: "source-repo",
    role: "source",
    alias: "secondary",
    provenance: null,
    archived_at: null,
    version: 1,
    cursor_created_at: "2026-09-21T00:00:00.000000Z",
  }];
  const firstFixture = fakeTransaction((call) => {
    const createdAt = call.values[2];
    const id = call.values[3];
    const rows = typeof createdAt === "string" && typeof id === "string"
      ? firstRows.filter((row) =>
        row.cursor_created_at > createdAt ||
        (row.cursor_created_at === createdAt && row.id > id)
      )
      : firstRows;
    return { rows };
  });
  const firstPage = await listRepositoryRoleBindings(
    firstFixture.transaction,
    ORGANIZATION_ID,
    APPLICATION_ID,
    CURSOR_SECRET,
    PRINCIPAL_ID,
    { limit: 1 },
  );
  assertEquals(firstPage.items.length, 1);
  assert(firstPage.nextCursor !== null);
  assertEquals(firstPage.items[0]?.id, BINDING_ID);
  const cursor = firstPage.nextCursor;
  assert(cursor !== null);
  assert(firstPage.nextCursor !== BINDING_ID);

  const secondPage = await listRepositoryRoleBindings(
    firstFixture.transaction,
    ORGANIZATION_ID,
    APPLICATION_ID,
    CURSOR_SECRET,
    PRINCIPAL_ID,
    { limit: 1, cursor },
  );
  assertEquals(secondPage.items.length, 1);
  assertEquals(secondPage.items[0]?.alias, "secondary");
  assertEquals(secondPage.items[0]?.id, secondBindingId);
  assertEquals(secondPage.nextCursor, null);

  for (
    const [
      organizationId,
      applicationId,
      principalId,
      candidateCursor,
    ] of [
      [ORGANIZATION_ID, APPLICATION_ID, PRINCIPAL_ID, BINDING_ID],
      [ORGANIZATION_ID, APPLICATION_ID, PRINCIPAL_ID, `${cursor}x`],
      [ORGANIZATION_ID, FOREIGN_APPLICATION_ID, PRINCIPAL_ID, cursor],
      [ORGANIZATION_ID, APPLICATION_ID, FOREIGN_ORGANIZATION_ID, cursor],
      [FOREIGN_ORGANIZATION_ID, APPLICATION_ID, PRINCIPAL_ID, cursor],
    ] as const
  ) {
    const fixture = fakeTransaction([]);
    const error = await assertRejects(
      () =>
        listRepositoryRoleBindings(
          fixture.transaction,
          organizationId,
          applicationId,
          CURSOR_SECRET,
          principalId,
          { cursor: candidateCursor },
        ),
      StandardError,
    );
    assertEquals(error.code, "INVALID_CURSOR");
    assertEquals(fixture.calls.length, 0);
  }
});
