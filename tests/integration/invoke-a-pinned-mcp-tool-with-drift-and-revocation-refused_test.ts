import { assertEquals } from "@std/assert";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  invokeMcpTool,
  mcpInvocationDenial,
  type McpToolTransport,
} from "../../apps/server/src/modules/mcp/invoke.ts";
import { createPostgresMcpPinnedStatePort } from "../../apps/server/src/modules/mcp/postgres.ts";

/**
 * Discovery is not permission, and a binding is rechecked at invoke time.
 *
 * These tests drive the real database read and the real invoke entry point, so
 * they fail if the check is removed: a parked helper would let them pass while
 * the product dispatched anyway. Each case is one acceptance criterion - a
 * changed remote schema, a revoked connection, a revoked grant, an unbound
 * capability, and an ineligible host - and asserts the transport was never
 * reached, because "refused" means the side effect did not happen.
 */

const databaseConfig = readTestDatabaseConfig();
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

/** Records every call so a test can assert the transport was never reached. */
function recordingTransport(): McpToolTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    invoke(input) {
      calls.push(`${input.connectionId}:${input.toolName}`);
      return Promise.resolve({ ok: true });
    },
  };
}

/**
 * Delete one test's organization, cascading to everything it created.
 *
 * Every test removes exactly what it seeded, in `finally`. A file that leaves
 * organizations behind breaks the security suite's fixture boundary, which
 * asserts an exact count after its own reset - so residue is a real defect and
 * not merely untidy. Deleting by organization rather than resetting the whole
 * database keeps the file runnable in parallel with its peers.
 */
/**
 * Delete one test's organization together with the auth rows behind it.
 *
 * The organization cascade removes memberships and every bakery row, but it does
 * not remove `public."user"` or `bakery.principals` - so deleting only the
 * organization leaves users and principals behind, and a later security test on
 * the same database fails its exact-count check. The ids are passed in rather
 * than inferred, so cleanup deletes exactly what the test created and nothing
 * another test might own.
 */
async function removeOrganization(
  db: ReturnType<typeof openDatabase>,
  organizationId: string,
  created: { userIds: readonly string[]; principalIds: readonly string[] },
): Promise<void> {
  await db`delete from bakery.organizations where id = ${organizationId}`;
  // Principals reference the auth user, so they go first and the user last.
  for (const principalId of created.principalIds) {
    await db`delete from bakery.principals where id = ${principalId}`;
  }
  for (const userId of created.userIds) {
    await db`delete from public."user" where id = ${userId}`;
  }
}

/**
 * Seed an online worker host and return its id.
 *
 * `mcp_connections.worker_host_id` is a foreign key, so a stdio connection
 * cannot name a host that does not exist. Every test that expects a dispatch
 * seeds this host and passes its id as both the bound host and the host
 * dispatching the call.
 */
async function seedWorkerHost(
  db: ReturnType<typeof openDatabase>,
  organizationId: string,
): Promise<{
  hostId: string;
  principalId: string;
}> {
  const hostId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  // A non-human principal has no provider user: the schema's check constraint
  // requires provider_user_id to be null for any principal type but `human`.
  await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
    values (${principalId}, null, 'worker', 'worker')`;
  await db`insert into bakery.worker_hosts (id, organization_id, principal_id, name, os, architecture, slots,
      capabilities, credential_hash, worker_session_id, worker_session_generation)
    values (${hostId}, ${organizationId}, ${principalId}, 'w', 'linux', 'x86_64', 1,
      ${db.json(["git", "shell"])}, ${
    "e".repeat(64)
  }, ${crypto.randomUUID()}, 1)`;
  return { hostId, principalId };
}

Deno.test("a pinned tool invokes when nothing changed", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  // The worker host is seeded inside the try but its principal is deleted in
  // finally, so the handle lives here.
  let worker: Awaited<ReturnType<typeof seedWorkerHost>> | undefined;
  try {
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    worker = await seedWorkerHost(db, organizationId);
    const hostId = worker.hostId;
    // A human principal is backed by an auth user; the composite constraint says so.
    await db`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, 'mcp-actor', ${`mcp-${userId}@example.test`}, true, ${now}, ${now})`;
    await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${userId}, 'mcp-actor', 'human')`;
    await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
      values (${serverId}, ${organizationId}, 'fs', 'FS', 'stdio', ${
      db.json({})
    }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
      values (${connectionId}, ${organizationId}, ${serverId}, null, ${hostId}, 'local', '{}'::jsonb, null, ${
      db.json(["search", "fetch"])
    }, 'enabled', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }, { name: "fetch" }] })
    }, ${DIGEST_A}, ${now})`;
    // The binding is the grant: it pins the snapshot and names the operations
    // the caller may use. An empty operation list admits nothing, which is why
    // the happy path names the tool.
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required, created_at, updated_at, version)
      values (${bindingId}, ${organizationId}, ${connectionId}, ${snapshotId}, ${DIGEST_A}, ${principalId}, ${
      db.json(["search", "fetch"])
    }, false, ${now}, ${now}, 1)`;

    const transport = recordingTransport();
    const result = await invokeMcpTool(
      { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
      {
        organizationId,
        actorRef: principalId,
        connectionId,
        toolName: "search",
        pinnedDigest: DIGEST_A,
        arguments: { q: "hello" },
        hostId,
      },
    );
    assertEquals(result.toolName, "search");
    assertEquals(result.digest, DIGEST_A);
    assertEquals(transport.calls, [`${connectionId}:search`]);
  } finally {
    await removeOrganization(db, organizationId, {
      userIds: [userId],
      principalIds: [principalId, ...(worker ? [worker.principalId] : [])],
    });
    await closeDatabase(db);
  }
});

Deno.test("a changed remote schema refuses the call before it is dispatched", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  // The worker host is seeded inside the try but its principal is deleted in
  // finally, so the handle lives here.
  let worker: Awaited<ReturnType<typeof seedWorkerHost>> | undefined;
  try {
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const pinnedId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    worker = await seedWorkerHost(db, organizationId);
    const hostId = worker.hostId;
    await db`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, 'actor', ${`a-${userId}@example.test`}, true, ${now}, ${now})`;
    await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${userId}, 'actor', 'human')`;
    await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
      values (${serverId}, ${organizationId}, 'fs', 'FS', 'stdio', ${
      db.json({})
    }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
      values (${connectionId}, ${organizationId}, ${serverId}, null, ${hostId}, 'local', '{}'::jsonb, null, ${
      db.json(["search"])
    }, 'enabled', ${currentId}, ${now}, ${now}, 1)`;
    // The binding pinned digest A; the server now advertises digest B.
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${pinnedId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }] })
    }, ${DIGEST_A}, ${now})`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${currentId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }] })
    }, ${DIGEST_B}, ${now})`;
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, ${pinnedId}, ${DIGEST_A}, ${principalId}, ${
      db.json(["search", "fetch"])
    }, false, ${now}, ${now}, 1)`;

    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId,
          actorRef: principalId,
          connectionId,
          toolName: "search",
          pinnedDigest: DIGEST_B,
          arguments: {},
          hostId,
        },
      );
    } catch (error) {
      const refusal = error as {
        params?: { reason?: string };
      };
      denial = refusal.params?.reason;
    }
    assertEquals(denial, "schema_drift");
    assertEquals(
      transport.calls,
      [],
      "the transport must not be reached on drift",
    );
  } finally {
    await removeOrganization(db, organizationId, {
      userIds: [userId],
      principalIds: [principalId, ...(worker ? [worker.principalId] : [])],
    });
    await closeDatabase(db);
  }
});

Deno.test("a revoked connection refuses the call before it is dispatched", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  // The worker host is seeded inside the try but its principal is deleted in
  // finally, so the handle lives here.
  let worker: Awaited<ReturnType<typeof seedWorkerHost>> | undefined;
  try {
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    worker = await seedWorkerHost(db, organizationId);
    const hostId = worker.hostId;
    await db`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, 'actor', ${`a-${userId}@example.test`}, true, ${now}, ${now})`;
    await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${userId}, 'actor', 'human')`;
    await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
      values (${serverId}, ${organizationId}, 'fs', 'FS', 'stdio', ${
      db.json({})
    }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
      values (${connectionId}, ${organizationId}, ${serverId}, null, ${hostId}, 'local', '{}'::jsonb, null, ${
      db.json(["search"])
    }, 'revoked', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }] })
    }, ${DIGEST_A}, ${now})`;
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, ${snapshotId}, ${DIGEST_A}, ${principalId}, ${
      db.json(["search", "fetch"])
    }, false, ${now}, ${now}, 1)`;

    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId,
          actorRef: principalId,
          connectionId,
          toolName: "search",
          pinnedDigest: DIGEST_A,
          arguments: {},
          hostId,
        },
      );
    } catch (error) {
      const refusal = error as {
        params?: { reason?: string };
      };
      denial = refusal.params?.reason;
    }
    assertEquals(denial, "connection_revoked");
    assertEquals(transport.calls, []);
  } finally {
    await removeOrganization(db, organizationId, {
      userIds: [userId],
      principalIds: [principalId, ...(worker ? [worker.principalId] : [])],
    });
    await closeDatabase(db);
  }
});

Deno.test("a tool the operator did not enable cannot be reached by naming it", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  // The worker host is seeded inside the try but its principal is deleted in
  // finally, so the handle lives here.
  let worker: Awaited<ReturnType<typeof seedWorkerHost>> | undefined;
  try {
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    worker = await seedWorkerHost(db, organizationId);
    const hostId = worker.hostId;
    await db`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, 'actor', ${`a-${userId}@example.test`}, true, ${now}, ${now})`;
    await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${userId}, 'actor', 'human')`;
    await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
      values (${serverId}, ${organizationId}, 'fs', 'FS', 'stdio', ${
      db.json({})
    }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;
    // The snapshot advertises both tools; only `search` was enabled.
    await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
      values (${connectionId}, ${organizationId}, ${serverId}, null, ${hostId}, 'local', '{}'::jsonb, null, ${
      db.json(["search"])
    }, 'enabled', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }, { name: "fetch" }] })
    }, ${DIGEST_A}, ${now})`;
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, ${snapshotId}, ${DIGEST_A}, ${principalId}, ${
      db.json(["search", "fetch"])
    }, false, ${now}, ${now}, 1)`;

    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId,
          actorRef: principalId,
          connectionId,
          toolName: "fetch",
          pinnedDigest: DIGEST_A,
          arguments: {},
          hostId,
        },
      );
    } catch (error) {
      const refusal = error as {
        params?: { reason?: string };
      };
      denial = refusal.params?.reason;
    }
    assertEquals(denial, "capability_not_bound");
    assertEquals(transport.calls, []);
  } finally {
    await removeOrganization(db, organizationId, {
      userIds: [userId],
      principalIds: [principalId, ...(worker ? [worker.principalId] : [])],
    });
    await closeDatabase(db);
  }
});

Deno.test("an unknown connection is refused rather than invoked", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  try {
    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId: crypto.randomUUID(),
          actorRef: crypto.randomUUID(),
          connectionId: crypto.randomUUID(),
          toolName: "search",
          pinnedDigest: DIGEST_A,
          arguments: {},
          hostId: crypto.randomUUID(),
        },
      );
    } catch (error) {
      const refusal = error as {
        params?: { reason?: string };
      };
      denial = refusal.params?.reason;
    }
    assertEquals(denial, "connection_revoked");
    assertEquals(transport.calls, []);
  } finally {
    // Nothing was seeded: an unknown connection is exactly the case where no
    // organization exists, so there is nothing to clean up.
    await closeDatabase(db);
  }
});

Deno.test("AC1: a binding made for another actor does not grant this one", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  // The worker host is seeded inside the try but its principal is deleted in
  // finally, so the handle lives here.
  let worker: Awaited<ReturnType<typeof seedWorkerHost>> | undefined;
  const seededUsers: string[] = [];
  const strangerId = crypto.randomUUID();
  try {
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'org', ${`o-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    worker = await seedWorkerHost(db, organizationId);
    const hostId = worker.hostId;
    for (
      const [id, label] of [[principalId, "grantee"], [strangerId, "stranger"]]
    ) {
      const userId = crypto.randomUUID();
      seededUsers.push(userId);
      await db`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${userId}, ${label}, ${`${userId}@example.test`}, true, ${now}, ${now})`;
      await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
        values (${id}, ${userId}, ${label}, 'human')`;
    }
    await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
      values (${serverId}, ${organizationId}, 'fs', 'FS', 'stdio', ${
      db.json({})
    }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
      values (${connectionId}, ${organizationId}, ${serverId}, null, ${hostId}, 'local', '{}'::jsonb, null, ${
      db.json(["search"])
    }, 'enabled', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }] })
    }, ${DIGEST_A}, ${now})`;
    // The grant names the OTHER principal.
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, ${snapshotId}, ${DIGEST_A}, ${strangerId}, ${
      db.json(["search"])
    }, false, ${now}, ${now}, 1)`;

    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId,
          actorRef: principalId,
          connectionId,
          toolName: "search",
          pinnedDigest: DIGEST_A,
          arguments: {},
          hostId,
        },
      );
    } catch (error) {
      denial = (error as { params?: { reason?: string } }).params?.reason;
    }
    assertEquals(denial, "grant_revoked");
    assertEquals(
      transport.calls,
      [],
      "another actor's grant must not dispatch",
    );
  } finally {
    // Two humans and the worker were seeded here, so both users and all three
    // principals are named; the ids loop above is scoped to the try block.
    await removeOrganization(db, organizationId, {
      userIds: seededUsers,
      principalIds: [
        principalId,
        strangerId,
        ...(worker ? [worker.principalId] : []),
      ],
    });
    await closeDatabase(db);
  }
});

Deno.test("AC2: a stdio connection with no bound host is ineligible anywhere", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  // The worker host is seeded inside the try but its principal is deleted in
  // finally, so the handle lives here.
  let worker: Awaited<ReturnType<typeof seedWorkerHost>> | undefined;
  try {
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'org', ${`o-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    worker = await seedWorkerHost(db, organizationId);
    const hostId = worker.hostId;
    await db`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, 'actor', ${`${userId}@example.test`}, true, ${now}, ${now})`;
    await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${userId}, 'actor', 'human')`;
    await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
      values (${serverId}, ${organizationId}, 'fs', 'FS', 'stdio', ${
      db.json({})
    }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;
    // A stdio connection that names NO host: it cannot legitimately run anywhere.
    await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
      values (${connectionId}, ${organizationId}, ${serverId}, null, null, 'homeless', '{}'::jsonb, null, ${
      db.json(["search"])
    }, 'enabled', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }] })
    }, ${DIGEST_A}, ${now})`;
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, ${snapshotId}, ${DIGEST_A}, ${principalId}, ${
      db.json(["search"])
    }, false, ${now}, ${now}, 1)`;

    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId,
          actorRef: principalId,
          connectionId,
          toolName: "search",
          pinnedDigest: DIGEST_A,
          arguments: {},
          hostId,
        },
      );
    } catch (error) {
      denial = (error as { params?: { reason?: string } }).params?.reason;
    }
    assertEquals(denial, "host_ineligible");
    assertEquals(
      transport.calls,
      [],
      "an unhomed stdio server must not dispatch",
    );
  } finally {
    await removeOrganization(db, organizationId, {
      userIds: [userId],
      principalIds: [principalId, ...(worker ? [worker.principalId] : [])],
    });
    await closeDatabase(db);
  }
});

Deno.test("AC1: a tool outside the binding's operations is refused", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  // The worker host is seeded inside the try but its principal is deleted in
  // finally, so the handle lives here.
  let worker: Awaited<ReturnType<typeof seedWorkerHost>> | undefined;
  try {
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'org', ${`o-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    worker = await seedWorkerHost(db, organizationId);
    const hostId = worker.hostId;
    await db`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${userId}, 'actor', ${`${userId}@example.test`}, true, ${now}, ${now})`;
    await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
      values (${principalId}, ${userId}, 'actor', 'human')`;
    await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
      values (${serverId}, ${organizationId}, 'fs', 'FS', 'stdio', ${
      db.json({})
    }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
      values (${connectionId}, ${organizationId}, ${serverId}, null, ${hostId}, 'local', '{}'::jsonb, null, ${
      db.json(["search", "delete"])
    }, 'enabled', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }, { name: "delete" }] })
    }, ${DIGEST_A}, ${now})`;
    // Enabled on the connection, but NOT in the binding's operation list.
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, ${snapshotId}, ${DIGEST_A}, ${principalId}, ${
      db.json(["search"])
    }, false, ${now}, ${now}, 1)`;

    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId,
          actorRef: principalId,
          connectionId,
          toolName: "delete",
          pinnedDigest: DIGEST_A,
          arguments: {},
          hostId,
        },
      );
    } catch (error) {
      denial = (error as { params?: { reason?: string } }).params?.reason;
    }
    assertEquals(denial, "grant_revoked");
    assertEquals(transport.calls, [], "allowed_operations must gate dispatch");
  } finally {
    await removeOrganization(db, organizationId, {
      userIds: [userId],
      principalIds: [principalId, ...(worker ? [worker.principalId] : [])],
    });
    await closeDatabase(db);
  }
});

/**
 * Seed a connection with a binding pinned to `pinnedSnapshotId`, which may
 * deliberately belong to a different connection. Shared by the cases below so
 * each test states only the thing it is about.
 */
async function seedPinnedConnection(
  db: ReturnType<typeof openDatabase>,
  options: {
    organizationId: string;
    principalId: string;
    hostId: string;
    /** The connection the pinned snapshot belongs to; defaults to the new one. */
    snapshotOwnedBy?: "this" | "other";
    /** The binding's owner slot, left unset for an organization-wide grant. */
    stepKey?: string;
    /** Whether the dispatching host can run work. */
    hostEligible?: boolean;
  },
): Promise<{ connectionId: string; snapshotId: string; digest: string }> {
  const serverId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const snapshotId = crypto.randomUUID();
  const now = new Date();
  const digest = digestFor(snapshotId);
  await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
    values (${serverId}, ${options.organizationId}, ${`s-${serverId}`}, 'FS', 'stdio', ${
    db.json({})
  }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;

  // A second connection exists purely so a snapshot can be pinned that belongs
  // to a different remote.
  let snapshotConnectionId = connectionId;
  if (options.snapshotOwnedBy === "other") {
    const otherServerId = crypto.randomUUID();
    snapshotConnectionId = crypto.randomUUID();
    await db`insert into bakery.mcp_servers (id, organization_id, slug, name, transport, launch_spec, endpoint_template, config_schema, required_capabilities, source_revision, enabled, created_at, updated_at, version)
      values (${otherServerId}, ${options.organizationId}, ${`s-${otherServerId}`}, 'Other', 'stdio', ${
      db.json({})
    }, null, '{}'::jsonb, '[]'::jsonb, 'rev', true, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
      values (${snapshotConnectionId}, ${options.organizationId}, ${otherServerId}, null, ${options.hostId}, 'other', '{}'::jsonb, null, ${
      db.json(["search"])
    }, 'enabled', null, ${now}, ${now}, 1)`;
  }
  await db`insert into bakery.mcp_connections (id, organization_id, server_id, integration_connection_id, worker_host_id, label, config, secret_id, enabled_capabilities, status, current_snapshot_id, created_at, updated_at, version)
    values (${connectionId}, ${options.organizationId}, ${serverId}, null, ${options.hostId}, 'local', '{}'::jsonb, null, ${
    db.json(["search"])
  }, 'enabled', null, ${now}, ${now}, 1)`;
  await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
    values (${snapshotId}, ${options.organizationId}, ${snapshotConnectionId}, ${now}, '2026-07-28', ${
    db.json({ tools: [{ name: "search" }] })
  }, ${digest}, ${now})`;
  if (options.snapshotOwnedBy !== "other") {
    await db`update bakery.mcp_connections set current_snapshot_id = ${snapshotId}
      where organization_id = ${options.organizationId} and id = ${connectionId}`;
  }
  await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, mcp_snapshot_id, mcp_snapshot_digest, actor_ref, step_key, allowed_operations, required, created_at, updated_at, version)
    values (${crypto.randomUUID()}, ${options.organizationId}, ${connectionId}, ${snapshotId}, ${digest}, ${options.principalId}, ${
    options.stepKey ?? null
  }, ${db.json(["search"])}, false, ${now}, ${now}, 1)`;
  return { connectionId, snapshotId, digest };
}

/** A 64-hex digest that is unique per label, matching the contract's shape. */
function digestFor(label: string): string {
  const seed = label.replaceAll("-", "");
  return (seed + "0".repeat(64)).slice(0, 64);
}

/** Seed an organization, a human principal and a worker host for the cases below. */
async function seedWorld(db: ReturnType<typeof openDatabase>, label: string) {
  const organizationId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date();
  await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
    values (${organizationId}, ${label}, ${`${label}-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
  await db`insert into public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    values (${userId}, ${label}, ${`${userId}@example.test`}, true, ${now}, ${now})`;
  await db`insert into bakery.principals (id, provider_user_id, display_name, principal_type)
    values (${principalId}, ${userId}, ${label}, 'human')`;
  const worker = await seedWorkerHost(db, organizationId);
  return { organizationId, principalId, userId, hostId: worker.hostId, worker };
}

Deno.test("HIGH: a snapshot pinned from another connection is refused", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const world = await seedWorld(db, "foreign-snapshot");
  const worker = world.worker;
  try {
    const seeded = await seedPinnedConnection(db, {
      organizationId: world.organizationId,
      principalId: world.principalId,
      hostId: world.hostId,
      snapshotOwnedBy: "other",
    });
    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId: world.organizationId,
          actorRef: world.principalId,
          connectionId: seeded.connectionId,
          toolName: "search",
          pinnedDigest: seeded.digest,
          arguments: {},
          hostId: world.hostId,
        },
      );
    } catch (error) {
      denial = (error as { params?: { reason?: string } }).params?.reason;
    }
    // The join requires the snapshot to belong to this connection, so a binding
    // naming another connection's snapshot leaves this one with no pin at all.
    // That is refused as a missing pin rather than as drift: there is nothing
    // here to compare, and calling it drift would imply a comparison happened.
    assertEquals(denial, "snapshot_missing");
    assertEquals(
      transport.calls,
      [],
      "a foreign snapshot must not authorize a call",
    );
  } finally {
    await removeOrganization(db, world.organizationId, {
      userIds: [world.userId],
      principalIds: [
        world.principalId,
        ...(worker ? [worker.principalId] : []),
      ],
    });
    await closeDatabase(db);
  }
});

Deno.test("MEDIUM: an ineligible worker host is refused even when the caller says otherwise", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const world = await seedWorld(db, "ineligible");
  const worker = world.worker;
  try {
    // The host row says it is not accepting, which is the only opinion that
    // counts: the caller supplies which host it is, never whether it is usable.
    await db`update bakery.worker_hosts set status = 'offline'
      where id = ${world.hostId}`;
    const seeded = await seedPinnedConnection(db, {
      organizationId: world.organizationId,
      principalId: world.principalId,
      hostId: world.hostId,
    });
    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId: world.organizationId,
          actorRef: world.principalId,
          connectionId: seeded.connectionId,
          toolName: "search",
          pinnedDigest: seeded.digest,
          arguments: {},
          hostId: world.hostId,
        },
      );
    } catch (error) {
      denial = (error as { params?: { reason?: string } }).params?.reason;
    }
    assertEquals(denial, "host_ineligible");
    assertEquals(transport.calls, []);
  } finally {
    await removeOrganization(db, world.organizationId, {
      userIds: [world.userId],
      principalIds: [
        world.principalId,
        ...(worker ? [worker.principalId] : []),
      ],
    });
    await closeDatabase(db);
  }
});

Deno.test("MEDIUM: a binding owned by another step does not grant this caller", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const world = await seedWorld(db, "foreign-step");
  const worker = world.worker;
  try {
    const seeded = await seedPinnedConnection(db, {
      organizationId: world.organizationId,
      principalId: world.principalId,
      hostId: world.hostId,
      stepKey: "someone-elses-step",
    });
    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId: world.organizationId,
          actorRef: world.principalId,
          connectionId: seeded.connectionId,
          toolName: "search",
          pinnedDigest: seeded.digest,
          arguments: {},
          hostId: world.hostId,
          stepKey: "my-step",
        },
      );
    } catch (error) {
      denial = (error as { params?: { reason?: string } }).params?.reason;
    }
    // The step filter removes the binding from consideration, so no grant is
    // live for this caller: the same refusal a revoked binding produces, which
    // is correct - from this caller's side there is no grant.
    assertEquals(denial, "grant_revoked");
    assertEquals(
      transport.calls,
      [],
      "a step-scoped grant must not stand in for an organization-wide one",
    );
  } finally {
    await removeOrganization(db, world.organizationId, {
      userIds: [world.userId],
      principalIds: [
        world.principalId,
        ...(worker ? [worker.principalId] : []),
      ],
    });
    await closeDatabase(db);
  }
});

Deno.test("MEDIUM: a schema that returns to an earlier digest is a new observation", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const world = await seedWorld(db, "aba");
  const worker = world.worker;
  try {
    const seeded = await seedPinnedConnection(db, {
      organizationId: world.organizationId,
      principalId: world.principalId,
      hostId: world.hostId,
    });
    // A -> B -> A: the second A is a fresh observation, and storing it must not
    // collide with the first. A unique (connection, digest) index would reject
    // this and make a legitimate re-discovery impossible.
    const now = new Date();
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${crypto.randomUUID()}, ${world.organizationId}, ${seeded.connectionId}, ${new Date(
      now.getTime() + 1000,
    )}, '2026-07-28', ${db.json({ tools: [{ name: "other" }] })}, ${
      digestFor("mid")
    }, ${now})`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${crypto.randomUUID()}, ${world.organizationId}, ${seeded.connectionId}, ${new Date(
      now.getTime() + 2000,
    )}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }] })
    }, ${seeded.digest}, ${now})`;

    // The latest observation is the returned A, so the pinned snapshot is no
    // longer current: that is drift, not silence.
    const transport = recordingTransport();
    let denial: string | undefined;
    try {
      await invokeMcpTool(
        { pinnedState: createPostgresMcpPinnedStatePort(db), transport },
        {
          organizationId: world.organizationId,
          actorRef: world.principalId,
          connectionId: seeded.connectionId,
          toolName: "search",
          pinnedDigest: seeded.digest,
          arguments: {},
          hostId: world.hostId,
        },
      );
    } catch (error) {
      denial = (error as { params?: { reason?: string } }).params?.reason;
    }
    // Pinned A, current is the later A with the same digest: the digests match,
    // so this call is allowed - the point is that the insert did not fail.
    assertEquals(denial, undefined);
    assertEquals(transport.calls, [`${seeded.connectionId}:search`]);
  } finally {
    await removeOrganization(db, world.organizationId, {
      userIds: [world.userId],
      principalIds: [
        world.principalId,
        ...(worker ? [worker.principalId] : []),
      ],
    });
    await closeDatabase(db);
  }
});

Deno.test("a connection with no current snapshot is refused, not waved through", () => {
  // A pin with no current snapshot means nothing can be compared. Treating that
  // as "no drift" would let an unverifiable call through, so it is a denial.
  //
  // Called directly because the query now requires the pinned snapshot to belong
  // to the connection, which makes a null current snapshot unreachable through
  // the seeded world - and an unreachable branch still needs its own guard.
  const digest = digestFor("solo");
  const denial = mcpInvocationDenial(
    { toolName: "search", pinnedDigest: digest, hostId: "host-1" },
    {
      connectionStatus: "enabled",
      transport: "stdio",
      workerHostId: "host-1",
      enabledCapabilities: ["search"],
      allowedOperations: ["search"],
      dispatchingHostEligible: true,
      grantLive: true,
      pinnedSnapshot: { id: "snap", digest, toolNames: ["search"] },
      currentSnapshot: null,
    },
  );
  assertEquals(denial?.denial, "schema_drift");
});
