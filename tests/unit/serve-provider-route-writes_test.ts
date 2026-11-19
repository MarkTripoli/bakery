import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import {
  assertProviderEndpoint,
  createProviderRoute,
  updateProviderRoute,
} from "../../apps/server/src/modules/execution/provider-writes.ts";

/**
 * The provider route commands without a database (#26 slice 2, writes).
 *
 * The integration file drives the mounted route against a real database. These
 * tests pin what a database run can hide because the data happens to agree:
 *
 *  - the organization is a predicate on every statement, so a route of another
 *    organization is never loaded or changed;
 *  - an update is refused for a stale version, a revoked route and a change that
 *    changes nothing, and each refusal writes nothing;
 *  - no command touches `health`, the incident or `inference_verified_at`: an
 *    operator cannot mark a route healthy by editing it.
 */

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const ROUTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Recorded = { sql: string; values: readonly unknown[] };

const baseRow = {
  id: ROUTE_ID,
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  region: "eu",
  model: "gpt-5",
  harness: "pi",
  billing_route: "api_metered",
  provider_account_id: null,
  worker_binding_id: null,
  credential_location: "harness_host",
  status: "active",
  health: "unverified",
  incident_id: null,
  incident_generation: 0,
  last_probe_at: null,
  next_probe_at: null,
  inference_verified_at: null,
  created_at: "2026-11-19T00:00:00.000Z",
  updated_at: "2026-11-19T00:00:00.000Z",
  version: 1,
};

/**
 * A transaction stand-in that answers by the statement's shape, so a test does
 * not depend on how many audit and event statements the persistence layer runs.
 */
function transactionWith(
  overrides: {
    locked?: Record<string, unknown> | null;
    insertError?: unknown;
  } = {},
) {
  const recorded: Recorded[] = [];
  const transaction = {
    query: (sql: string, values: readonly unknown[] = []) => {
      recorded.push({ sql, values });
      if (/insert into bakery\.provider_routes/.test(sql)) {
        if (overrides.insertError) return Promise.reject(overrides.insertError);
        return Promise.resolve({
          rows: [{ ...baseRow, region: values[4], model: values[5] }],
        });
      }
      if (/for update/.test(sql)) {
        const row = overrides.locked === undefined ? baseRow : overrides.locked;
        return Promise.resolve({ rows: row === null ? [] : [row] });
      }
      if (/update bakery\.provider_routes/.test(sql)) {
        return Promise.resolve({
          rows: [{
            ...baseRow,
            status: values[3] ?? baseRow.status,
            version: 2,
          }],
        });
      }
      return Promise.resolve({
        rows: [{ id: "x", version: 1, sequence: 1, organization_sequence: 1 }],
      });
    },
  };
  return { transaction, recorded };
}

function context(
  transaction: unknown,
  options: { params?: Record<string, string>; expectedVersion?: number } = {},
): ActionContext {
  return {
    params: options.params ?? {},
    signal: new AbortController().signal,
    requestId: "request-1",
    traceId: "trace-1",
    transaction,
    authority: {
      organizationId: ORG_ID,
      subject: { principalId: PRINCIPAL_ID },
    },
    commandMetadata: {
      operation: "providerRoutes.update",
      idempotencyKey: "key-1",
      target: ROUTE_ID,
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedVersion: options.expectedVersion }),
    },
  } as unknown as ActionContext;
}

const create = {
  provider: "openai",
  endpoint: "https://api.openai.example/v1",
  model: "gpt-5",
  harness: "pi",
  billingRoute: "api_metered",
  credentialLocation: "harness_host",
};

const writes = (recorded: Recorded[]) =>
  recorded.filter(({ sql }) => /^\s*(insert|update|delete)/i.test(sql));

Deno.test("a new route is inserted into the caller's organization, active and unverified", async () => {
  const { transaction, recorded } = transactionWith();
  const route = await createProviderRoute(context(transaction), create);
  const insert = recorded.find(({ sql }) =>
    /insert into bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(insert.values[1], ORG_ID);
  // Health, incident and inference proof are not in the insert: the table's
  // defaults are the only way a route starts, so no caller can seed `healthy`.
  assert(
    !/health|incident|inference_verified/.test(
      insert.sql.split("returning")[0]!,
    ),
  );
  assertEquals(route.status, "active");
  assertEquals(route.health, "unverified");
  assertEquals(route.incidentId, null);
  assertEquals(route.inferenceVerifiedAt, null);
});

Deno.test("an account or binding outside the organization is refused as unprocessable", async () => {
  const { transaction } = transactionWith({
    insertError: { code: "23503" },
  });
  const error = await assertRejects(
    () => createProviderRoute(context(transaction), create),
    StandardError,
  );
  assertEquals(error.code, "UNPROCESSABLE");
});

Deno.test("another database error is not disguised as a client mistake", async () => {
  const { transaction } = transactionWith({ insertError: { code: "57P01" } });
  await assertRejects(
    () => createProviderRoute(context(transaction), create),
  );
});

Deno.test("an update locks the route inside the organization and bumps the version", async () => {
  const { transaction, recorded } = transactionWith();
  const route = await updateProviderRoute(
    context(transaction, {
      params: { id: ROUTE_ID },
      expectedVersion: 1,
    }),
    { status: "disabled" },
  );
  const lock = recorded.find(({ sql }) => /for update/.test(sql))!;
  assertEquals(lock.values, [ORG_ID, ROUTE_ID]);
  const update = recorded.find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  assertEquals(update.values.slice(0, 2), [ORG_ID, ROUTE_ID]);
  assert(/version = version \+ 1/.test(update.sql));
  // Only status, region and the probe schedule may be set: identity and
  // circuit state are not editable.
  const assigned = update.sql.split("returning")[0]!.replace(
    "next_probe_at",
    "",
  );
  assert(
    !/health|incident|inference_verified|provider =|endpoint =/.test(assigned),
  );
  assertEquals(route.status, "disabled");
  assertEquals(route.version, 2);
});

Deno.test("leaving active clears the probe schedule, and staying active does not", async () => {
  const leave = transactionWith();
  await updateProviderRoute(
    context(leave.transaction, {
      params: { id: ROUTE_ID },
      expectedVersion: 1,
    }),
    { status: "revoked" },
  );
  assert(
    leave.recorded.some(({ sql }) =>
      /update bakery\.provider_route_health/.test(sql)
    ),
  );
  const stay = transactionWith();
  await updateProviderRoute(
    context(stay.transaction, { params: { id: ROUTE_ID }, expectedVersion: 1 }),
    { region: "us" },
  );
  assert(
    !stay.recorded.some(({ sql }) =>
      /update bakery\.provider_route_health/.test(sql)
    ),
  );
  const routeUpdate = stay.recorded.find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  // The leavesActive flag is the last parameter.
  assertEquals(routeUpdate.values.at(-1), false);
});

for (
  const [name, locked, expectedVersion, input, code, reason] of [
    [
      "a missing version",
      baseRow,
      undefined,
      { status: "disabled" },
      "PRECONDITION_REQUIRED",
    ],
    [
      "a stale version",
      baseRow,
      5,
      { status: "disabled" },
      "PRECONDITION_FAILED",
    ],
    [
      "a route of another organization",
      null,
      1,
      { status: "disabled" },
      "RESOURCE_NOT_FOUND",
    ],
    [
      "a revoked route",
      { ...baseRow, status: "revoked" },
      1,
      { status: "active" },
      "STATE_CONFLICT",
      "provider_route_revoked",
    ],
    [
      "an edit to a revoked route that is not a status change",
      { ...baseRow, status: "revoked" },
      1,
      { region: "us" },
      "STATE_CONFLICT",
      "provider_route_revoked",
    ],
    [
      "an update that changes nothing",
      baseRow,
      1,
      { status: "active" },
      "UNPROCESSABLE",
    ],
    ["an empty update", baseRow, 1, {}, "UNPROCESSABLE"],
    [
      "the region it already has",
      baseRow,
      1,
      { region: "eu" },
      "UNPROCESSABLE",
    ],
  ] as const
) {
  Deno.test(`${name} is refused as ${code} and writes nothing`, async () => {
    const { transaction, recorded } = transactionWith({ locked });
    const error = await assertRejects(
      () =>
        updateProviderRoute(
          context(transaction, {
            params: { id: ROUTE_ID },
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
          }),
          input,
        ),
      StandardError,
    );
    assertEquals(error.code, code);
    if (reason !== undefined) {
      assertEquals((error.params as { reason?: string })?.reason, reason);
    }
    assertEquals(writes(recorded), []);
  });
}

Deno.test("clearing the region with null is a change", async () => {
  const { transaction, recorded } = transactionWith();
  await updateProviderRoute(
    context(transaction, { params: { id: ROUTE_ID }, expectedVersion: 1 }),
    { region: null },
  );
  const update = recorded.find(({ sql }) =>
    /update bakery\.provider_routes/.test(sql)
  )!;
  // region flag true, value null.
  assertEquals(update.values.slice(4, 6), [true, null]);
});

Deno.test("an endpoint that carries a credential, or names the server's own network, is refused", () => {
  for (
    const endpoint of [
      "http://api.openai.example/v1",
      "ftp://api.openai.example/v1",
      "https://user:secret@api.openai.example/v1",
      "https://api.openai.example/v1?key=abc",
      "https://api.openai.example/v1#frag",
      "https://localhost/v1",
      "https://models.localhost/v1",
      "https://db.internal/v1",
      "https://printer.local/v1",
      "https://127.0.0.1/v1",
      "https://10.1.2.3/v1",
      "https://172.16.0.9/v1",
      "https://192.168.1.1/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/v1",
      "https://0.0.0.0/v1",
      "https://[::1]/v1",
      "https://[fe80::1]/v1",
      "https://[fd00::1]/v1",
      "https://[::ffff:127.0.0.1]/v1",
      // A trailing dot is the same host, and a bare name is not a public provider.
      "https://localhost./v1",
      "https://foo.localhost./v1",
      "https://metadata.google.internal./v1",
      "https://printer.local./v1",
      "https://localhost.localdomain/v1",
      "https://kubernetes.default.svc/v1",
      "https://kubernetes.default.svc.cluster.local/v1",
      "https://models.svc./v1",
      "https://127.0.0.1./v1",
      "https://etc/passwd",
      "https:///etc/passwd",
      "https://redis/v1",
      "https://consul:8500/v1",
      "https://example.com:0/v1",
      "https://api.provider.example../v1",
      "not a url",
      "",
    ]
  ) {
    let refused = false;
    try {
      assertProviderEndpoint(endpoint);
    } catch (error) {
      refused = (error as StandardError).code === "UNPROCESSABLE";
    }
    assert(refused, endpoint);
  }
  for (
    const endpoint of [
      "https://api.openai.example/v1",
      "https://api.anthropic.example",
      "https://eu.provider.example:8443/v1/models",
      "https://8.8.8.8/v1",
      "https://172.32.0.1/v1",
      "https://api.provider.example./v1",
      "https://xn--bcher-kva.example/v1",
      "https://svc.provider.example/v1",
      "https://api.localdomains.example/v1",
    ]
  ) {
    assertProviderEndpoint(endpoint);
  }
});

Deno.test("a create with a refused endpoint writes nothing", async () => {
  const { transaction, recorded } = transactionWith();
  await assertRejects(
    () =>
      createProviderRoute(context(transaction), {
        ...create,
        endpoint: "https://169.254.169.254/latest",
      }),
    StandardError,
  );
  assertEquals(writes(recorded), []);
});
