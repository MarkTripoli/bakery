import { assert, assertEquals } from "@std/assert";
import catalog from "../../docs/technical-design/api-catalog.json" with {
  type: "json",
};
import {
  contractSchemas,
  generateContracts,
  type GeneratedContracts,
} from "../../packages/contracts/src/contracts.ts";
type CatalogAction = {
  action: string;
  method: string;
  path: string;
  permission: string | null;
  output: string;
  organizationContext?: string;
};
type CatalogDocument = { actions: CatalogAction[] };

function isCatalogAction(value: unknown): value is CatalogAction {
  if (value === null || typeof value !== "object") return false;
  return "action" in value && typeof value.action === "string" &&
    "method" in value && typeof value.method === "string" &&
    "path" in value && typeof value.path === "string" &&
    "permission" in value &&
    (typeof value.permission === "string" || value.permission === null) &&
    "output" in value && typeof value.output === "string";
}

function isCatalogDocument(value: unknown): value is CatalogDocument {
  if (value === null || typeof value !== "object" || !("actions" in value)) {
    return false;
  }
  return Array.isArray(value.actions) && value.actions.every(isCatalogAction);
}

assert(isCatalogDocument(catalog), "api catalog has typed actions");
const catalogActions = catalog.actions;

type GeneratedAction = GeneratedContracts["actions"][number];

function catalogAction(name: string): CatalogAction {
  const action = catalogActions.find((candidate) => candidate.action === name);
  assert(action, `${name} is present in the catalog`);
  return action;
}

function generatedAction(
  actions: readonly GeneratedAction[],
  name: string,
): GeneratedAction {
  const action = actions.find((candidate) => candidate.action === name);
  assert(action, `${name} is present in generated contracts`);
  return action;
}

Deno.test("F7.01 catalog projections are typed, implemented and scoped", () => {
  const expected = [
    [
      "workerEnrollments.list",
      "GET",
      "/v1/worker-enrollments",
      "worker:read",
      "Page<WorkerEnrollmentSummary>",
    ],
    [
      "machines.dispatchBlockers",
      "GET",
      "/v1/workers/{id}/dispatch-blockers",
      "worker:read",
      "DispatchBlockers",
    ],
  ] as const;

  const generated = generateContracts();
  for (const [name, method, path, permission, output] of expected) {
    const source = catalogAction(name);
    assertEquals(
      [source.method, source.path, source.permission, source.output],
      [method, path, permission, output],
    );
    assertEquals(source.organizationContext, "required_authenticated_context");
    assertEquals(generatedAction(generated.actions, name).implemented, true);
    assertEquals(
      generatedAction(generated.actions, name).organizationContext,
      "required_authenticated_context",
    );
  }

  assertEquals(
    generated.actions.find(({ action }) => action === "workers.list")
      ?.implemented,
    true,
  );
  assertEquals(
    generated.actions.find(({ action }) =>
      action === "workerProviderBindings.list"
    )
      ?.implemented,
    true,
  );

  const enrollment = contractSchemas["WorkerEnrollmentSummary"].parse({
    enrollmentId: "00000000-0000-4000-8000-000000000001",
    state: "pending",
    name: "builder",
    os: "linux",
    architecture: "x64",
    capabilities: ["git"],
    slots: 2,
    expiresAt: "2026-10-19T00:00:00.000Z",
    consumedAt: null,
    canceledAt: null,
    workerHostId: null,
    replacementOfId: null,
    targetWorkerHostId: null,
    version: 1,
  });
  assertEquals("enrollmentToken" in enrollment, false);
  assertEquals("tokenHash" in enrollment, false);

  const blockers = contractSchemas["DispatchBlockers"].parse({
    workerHostId: "00000000-0000-4000-8000-000000000002",
    reason: "check_failed",
    connectivity: "online",
    allBlocked: false,
    blockedCapabilities: ["git"],
    failedChecks: [{ checkId: "capability:git", reason: "missing binary" }],
    credentialGeneration: 3,
    inventoryRevision: 7,
  });
  assertEquals(blockers.failedChecks[0]?.reason, "missing binary");
  assertEquals(blockers.reason, "check_failed");
  assertEquals(blockers.connectivity, "online");
  assertEquals(
    contractSchemas["DispatchBlockers"].safeParse({
      ...blockers,
      reason: "unreachable",
    }).success,
    false,
  );
  assertEquals(
    contractSchemas["DispatchBlockers"].parse({ ...blockers, reason: null })
      .reason,
    null,
  );
});
