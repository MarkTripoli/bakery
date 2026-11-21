import { Hono, type MiddlewareHandler } from "hono";
import { StandardError } from "@bakery/contracts/http";
import {
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  createApiRouter,
  requireCommandMetadata,
} from "@bakery/contracts/http";
import {
  assertImplementedActionRegistry,
  EvaluationImplementedAction as A,
  evaluationImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import {
  cancelBatch,
  compare,
  createAttemptLister,
  createBatch,
  createBatchLister,
  createCase,
  createCaseLister,
  createDataset,
  createDatasetLister,
  createDefinition,
  createDefinitionLister,
  createResultLister,
  getBatch,
  runLocalCorpus,
} from "./store.ts";

/** The evaluation registry (#44): every action runs through the authority runner. */
export function createEvaluationActionRegistry(
  database: PgDatabase,
  secret: string,
) {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const organization = OrganizationContextPolicy.RequiredAuthenticatedContext;
  const query = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: organization,
  } as const;
  const command = { ...query, type: ActionKind.Command } as const;
  const read = TransactionIsolation.RepeatableRead;
  const listDefinitions = createDefinitionLister(secret);
  const listCases = createCaseLister(secret);
  const listDatasets = createDatasetLister(secret);
  const listBatches = createBatchLister(secret);
  const listResults = createResultLister(secret);
  const listAttempts = createAttemptLister(secret);
  const S = contractSchemas;
  registry
    .register({
      name: A.EvaluationDefinitionsList,
      method: HttpMethod.Get,
      path: "/v1/evaluation-definitions",
      input: S.CursorQuery,
      output: S["Page<EvaluationDefinition>"],
      policy: query,
      transactionIsolation: read,
      handler: async (c, i) =>
        S["Page<EvaluationDefinition>"].parse(await listDefinitions(c, i)),
    })
    .register({
      name: A.EvaluationDefinitionsCreate,
      method: HttpMethod.Post,
      path: "/v1/evaluation-definitions",
      input: S.EvaluationDefinitionCreate,
      output: S.EvaluationDefinition,
      explicitIdempotency: "key",
      policy: { ...command, access: ActionAccess.Admin },
      handler: async (c, i) =>
        S.EvaluationDefinition.parse(await createDefinition(c, i)),
    })
    .register({
      name: A.EvaluationCasesList,
      method: HttpMethod.Get,
      path: "/v1/evaluation-cases",
      input: S.RepositoryQuery,
      output: S["Page<EvaluationCase>"],
      policy: query,
      transactionIsolation: read,
      handler: async (c, i) =>
        S["Page<EvaluationCase>"].parse(await listCases(c, i)),
    })
    .register({
      name: A.EvaluationCasesCreate,
      method: HttpMethod.Post,
      path: "/v1/evaluation-cases",
      input: S.EvaluationCaseCreate,
      output: S.EvaluationCase,
      explicitIdempotency: "key",
      policy: command,
      handler: async (c, i) => S.EvaluationCase.parse(await createCase(c, i)),
    })
    .register({
      name: A.EvaluationDatasetsCreate,
      method: HttpMethod.Post,
      path: "/v1/evaluation-datasets",
      input: S.EvaluationDatasetCreate,
      output: S.EvaluationDataset,
      explicitIdempotency: "key",
      policy: command,
      handler: async (c, i) =>
        S.EvaluationDataset.parse(await createDataset(c, i)),
    })
    .register({
      name: A.EvaluationDatasetsList,
      method: HttpMethod.Get,
      path: "/v1/evaluation-datasets",
      input: S.CursorQuery,
      output: S["Page<EvaluationDataset>"],
      policy: query,
      transactionIsolation: read,
      handler: async (c, i) =>
        S["Page<EvaluationDataset>"].parse(await listDatasets(c, i)),
    })
    .register({
      name: A.EvaluationBatchesCreate,
      method: HttpMethod.Post,
      path: "/v1/evaluation-batches",
      input: S.EvaluationBatchCreate,
      output: S.EvaluationBatch,
      explicitIdempotency: "key",
      policy: command,
      handler: async (c, i) => S.EvaluationBatch.parse(await createBatch(c, i)),
    })
    .register({
      name: A.EvaluationBatchesList,
      method: HttpMethod.Get,
      path: "/v1/evaluation-batches",
      input: S.EvaluationBatchListQuery,
      output: S["Page<EvaluationBatch>"],
      policy: query,
      transactionIsolation: read,
      handler: async (c, i) =>
        S["Page<EvaluationBatch>"].parse(await listBatches(c, i)),
    })
    .register({
      name: A.EvaluationBatchesGet,
      method: HttpMethod.Get,
      path: "/v1/evaluation-batches/:id",
      input: S.Empty,
      output: S.EvaluationBatch,
      policy: query,
      transactionIsolation: read,
      handler: async (c) => S.EvaluationBatch.parse(await getBatch(c)),
    })
    .register({
      name: A.EvaluationBatchesCancel,
      method: HttpMethod.Post,
      path: "/v1/evaluation-batches/:id/cancel",
      input: S.EvaluationBatchCancel,
      output: S.EvaluationBatch,
      explicitIdempotency: "key-and-if-match",
      successStatus: 200,
      policy: command,
      handler: async (c) => {
        const expectedVersion = requireCommandMetadata(c).expectedVersion;
        if (expectedVersion === undefined) {
          throw new StandardError({ code: "PRECONDITION_REQUIRED" });
        }
        return S.EvaluationBatch.parse(await cancelBatch(c, expectedVersion));
      },
    })
    .register({
      name: A.EvaluationBatchesRun,
      method: HttpMethod.Post,
      path: "/v1/evaluation-batches/:id/run",
      input: S.EvaluationBatchRun,
      output: S.EvaluationBatch,
      explicitIdempotency: "key",
      successStatus: 200,
      policy: command,
      handler: async (c) => S.EvaluationBatch.parse(await runLocalCorpus(c)),
    })
    .register({
      name: A.EvaluationBatchesCompare,
      method: HttpMethod.Get,
      path: "/v1/evaluation-batches/:id/compare",
      input: S.EvaluationCompareQuery,
      output: S.EvaluationComparison,
      policy: query,
      transactionIsolation: read,
      handler: async (c, i) =>
        S.EvaluationComparison.parse(await compare(c, i)),
    })
    .register({
      name: A.EvaluationBatchResultsList,
      method: HttpMethod.Get,
      path: "/v1/evaluation-batches/:id/results",
      input: S.EvaluationResultQuery,
      output: S["Page<EvaluationBatchResult>"],
      policy: query,
      transactionIsolation: read,
      handler: async (c, i) =>
        S["Page<EvaluationBatchResult>"].parse(await listResults(c, i)),
    })
    .register({
      name: A.EvaluationAttemptsList,
      method: HttpMethod.Get,
      path: "/v1/evaluation-results/:id/attempts",
      input: S.CursorQuery,
      output: S["Page<EvaluationAttempt>"],
      policy: query,
      transactionIsolation: read,
      handler: async (c, i) =>
        S["Page<EvaluationAttempt>"].parse(await listAttempts(c, i)),
    });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, evaluationImplementedActions);
  return registry;
}

/** The evaluation routes, behind the token-accepting session middleware. */
export function createEvaluationRoutes(options: {
  database: PgDatabase;
  session: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  for (
    const path of [
      "/v1/evaluation-definitions",
      "/v1/evaluation-cases",
      "/v1/evaluation-datasets",
      "/v1/evaluation-batches",
      "/v1/evaluation-batches/*",
      "/v1/evaluation-results/*",
    ]
  ) app.use(path, options.session);
  app.route(
    "/",
    createApiRouter({
      registry: createEvaluationActionRegistry(
        options.database,
        options.cursorSecret,
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
