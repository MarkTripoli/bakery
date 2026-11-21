import type { z } from "zod";
import type { SecretsKeyConfig } from "@bakery/config";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError, unprocessable } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  decryptMcpCredential,
  loadSecretKey,
  SecretCipherSchema,
} from "../secrets/crypto.ts";
import {
  connectionId,
  loadVisible,
  requireMayChange,
} from "./connection-commands.ts";
import {
  type DiscoveredTool,
  discoverTools,
  DiscoveryError,
  type DiscoveryFailure,
  resolveEndpoint,
} from "./discovery.ts";
import type { McpTransport } from "./discovery-transport.ts";

/**
 * `mcpConnections.discover` and `mcpConnections.capabilities` (#434).
 *
 * Discovery asks the server what tools it has and pins the answer as an immutable
 * snapshot. It observes and never grants: nothing is enabled, and no binding's pin
 * moves. A changed digest does move the connection's current snapshot, which is
 * exactly what makes a tool someone pinned earlier refuse admission as drifted
 * until a person looks at what changed and chooses to update.
 *
 * The outbound request runs inside the action's transaction, bounded by one
 * deadline (10 seconds); the connection row is locked only afterwards, to write.
 */

type SnapshotOutput = z.output<typeof contractSchemas.McpCapabilitySnapshot>;

export type McpDiscoveryDependencies = {
  secretsKey: SecretsKeyConfig | undefined;
  transport: McpTransport;
};

type SnapshotRow = {
  id: string;
  connection_id: string;
  observed_at: Date;
  protocol_version: string;
  manifest: unknown;
  digest: string;
  created_at: Date;
};

const SNAPSHOT_COLUMNS =
  "id, connection_id, observed_at, protocol_version, manifest, digest, created_at";

/** A snapshot never changes, so its "update" time is its creation and its version is 1. */
function toSnapshot(row: SnapshotRow): SnapshotOutput {
  return {
    id: row.id,
    connectionId: row.connection_id,
    observedAt: row.observed_at.toISOString(),
    protocolVersion: row.protocol_version,
    manifest: row.manifest,
    digest: row.digest,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.created_at.toISOString(),
    version: 1,
  } as SnapshotOutput;
}

function toolsOf(manifest: unknown): Map<string, string> {
  const tools = (manifest as { tools?: DiscoveredTool[] } | null)?.tools ?? [];
  return new Map(
    tools.map((tool) => [tool.name, JSON.stringify(tool)] as const),
  );
}

/** What changed between two manifests, as tool names. */
export function manifestChanges(before: unknown, after: unknown) {
  const was = toolsOf(before);
  const now = toolsOf(after);
  const added = [...now.keys()].filter((name) => !was.has(name)).sort();
  const removed = [...was.keys()].filter((name) => !now.has(name)).sort();
  const changed = [...now.keys()]
    .filter((name) => was.has(name) && was.get(name) !== now.get(name))
    .sort();
  return { added, removed, changed };
}

/** The connection's credential as plaintext, for the one request that needs it. */
async function loadBearerToken(
  transaction: PgTransactionClient,
  organizationId: string,
  secretId: string | null,
  secretsKey: SecretsKeyConfig | undefined,
): Promise<string | null> {
  if (secretId === null) return null;
  const result = await transaction.query<{
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    key_id: string;
    revision: number;
  }>(
    `select version.ciphertext, version.nonce, version.key_id, version.revision
       from bakery.secrets as secret
       join bakery.secret_versions as version
         on version.id = secret.active_version_id and version.secret_id = secret.id
      where secret.organization_id = $1 and secret.id = $2
        and secret.application_id is null and secret.revoked_at is null`,
    [organizationId, secretId],
  );
  const row = result.rows[0];
  if (!row) throw new StandardError({ code: "STATE_CONFLICT" });
  const plain = await decryptMcpCredential(
    await loadSecretKey(secretsKey),
    { organizationId, secretId, revision: row.revision, keyId: row.key_id },
    SecretCipherSchema.parse({ ciphertext: row.ciphertext, nonce: row.nonce }),
  );
  try {
    return new TextDecoder().decode(plain);
  } finally {
    plain.fill(0);
  }
}

function failure(reason: DiscoveryFailure): StandardError {
  if (
    reason === "config_missing_placeholder" || reason === "endpoint_invalid"
  ) {
    return unprocessable(["config"], reason);
  }
  return new StandardError({
    code: "DEPENDENCY_UNAVAILABLE",
    params: { reason },
  });
}

/** `mcpConnections.capabilities`: the snapshot discovery last pinned. */
export async function getMcpCapabilities(
  context: ActionContext,
): Promise<SnapshotOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const row = await loadVisible(
    transaction,
    { organizationId, principalId },
    connectionId(context),
  );
  if (row.current_snapshot_id === null) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const snapshot = await transaction.query<SnapshotRow>(
    `select ${SNAPSHOT_COLUMNS} from bakery.mcp_capability_snapshots
      where organization_id = $1 and id = $2`,
    [organizationId, row.current_snapshot_id],
  );
  if (!snapshot.rows[0]) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return toSnapshot(snapshot.rows[0]);
}

export function createMcpDiscoverer(dependencies: McpDiscoveryDependencies) {
  return async (context: ActionContext): Promise<SnapshotOutput> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const actor = { organizationId, principalId };
    const id = connectionId(context);
    const connection = await loadVisible(transaction, actor, id);
    requireMayChange(context, connection);
    if (connection.status !== "enabled") {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "mcp_connection_not_enabled" },
      });
    }
    const server = (await transaction.query<{
      enabled: boolean;
      endpoint_template: string | null;
    }>(
      `select enabled, endpoint_template from bakery.mcp_servers
        where organization_id = $1 and id = $2`,
      [organizationId, connection.server_id],
    )).rows[0];
    if (!server) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    if (!server.enabled || server.endpoint_template === null) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "mcp_server_disabled" },
      });
    }

    let found;
    try {
      const endpoint = resolveEndpoint(
        server.endpoint_template,
        connection.config,
      );
      const token = await loadBearerToken(
        transaction,
        organizationId,
        connection.secret_id,
        dependencies.secretsKey,
      );
      found = await discoverTools(dependencies.transport, {
        endpoint,
        bearerToken: token,
      });
    } catch (error) {
      if (error instanceof DiscoveryError) throw failure(error.reason);
      throw error;
    }

    // Write under the connection's lock, so two discoveries cannot both pin.
    const locked = await loadVisible(transaction, actor, id, { lock: true });
    const latest = (await transaction.query<SnapshotRow>(
      `select ${SNAPSHOT_COLUMNS} from bakery.mcp_capability_snapshots
        where organization_id = $1 and connection_id = $2
        order by observed_at desc, id desc limit 1`,
      [organizationId, id],
    )).rows[0];
    const unchanged = latest !== undefined && latest.digest === found.digest;
    let snapshot: SnapshotRow;
    if (unchanged) {
      snapshot = latest;
    } else {
      snapshot = (await transaction.query<SnapshotRow>(
        `insert into bakery.mcp_capability_snapshots
           (organization_id, connection_id, observed_at, protocol_version,
            manifest, digest)
         values ($1, $2, now(), $3, $4::jsonb, $5)
         returning ${SNAPSHOT_COLUMNS}`,
        [
          organizationId,
          id,
          found.protocolVersion,
          JSON.stringify(found.manifest),
          found.digest,
        ],
      )).rows[0]!;
    }
    if (locked.current_snapshot_id !== snapshot.id) {
      await transaction.query(
        `update bakery.mcp_connections
            set current_snapshot_id = $3, updated_at = now(), version = version + 1
          where organization_id = $1 and id = $2`,
        [organizationId, id, snapshot.id],
      );
    }
    const changes = manifestChanges(latest?.manifest ?? null, found.manifest);
    await appendAudit(transaction, {
      organizationId,
      principalId,
      operation: "mcpConnections.discover",
      resourceType: "mcp_connection",
      resourceId: id,
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        digest: found.digest,
        previousDigest: latest?.digest ?? null,
        unchanged,
        toolCount: found.manifest.tools.length,
        // Names only, bounded: what changed, never a schema or a description.
        added: changes.added.slice(0, 50),
        removed: changes.removed.slice(0, 50),
        changed: changes.changed.slice(0, 50),
      },
    });
    return toSnapshot(snapshot);
  };
}
