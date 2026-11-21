import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  connectionId,
  loadVisible,
  requireMayChange,
} from "./connection-commands.ts";
import type { DiscoveredTool } from "./discovery.ts";

/**
 * Tool effect classification (#434, O26).
 *
 * An Admin states what each tool does to the outside world. Server hints are
 * suggestions only: this is the one statement Bakery acts on. A tool nobody has
 * classified is a write that runs at most once, so unclassified is never read as
 * safe. A classification records the snapshot it was made against, so a connection
 * rediscovered since shows it as needing a second look instead of silently
 * describing a tool that may have changed.
 */

type Classification = z.output<typeof contractSchemas.McpToolClassification>;
type ClassificationList = z.output<
  typeof contractSchemas.McpToolClassificationList
>;
type ClassificationPut = z.output<
  typeof contractSchemas.McpToolClassificationPut
>;

const CLASSES = [
  "read",
  "write_idempotent",
  "write_reconcilable",
  "write_opaque",
] as const;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

type Row = {
  tool_name: string;
  effect_class: string;
  effect_key_argument: string | null;
  paired_read_tool: string | null;
  snapshot_digest: string;
  updated_at: Date;
  version: number;
};

const COLUMNS =
  "tool_name, effect_class, effect_key_argument, paired_read_tool, snapshot_digest, updated_at, version";

/** The connection's current snapshot, or null when nothing has been discovered. */
async function currentSnapshot(
  transaction: PgTransactionClient,
  organizationId: string,
  snapshotId: string | null,
): Promise<{ digest: string; tools: DiscoveredTool[] } | null> {
  if (snapshotId === null) return null;
  const result = await transaction.query<{ digest: string; manifest: unknown }>(
    `select digest, manifest from bakery.mcp_capability_snapshots
      where organization_id = $1 and id = $2`,
    [organizationId, snapshotId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const tools = (row.manifest as { tools?: DiscoveredTool[] } | null)?.tools;
  return { digest: row.digest, tools: Array.isArray(tools) ? tools : [] };
}

function toItem(
  toolName: string,
  row: Row | undefined,
  digest: string,
): Classification {
  if (!row) {
    // How Bakery treats a tool nobody classified.
    return {
      toolName,
      effectClass: "write_opaque",
      classified: false,
      effectKeyArgument: null,
      pairedReadTool: null,
      classifiedAgainstCurrentSnapshot: true,
      classifiedAt: null,
      version: 0,
    } as Classification;
  }
  return {
    toolName,
    effectClass: row.effect_class,
    classified: true,
    effectKeyArgument: row.effect_key_argument,
    pairedReadTool: row.paired_read_tool,
    classifiedAgainstCurrentSnapshot: row.snapshot_digest === digest,
    classifiedAt: row.updated_at.toISOString(),
    version: row.version,
  } as Classification;
}

function toolName(context: ActionContext): string {
  const name = context.params.toolName;
  if (!name || !TOOL_NAME.test(name)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return name;
}

/** `mcpToolClassifications.list`: every tool of the current snapshot, in name order. */
export async function listMcpToolClassifications(
  context: ActionContext,
): Promise<ClassificationList> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const connection = await loadVisible(
    transaction,
    { organizationId, principalId },
    connectionId(context),
  );
  const snapshot = await currentSnapshot(
    transaction,
    organizationId,
    connection.current_snapshot_id,
  );
  if (!snapshot) return { items: [] };
  const rows = (await transaction.query<Row>(
    `select ${COLUMNS} from bakery.mcp_tool_classifications
      where organization_id = $1 and connection_id = $2`,
    [organizationId, connection.id],
  )).rows;
  const byTool = new Map(rows.map((row) => [row.tool_name, row] as const));
  return {
    items: snapshot.tools
      .map((tool) => tool.name)
      .sort()
      .map((name) => toItem(name, byTool.get(name), snapshot.digest)),
  };
}

/**
 * `mcpToolClassifications.put`: an Admin for an organization connection, the owner
 * for a personal one. Creates the classification when absent and replaces it when
 * present, the latter only with the version it read.
 */
export async function putMcpToolClassification(
  context: ActionContext,
  input: ClassificationPut,
): Promise<Classification> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const name = toolName(context);
  const connection = await loadVisible(
    transaction,
    { organizationId, principalId },
    connectionId(context),
    { lock: true },
  );
  requireMayChange(context, connection);
  const snapshot = await currentSnapshot(
    transaction,
    organizationId,
    connection.current_snapshot_id,
  );
  const tool = snapshot?.tools.find((entry) => entry.name === name);
  if (!snapshot || !tool) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }

  const keyArgument = input.effectKeyArgument ?? null;
  const pairedRead = input.pairedReadTool ?? null;
  if (input.effectClass === "write_idempotent") {
    if (keyArgument === null) {
      throw unprocessable(["effectKeyArgument"], "effect_key_required");
    }
    const properties = (tool.inputSchema as { properties?: unknown })
      .properties;
    if (
      !properties || typeof properties !== "object" ||
      !Object.hasOwn(properties, keyArgument)
    ) {
      throw unprocessable(["effectKeyArgument"], "effect_key_unknown_argument");
    }
  } else if (keyArgument !== null) {
    throw unprocessable(["effectKeyArgument"], "effect_key_not_allowed");
  }
  if (input.effectClass === "write_reconcilable") {
    if (pairedRead === null) {
      throw unprocessable(["pairedReadTool"], "paired_read_required");
    }
    if (pairedRead === name) {
      throw unprocessable(["pairedReadTool"], "paired_read_is_self");
    }
    if (!snapshot.tools.some((entry) => entry.name === pairedRead)) {
      throw unprocessable(["pairedReadTool"], "paired_read_unknown_tool");
    }
    const paired = await transaction.query<{ effect_class: string }>(
      `select effect_class from bakery.mcp_tool_classifications
        where organization_id = $1 and connection_id = $2 and tool_name = $3`,
      [organizationId, connection.id, pairedRead],
    );
    if (paired.rows[0]?.effect_class !== "read") {
      throw unprocessable(["pairedReadTool"], "paired_read_not_read");
    }
  } else if (pairedRead !== null) {
    throw unprocessable(["pairedReadTool"], "paired_read_not_allowed");
  }

  const existing = (await transaction.query<Row>(
    `select ${COLUMNS} from bakery.mcp_tool_classifications
      where organization_id = $1 and connection_id = $2 and tool_name = $3
        for update`,
    [organizationId, connection.id, name],
  )).rows[0];
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (existing === undefined) {
    // Nothing to hold the caller to: a version names something that is not there.
    if (expectedVersion !== undefined) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (existing.version !== expectedVersion) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    // Other tools may name this one as their confirming read; it must stay a read.
    if (existing.effect_class === "read" && input.effectClass !== "read") {
      const dependents = await transaction.query(
        `select 1 from bakery.mcp_tool_classifications
          where organization_id = $1 and connection_id = $2
            and paired_read_tool = $3 limit 1`,
        [organizationId, connection.id, name],
      );
      if (dependents.rows.length > 0) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "tool_is_a_paired_read" },
        });
      }
    }
  }

  try {
    if (existing === undefined) {
      await transaction.query(
        `insert into bakery.mcp_tool_classifications (
           organization_id, connection_id, tool_name, effect_class,
           effect_key_argument, paired_read_tool, snapshot_digest, classified_by
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          organizationId,
          connection.id,
          name,
          input.effectClass,
          keyArgument,
          pairedRead,
          snapshot.digest,
          principalId,
        ],
      );
    } else {
      await transaction.query(
        `update bakery.mcp_tool_classifications
            set effect_class = $4, effect_key_argument = $5,
                paired_read_tool = $6, snapshot_digest = $7, classified_by = $8,
                updated_at = now(), version = version + 1
          where organization_id = $1 and connection_id = $2 and tool_name = $3`,
        [
          organizationId,
          connection.id,
          name,
          input.effectClass,
          keyArgument,
          pairedRead,
          snapshot.digest,
          principalId,
        ],
      );
    }
  } catch (error) {
    // Two first classifications racing: the loser did not read a version.
    if (postgresErrorCode(error) === "23505") {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    throw error;
  }
  const written = (await transaction.query<Row>(
    `select ${COLUMNS} from bakery.mcp_tool_classifications
      where organization_id = $1 and connection_id = $2 and tool_name = $3`,
    [organizationId, connection.id, name],
  )).rows[0]!;
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "mcpToolClassifications.put",
    resourceType: "mcp_connection",
    resourceId: connection.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      toolName: name,
      effectClass: input.effectClass,
      previousEffectClass: existing?.effect_class ?? null,
      effectKeyArgument: keyArgument,
      pairedReadTool: pairedRead,
      snapshotDigest: snapshot.digest,
    },
  });
  return toItem(name, written, snapshot.digest);
}

export { CLASSES as MCP_EFFECT_CLASSES };
