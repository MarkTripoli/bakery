import { assertEquals, assertRejects } from "@std/assert";
import type {
  ActionContext,
  NormalizedCommandMetadata,
} from "../../packages/contracts/src/action-registry.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import {
  createProjectsHandlers,
  type ProjectsActionHandlers,
} from "../../apps/server/src/modules/projects/index.ts";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000002";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000022";
const BINDING_ID = "00000000-0000-4000-8000-000000000004";

type QueryCall = { sql: string; values: readonly unknown[] };
type RoleUpdateInput = Parameters<ProjectsActionHandlers["updateRole"]>[1];
type TestContext = ActionContext & {
  authority: {
    organizationId: string;
    subject: { principalId: string };
  };
  transaction: PgTransactionClient;
  commandMetadata?: NormalizedCommandMetadata;
};

function fakeTransaction(): {
  transaction: PgTransactionClient;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const transaction = {
    query: (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PgTransactionClient;
  return { transaction, calls };
}

function context(
  transaction: PgTransactionClient,
  commandMetadata?: NormalizedCommandMetadata,
): TestContext {
  return {
    request: new Request("http://test"),
    params: { applicationId: APPLICATION_ID, roleId: BINDING_ID },
    requestId: "request-id",
    traceId: "trace-id",
    signal: new AbortController().signal,
    authority: {
      organizationId: ORGANIZATION_ID,
      subject: { principalId: PRINCIPAL_ID },
    },
    transaction,
    ...(commandMetadata === undefined ? {} : { commandMetadata }),
  };
}

function metadata(expectedVersion: number): NormalizedCommandMetadata {
  return {
    operation: "projects.roles.update",
    idempotencyKey: "role-cas-test",
    target: `/v1/applications/${APPLICATION_ID}/roles/${BINDING_ID}`,
    expectedVersion,
  };
}

function roleUpdate(expectedVersion: number): RoleUpdateInput {
  return { expectedVersion, alias: "next" };
}

Deno.test("role update rejects a body version that conflicts with If-Match before DB access", async () => {
  const handlers = createProjectsHandlers("test-secret");
  const { transaction, calls } = fakeTransaction();

  const error = await assertRejects(
    async () =>
      await handlers.updateRole(
        context(transaction, metadata(2)),
        roleUpdate(3),
      ),
    StandardError,
  );

  assertEquals(error.code, "PRECONDITION_FAILED");
  assertEquals(calls, []);
});

Deno.test("role update preserves PRECONDITION_REQUIRED when command metadata is absent", async () => {
  const handlers = createProjectsHandlers("test-secret");
  const { transaction, calls } = fakeTransaction();

  const error = await assertRejects(
    async () => await handlers.updateRole(context(transaction), roleUpdate(2)),
    StandardError,
  );

  assertEquals(error.code, "PRECONDITION_REQUIRED");
  assertEquals(calls, []);
});
