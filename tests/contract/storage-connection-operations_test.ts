import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  contractSchemas,
} from "../../packages/contracts/src/contracts.ts";
import { FAULTS } from "../../packages/contracts/src/http.ts";
import { StorageImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";
import { createArtifactActions } from "../../apps/server/src/modules/knowledge/resource-routes.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

const expected = {
  "storageConnections.mount": [
    "POST",
    "/v1/storage/connections/{id}/mount",
    "Admin",
    "integrationConnection:manage",
    "IdPath",
    "StorageConnectionMount",
  ],
  "storageConnectionPaths.list": [
    "GET",
    "/v1/storage/connection-paths",
    "Developer",
    "integrationConnection:read",
    "StorageConnectionPathQuery",
    "Page<StorageConnectionItem>",
  ],
  "storageConnectionPaths.stat": [
    "GET",
    "/v1/storage/connection-paths/stat",
    "Developer",
    "integrationConnection:read",
    "StorageConnectionStatQuery",
    "StorageConnectionItem",
  ],
  "storageConnectionPaths.read": [
    "GET",
    "/v1/storage/connection-paths/content",
    "Developer",
    "integrationConnection:read",
    "StorageConnectionReadQuery",
    "StorageConnectionRange",
  ],
  "storageConnectionSyncs.create": [
    "POST",
    "/v1/storage/connection-syncs",
    "Developer",
    "integrationConnection:invoke",
    "StorageConnectionSyncCreate",
    "StorageConnectionSync",
  ],
  "storageConnectionSyncs.list": [
    "GET",
    "/v1/storage/connection-syncs",
    "Developer",
    "integrationConnection:read",
    "CursorQuery",
    "Page<StorageConnectionSync>",
  ],
  "storageConnectionSyncs.pause": [
    "POST",
    "/v1/storage/connection-syncs/{id}/pause",
    "Developer",
    "integrationConnection:invoke",
    "IdPath",
    "StorageConnectionSync",
  ],
  "storageConnectionExports.create": [
    "POST",
    "/v1/storage/connection-exports",
    "Developer",
    "integrationConnection:invoke",
    "StorageConnectionExportCreate",
    "StorageConnectionExport",
  ],
} as const;

Deno.test("the catalog declares every storage connection operation", () => {
  const entries = new Map(
    catalogActions.map((entry) => [entry.action as string, entry]),
  );
  for (
    const [action, [method, path, access, permission, input, output]] of Object
      .entries(expected)
  ) {
    const entry = entries.get(action);
    assert(entry, action);
    assertEquals(
      [
        entry.method,
        entry.path,
        entry.access,
        entry.permission,
        entry.input,
        entry.output,
        entry.organizationContext,
      ],
      [
        method,
        path,
        access,
        permission,
        input,
        output,
        "required_authenticated_context",
      ],
      action,
    );
    if (method === "POST") {
      assert(entry.idempotency.startsWith("Idempotency-Key required"), action);
    }
    if (
      action !== "storageConnectionSyncs.list" &&
      action !== "storageConnectionSyncs.pause"
    ) {
      assert(
        (entry.errors as readonly string[]).includes(
          "STORAGE_PROVIDER_UNAVAILABLE",
        ),
        action,
      );
    }
  }
});

Deno.test("the server registers the storage connection actions with catalog parity", () => {
  const { registry } = createArtifactActions({
    database: {} as PgDatabase,
    publicBaseUrl: "https://bakery.test",
    secret: "s".repeat(48),
  });
  const names = new Set(registry.list().map(({ name }) => name as string));
  for (const action of Object.keys(expected)) assert(names.has(action), action);
  for (
    const name of [
      StorageImplementedAction.StorageConnectionsMount,
      StorageImplementedAction.StorageConnectionSyncsCreate,
      StorageImplementedAction.StorageConnectionSyncsPause,
      StorageImplementedAction.StorageConnectionExportsCreate,
    ]
  ) {
    assertEquals(registry.get(name).explicitIdempotency, "key", name);
  }
});

Deno.test("the no-provider error is a typed 409", () => {
  assertEquals(FAULTS.STORAGE_PROVIDER_UNAVAILABLE, [
    409,
    false,
    "storage-provider-unavailable",
  ]);
});

Deno.test("the storage connection inputs keep their bounds", () => {
  const path = "/connections/drive/docs";
  const list = contractSchemas.StorageConnectionPathQuery;
  assert(list.safeParse({ path }).success);
  assert(list.safeParse({ path, limit: 100 }).success);
  assert(!list.safeParse({ path, limit: 101 }).success);
  assert(!list.safeParse({}).success);
  const read = contractSchemas.StorageConnectionReadQuery;
  assert(read.safeParse({ path, offset: 0, length: 1048576 }).success);
  assert(!read.safeParse({ path, offset: 0, length: 1048577 }).success);
  assert(!read.safeParse({ path, offset: -1, length: 1 }).success);
  const exported = contractSchemas.StorageConnectionExportCreate;
  assert(
    exported.safeParse({ path, artifactVersionId: crypto.randomUUID() })
      .success,
  );
  assert(!exported.safeParse({ path, artifactVersionId: "nope" }).success);
  assert(
    contractSchemas.StorageConnectionExport.safeParse({
      effectId: crypto.randomUUID(),
      status: "prepared",
      replayed: false,
    }).success,
  );
  assert(
    !contractSchemas.StorageConnectionExport.safeParse({
      effectId: crypto.randomUUID(),
      status: "sent",
      replayed: false,
    }).success,
  );
});
