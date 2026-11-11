import type { BudgetRuntimeConfig, InngestRuntimeConfig } from "@bakery/config";
import type { PgDatabase } from "@bakery/persistence";
import { Inngest } from "inngest";
import { serve } from "inngest/hono";
import {
  createBakeryFixedWorkflow,
  createBakeryWorkflowRecovery,
} from "../workflow-adapter/bakery-postgres-store.ts";
import { createBakeryBudgetRecovery } from "../work/budget-recovery.ts";
import {
  createSkillImportRecovery,
  createSkillImportWorkflow,
  type SkillImportProcessHooks,
} from "../catalog/import-workflow.ts";
import type { SkillSourceAdapter } from "../catalog/source-adapters.ts";
import type { SkillFileStoreOperations } from "../catalog/storage.ts";
import { createIntegrationFactSweep } from "../integrations/fact-sweep.ts";
import { createIntegrationLifecycleSweep } from "../integrations/lifecycle-workflow.ts";
import {
  createIntegrationDiscoveryRecovery,
  createIntegrationDiscoveryWorkflow,
} from "../integrations/discovery-workflow.ts";
import { createIntegrationIntakeRetention } from "../integrations/intake-retention.ts";
import {
  createIntegrationIntakeRecovery,
  createIntegrationIntakeWorkflow,
} from "../integrations/intake-workflow.ts";
import type { ReconcileDependencies } from "../integrations/reconcile.ts";
import {
  createTicketFactIndex,
  createTicketSourceReader,
} from "../integrations/ticket-reads.ts";
import {
  createTicketIntakeWorkflow,
  createTicketPollWorkflow,
} from "../work/ticket-workflows.ts";
import { createAuditRetentionFunction } from "../auth/audit/mod.ts";

import { createOutputArchiveWorkflow } from "./output-archive.ts";
import {
  type CoordinatorTurnExecutor,
  readCoordinatorExecutor,
} from "../conversation/coordinator.ts";
import {
  createConversationTurnRecovery,
  createConversationTurnWorkflow,
} from "../conversation/turn-runtime.ts";

type ServeOptions = Parameters<typeof serve>[0];

/**
 * The GitHub client, AES key and the API's own token broker, so a
 * reconcile in a background function invalidates the tokens the API caches.
 */
export type IntegrationsBackgroundDependencies = Omit<
  ReconcileDependencies,
  "database"
>;

type SkillImportDependencies = Readonly<{
  sourceAdapter: SkillSourceAdapter;
  skillFileStore: SkillFileStoreOperations;
  processHooks?: SkillImportProcessHooks;
}>;

/**
 * The ticket admission functions: a verified issue delivery and the five
 * minute poll. They share one live reader and fact index, and the server
 * budget policy, without which the fixed preset is never available.
 */
function createTicketAutomation(options: {
  client: Inngest;
  database: PgDatabase;
  budget?: BudgetRuntimeConfig;
  integrations: IntegrationsBackgroundDependencies;
}) {
  const deps = {
    client: options.client,
    database: options.database,
    reader: createTicketSourceReader({
      database: options.database,
      ...options.integrations,
    }),
    factIndex: createTicketFactIndex(),
    budget: options.budget,
  };
  return [createTicketIntakeWorkflow(deps), createTicketPollWorkflow(deps)];
}

export function createDefaultInngestFunctions(options: {
  config: InngestRuntimeConfig;
  database: PgDatabase;
  client: Inngest;
  budget?: BudgetRuntimeConfig;
  skillImport?: SkillImportDependencies;
  /** GitHub integration lifecycle and intake; their functions register only when present. */
  integrations?: IntegrationsBackgroundDependencies;
  /** Coordinator executor override; default is the worker executor outside the test environment (see `readCoordinatorExecutor`). */
  coordinatorExecutor?: CoordinatorTurnExecutor;
}): readonly unknown[] {
  const coordinatorExecutor = options.coordinatorExecutor ??
    readCoordinatorExecutor(undefined, {
      database: options.database,
      budget: options.budget,
    });
  return [
    createBakeryFixedWorkflow({
      client: options.client,
      database: options.database,
      maxAttempts: options.config.maxAttempts,
      waitMs: options.config.waitMs,
      jobCompletionTimeout: options.config.jobCompletionTimeout,
      engineRetries: options.config.engineRetries,
      budgetPolicy: options.budget,
    }),
    createBakeryWorkflowRecovery({
      client: options.client,
      database: options.database,
      budgetPolicy: options.budget,
    }),
    createBakeryBudgetRecovery({
      client: options.client,
      database: options.database,
    }),
    ...(options.skillImport
      ? [
        createSkillImportWorkflow({
          client: options.client,
          database: options.database,
          sourceAdapter: options.skillImport.sourceAdapter,
          skillFileStore: options.skillImport.skillFileStore,
          processHooks: options.skillImport.processHooks,
        }),
        createSkillImportRecovery({
          client: options.client,
          database: options.database,
        }),
      ]
      : []),
    createOutputArchiveWorkflow({
      client: options.client,
      database: options.database,
    }),
    createConversationTurnWorkflow({
      client: options.client,
      database: options.database,
      executor: coordinatorExecutor,
    }),
    createConversationTurnRecovery({
      client: options.client,
      database: options.database,
    }),
    ...(options.integrations
      ? [
        createIntegrationLifecycleSweep({
          client: options.client,
          database: options.database,
          ...options.integrations,
        }),
        createIntegrationDiscoveryWorkflow({
          client: options.client,
          database: options.database,
          ...options.integrations,
        }),
        createIntegrationDiscoveryRecovery({
          client: options.client,
          database: options.database,
        }),
        createIntegrationIntakeWorkflow({
          client: options.client,
          database: options.database,
          ...options.integrations,
        }),
        createIntegrationIntakeRecovery({
          client: options.client,
          database: options.database,
        }),
        createIntegrationIntakeRetention({
          client: options.client,
          database: options.database,
        }),
        createIntegrationFactSweep({
          client: options.client,
          database: options.database,
          ...options.integrations,
        }),
        ...createTicketAutomation({
          client: options.client,
          database: options.database,
          budget: options.budget,
          integrations: options.integrations,
        }),
      ]
      : []),
    createAuditRetentionFunction({
      client: options.client,
      database: options.database,
    }),
  ];
}

async function bodyWithinLimit(
  request: Request,
  maxBodyBytes: number,
): Promise<boolean> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) return false;
    if (declared > maxBodyBytes) return false;
  }
  if (request.method === "GET" || request.method === "HEAD") return true;
  const reader = request.clone().body?.getReader();
  if (!reader) return true;
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return true;
      total += next.value.byteLength;
      if (total > maxBodyBytes) {
        void request.body?.cancel().catch(() => undefined);
        return false;
      }
    }
  } finally {
    // Never await cancellation of a tee branch: undici can leave it pending
    // for a chunked client that has not closed its upload stream.
    void reader.cancel().catch(() => undefined);
  }
}

export function createInngestHttpHandler(options: {
  config: InngestRuntimeConfig;
  database?: PgDatabase;
  client?: unknown;
  functions?: readonly unknown[];
  budget?: BudgetRuntimeConfig;
  skillImport?: SkillImportDependencies;
  integrations?: IntegrationsBackgroundDependencies;
}): (context: unknown) => Promise<Response> {
  const client = (options.client ?? new Inngest({
    id: "bakery-server",
    baseUrl: options.config.baseUrl,
    signingKey: options.config.signingKey.trim(),
    eventKey: options.config.eventKey.trim(),
    isDev: false,
  })) as Inngest;
  const functions = (options.functions ??
    (options.database
      ? createDefaultInngestFunctions({
        config: options.config,
        database: options.database,
        client,
        budget: options.budget,
        skillImport: options.skillImport,
        integrations: options.integrations,
      })
      : [])) as ServeOptions["functions"];
  const officialHandler = serve({
    client,
    functions,
    serveOrigin: options.config.serveOrigin,
    enableUnauthedSync: false,
  });
  type OfficialContext = Parameters<typeof officialHandler>[0];
  return async (context: unknown) => {
    const officialContext = context as OfficialContext;
    if (
      !await bodyWithinLimit(
        officialContext.req.raw,
        options.config.maxBodyBytes,
      )
    ) {
      return Response.json(
        { error: "BODY_TOO_LARGE" },
        { status: 413 },
      );
    }
    return await officialHandler(officialContext);
  };
}
