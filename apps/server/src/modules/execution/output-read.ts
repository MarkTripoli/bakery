import { Hono } from "hono";
import { z } from "zod";
import {
  ActionAccess,
  type ContractOutput,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  type ActionContext,
  type ActionDefinition,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  OutputImplementedAction,
  outputImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import { OUTPUT_READER_LIMITS } from "@bakery/contracts/output";
import {
  listAuthorizedOutputStreams,
  loadAuthorizedOutputStream,
  type OutputStreamReaderFilters,
  type OutputStreamReaderRecord,
  readAuthorizedOutputBatches,
} from "@bakery/persistence";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import type { ExecutionRouteOptions } from "./shared.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  type CursorBinding,
  decodeCursor,
  decodeSequenceCursor,
  encodeCursor,
  encodeSequenceCursor,
} from "../../platform/cursor.ts";

const DISCOVERY_ORDERING = "createdAt:asc,id:asc";
const READ_ORDERING = "sequence:asc";
const READER_SCHEMA_VERSION = 1;

export const OUTPUT_STREAMS_READ_ACTION: ActionDefinition = Object.freeze({
  name: OutputImplementedAction.StreamsRead,
  method: HttpMethod.Get,
  path: "/v1/output-streams/:streamId",
  input: contractSchemas.OutputStreamReadQuery,
  output: contractSchemas.OutputReadPage,
  policy: Object.freeze({
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  }),
  transactionIsolation: TransactionIsolation.RepeatableRead,
  handler(): never {
    throw new Error("OUTPUT_STREAMS_READ_AUTHORITY_ONLY");
  },
});

type ListInput = z.output<typeof contractSchemas.OutputStreamListQuery>;
type ReadInput = z.output<typeof contractSchemas.OutputStreamReadQuery>;
type StreamPage = ContractOutput<"OutputStreamPage">;
type ReadPage = ContractOutput<"OutputReadPage">;

function normalizedLimit(value: number | undefined): number {
  return value ?? OUTPUT_READER_LIMITS.defaultBatches;
}

function normalizedBytes(value: number | undefined): number {
  return value ?? OUTPUT_READER_LIMITS.defaultPageBytes;
}

function canonicalFilters(input: ListInput): OutputStreamReaderFilters {
  return {
    ...(input.applicationId === undefined
      ? {}
      : { applicationId: input.applicationId }),
    ...(input.repositoryId === undefined
      ? {}
      : { repositoryId: input.repositoryId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.runStepId === undefined ? {} : { runStepId: input.runStepId }),
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
    ...(input.logicalActor === undefined
      ? {}
      : { logicalActor: input.logicalActor }),
  };
}

async function discoveryBinding(
  principalId: string,
  organizationId: string,
  filters: OutputStreamReaderFilters,
): Promise<CursorBinding> {
  return {
    action: OutputImplementedAction.StreamsList,
    principalId,
    organizationId,
    ordering: DISCOVERY_ORDERING,
    filters: await sha256Hex(canonicalJson(filters)),
    schemaVersion: READER_SCHEMA_VERSION,
  };
}

async function outputReadBinding(
  action: "output.streams.read" | "output.subscribe",
  principalId: string,
  organizationId: string,
  stream: OutputStreamReaderRecord,
): Promise<CursorBinding> {
  const scopeDigest = await sha256Hex(canonicalJson({
    streamId: stream.streamId,
    applicationId: stream.applicationId,
    repositoryId: stream.repositoryId,
    taskId: stream.taskId,
    runStepId: stream.runStepId,
    conversationId: stream.conversationId,
    logicalActor: stream.logicalActor,
  }));
  return {
    action,
    principalId,
    organizationId,
    ordering: READ_ORDERING,
    filters: scopeDigest,
    schemaVersion: READER_SCHEMA_VERSION,
  };
}

function encoded<T extends Record<string, unknown>>(
  value: Omit<T, "encodedBytes"> & { encodedBytes?: number },
): T {
  let result = { ...value, encodedBytes: 0 } as unknown as T;
  for (let index = 0; index < 4; index++) {
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    if (result.encodedBytes === bytes) return result;
    result = { ...result, encodedBytes: bytes };
  }
  return result;
}

function assertPageBytes(
  value: { encodedBytes: number },
  maxBytes: number,
): void {
  if (value.encodedBytes > maxBytes) {
    throw new StandardError({
      code: "BODY_TOO_LARGE",
      params: { limit: maxBytes },
    });
  }
}

async function listOutputStreams(
  context: ActionContext,
  rawInput: ListInput,
  secret: string,
): Promise<StreamPage> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const limit = normalizedLimit(rawInput.limit);
  const maxBytes = normalizedBytes(rawInput.maxBytes);
  const filters = canonicalFilters(rawInput);
  const binding = await discoveryBinding(
    principalId,
    organizationId,
    filters,
  );
  const after = await decodeCursor(secret, rawInput.cursor, binding);
  const rows = await listAuthorizedOutputStreams(
    transaction,
    organizationId,
    filters,
    after ? { createdAt: after.createdAt as string, streamId: after.id } : null,
    limit + 1,
  );
  const items: OutputStreamReaderRecord[] = [];
  let nextCursor: string | null = null;
  for (let index = 0; index < Math.min(rows.length, limit); index++) {
    const item = rows[index];
    if (!item) continue;
    const cursor = await encodeCursor(secret, binding, {
      createdAt: item.createdAt,
      id: item.streamId,
    });
    const more = index + 1 < rows.length;
    const trial = encoded<StreamPage>({
      items: [...items, item],
      nextCursor: more ? cursor : null,
    });
    if (trial.encodedBytes > maxBytes) break;
    items.push(item);
    nextCursor = more ? cursor : null;
  }
  if (rows.length > 0 && items.length === 0) {
    throw new StandardError({
      code: "BODY_TOO_LARGE",
      params: { limit: maxBytes },
    });
  }
  if (items.length < Math.min(rows.length, limit)) {
    const last = items.at(-1);
    if (!last) throw new Error("OUTPUT_DISCOVERY_CURSOR_MISSING");
    nextCursor = await encodeCursor(secret, binding, {
      createdAt: last.createdAt,
      id: last.streamId,
    });
  }
  const page = contractSchemas.OutputStreamPage.parse(
    encoded<StreamPage>({ items, nextCursor }),
  ) as StreamPage;
  assertPageBytes(page, maxBytes);
  return page;
}

export async function readOutputPage(
  options: {
    transaction: Parameters<typeof readAuthorizedOutputBatches>[0];
    secret: string;
    principalId: string;
    organizationId: string;
    action: "output.streams.read" | "output.subscribe";
    streamId: string;
    cursor?: string;
    limit?: number;
    maxBytes?: number;
  },
): Promise<ReadPage> {
  const limit = normalizedLimit(options.limit);
  const maxBytes = normalizedBytes(options.maxBytes);
  const stream = await loadAuthorizedOutputStream(
    options.transaction,
    options.organizationId,
    options.streamId,
  );
  const binding = await outputReadBinding(
    options.action,
    options.principalId,
    options.organizationId,
    stream,
  );
  const decoded = await decodeSequenceCursor(
    options.secret,
    options.cursor,
    binding,
  );
  const after = decoded?.sequence ?? null;
  const read = await readAuthorizedOutputBatches(
    options.transaction,
    options.organizationId,
    options.streamId,
    after,
    limit + 1,
    stream,
  );
  if (read.resetFrom !== null) {
    const resumeAfter = (BigInt(read.resetFrom) - 1n).toString();
    const reset = contractSchemas.OutputReadPage.parse(
      encoded<ReadPage>({
        disposition: "reset_required",
        stream: read.stream,
        batches: [],
        cursor: await encodeSequenceCursor(options.secret, binding, {
          sequence: resumeAfter,
        }),
        highwater: read.highwater,
        retainedFrom: read.retainedFrom,
        resumeAfter,
      }),
    ) as ReadPage;
    assertPageBytes(reset, maxBytes);
    return reset;
  }
  const batches: typeof read.batches[number][] = [];
  let cursor = await encodeSequenceCursor(options.secret, binding, {
    sequence: after ?? "0",
  });
  for (let index = 0; index < Math.min(read.batches.length, limit); index++) {
    const batch = read.batches[index];
    if (!batch) continue;
    const candidateCursor = await encodeSequenceCursor(
      options.secret,
      binding,
      {
        sequence: batch.sequence,
      },
    );
    const trial = encoded<ReadPage>({
      disposition: "page",
      stream: read.stream,
      batches: [...batches, batch],
      cursor: candidateCursor,
      highwater: read.highwater,
      retainedFrom: read.retainedFrom,
      resumeAfter: null,
    });
    if (trial.encodedBytes > maxBytes) break;
    batches.push(batch);
    cursor = candidateCursor;
  }
  if (read.batches.length > 0 && batches.length === 0) {
    throw new StandardError({
      code: "BODY_TOO_LARGE",
      params: { limit: maxBytes },
    });
  }
  const page = contractSchemas.OutputReadPage.parse(
    encoded<ReadPage>({
      disposition: "page",
      stream: read.stream,
      batches,
      cursor,
      highwater: read.highwater,
      retainedFrom: read.retainedFrom,
      resumeAfter: null,
    }),
  ) as ReadPage;
  assertPageBytes(page, maxBytes);
  return page;
}

async function readOutputStream(
  context: ActionContext,
  input: ReadInput,
  secret: string,
): Promise<ReadPage> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  return await readOutputPage({
    transaction,
    secret,
    principalId,
    organizationId,
    action: OutputImplementedAction.StreamsRead,
    streamId: input.streamId,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  });
}

export function createOutputReadApp(
  options: ExecutionRouteOptions,
): Hono<{ Variables: AuthVariables }> {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(options.database),
  );
  registry.register({
    name: OutputImplementedAction.StreamsList,
    method: HttpMethod.Get,
    path: "/v1/output-streams",
    input: contractSchemas.OutputStreamListQuery,
    output: contractSchemas.OutputStreamPage,
    policy: {
      type: ActionKind.Query,
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: (context, input) =>
      listOutputStreams(context, input as ListInput, options.secret),
  }).register({
    ...OUTPUT_STREAMS_READ_ACTION,
    handler: (context, input) =>
      readOutputStream(context, input as ReadInput, options.secret),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, outputImplementedActions);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/output-streams", options.browserSession);
  app.use("/v1/output-streams/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
