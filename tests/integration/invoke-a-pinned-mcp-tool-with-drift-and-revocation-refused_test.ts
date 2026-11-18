import { assertEquals } from "@std/assert";
import { readTestDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closeDatabase,
  openDatabase,
} from "../../apps/server/src/platform/database.ts";
import {
  invokeMcpTool,
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
async function removeOrganization(
  db: ReturnType<typeof openDatabase>,
  organizationId: string,
): Promise<void> {
  await db`delete from bakery.organizations where id = ${organizationId}`;
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
): Promise<string> {
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
  return hostId;
}

Deno.test("a pinned tool invokes when nothing changed", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  try {
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    const hostId = await seedWorkerHost(db, organizationId);
    // A human principal is backed by an auth user; the composite constraint says so.
    const userId = crypto.randomUUID();
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
        host: { hostId, eligible: true },
      },
    );
    assertEquals(result.toolName, "search");
    assertEquals(result.digest, DIGEST_A);
    assertEquals(transport.calls, [`${connectionId}:search`]);
  } finally {
    await removeOrganization(db, organizationId);
    await closeDatabase(db);
  }
});

Deno.test("a changed remote schema refuses the call before it is dispatched", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  try {
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const pinnedId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    const hostId = await seedWorkerHost(db, organizationId);
    const userId = crypto.randomUUID();
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
          host: { hostId, eligible: true },
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
    await removeOrganization(db, organizationId);
    await closeDatabase(db);
  }
});

Deno.test("a revoked connection refuses the call before it is dispatched", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  try {
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    const hostId = await seedWorkerHost(db, organizationId);
    const userId = crypto.randomUUID();
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
          host: { hostId, eligible: true },
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
    await removeOrganization(db, organizationId);
    await closeDatabase(db);
  }
});

Deno.test("a tool the operator did not enable cannot be reached by naming it", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  try {
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    const hostId = await seedWorkerHost(db, organizationId);
    const userId = crypto.randomUUID();
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
          host: { hostId, eligible: true },
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
    await removeOrganization(db, organizationId);
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
          host: { hostId: crypto.randomUUID(), eligible: true },
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
  try {
    const principalId = crypto.randomUUID();
    const strangerId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'org', ${`o-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    const hostId = await seedWorkerHost(db, organizationId);
    for (
      const [id, label] of [[principalId, "grantee"], [strangerId, "stranger"]]
    ) {
      const userId = crypto.randomUUID();
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
          host: { hostId, eligible: true },
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
    await removeOrganization(db, organizationId);
    await closeDatabase(db);
  }
});

Deno.test("AC2: a stdio connection with no bound host is ineligible anywhere", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  try {
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    const userId = crypto.randomUUID();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'org', ${`o-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    const hostId = await seedWorkerHost(db, organizationId);
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
          host: { hostId, eligible: true },
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
    await removeOrganization(db, organizationId);
    await closeDatabase(db);
  }
});

Deno.test("AC1: a tool outside the binding's operations is refused", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  const organizationId = crypto.randomUUID();
  try {
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    const userId = crypto.randomUUID();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'org', ${`o-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
    const hostId = await seedWorkerHost(db, organizationId);
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
          host: { hostId, eligible: true },
        },
      );
    } catch (error) {
      denial = (error as { params?: { reason?: string } }).params?.reason;
    }
    assertEquals(denial, "grant_revoked");
    assertEquals(transport.calls, [], "allowed_operations must gate dispatch");
  } finally {
    await removeOrganization(db, organizationId);
    await closeDatabase(db);
  }
});
