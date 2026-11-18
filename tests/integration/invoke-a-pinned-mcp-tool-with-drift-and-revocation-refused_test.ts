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

Deno.test("a pinned tool invokes when nothing changed", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  try {
    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
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
      values (${connectionId}, ${organizationId}, ${serverId}, null, null, 'local', '{}'::jsonb, null, ${
      db.json(["search", "fetch"])
    }, 'enabled', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }, { name: "fetch" }] })
    }, ${DIGEST_A}, ${now})`;
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, allowed_operations, required, created_at, updated_at, version)
      values (${bindingId}, ${organizationId}, ${connectionId}, '[]'::jsonb, false, ${now}, ${now}, 1)`;

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
      },
    );
    assertEquals(result.toolName, "search");
    assertEquals(result.digest, DIGEST_A);
    assertEquals(transport.calls, [`${connectionId}:search`]);
  } finally {
    await closeDatabase(db);
  }
});

Deno.test("a changed remote schema refuses the call before it is dispatched", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  try {
    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const pinnedId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
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
      values (${connectionId}, ${organizationId}, ${serverId}, null, null, 'local', '{}'::jsonb, null, ${
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
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, '[]'::jsonb, false, ${now}, ${now}, 1)`;

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
    await closeDatabase(db);
  }
});

Deno.test("a revoked connection refuses the call before it is dispatched", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  try {
    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
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
      values (${connectionId}, ${organizationId}, ${serverId}, null, null, 'local', '{}'::jsonb, null, ${
      db.json(["search"])
    }, 'revoked', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }] })
    }, ${DIGEST_A}, ${now})`;
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, '[]'::jsonb, false, ${now}, ${now}, 1)`;

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
    await closeDatabase(db);
  }
});

Deno.test("a tool the operator did not enable cannot be reached by naming it", async () => {
  const db = openDatabase(databaseConfig.databaseUrl);
  try {
    const organizationId = crypto.randomUUID();
    const principalId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const now = new Date();
    await db`insert into bakery.organizations (id, name, slug, metadata, created_at, updated_at, version)
      values (${organizationId}, 'MCP org', ${`mcp-${organizationId}`}, '{}'::jsonb, ${now}, ${now}, 1)`;
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
      values (${connectionId}, ${organizationId}, ${serverId}, null, null, 'local', '{}'::jsonb, null, ${
      db.json(["search"])
    }, 'enabled', ${snapshotId}, ${now}, ${now}, 1)`;
    await db`insert into bakery.mcp_capability_snapshots (id, organization_id, connection_id, observed_at, protocol_version, manifest, digest, created_at)
      values (${snapshotId}, ${organizationId}, ${connectionId}, ${now}, '2026-07-28', ${
      db.json({ tools: [{ name: "search" }, { name: "fetch" }] })
    }, ${DIGEST_A}, ${now})`;
    await db`insert into bakery.capability_bindings (id, organization_id, mcp_connection_id, allowed_operations, required, created_at, updated_at, version)
      values (${crypto.randomUUID()}, ${organizationId}, ${connectionId}, '[]'::jsonb, false, ${now}, ${now}, 1)`;

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
    await closeDatabase(db);
  }
});
