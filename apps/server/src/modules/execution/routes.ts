import { type Context, Hono } from "hono";
import type { ArtifactActions } from "../knowledge/resource-routes.ts";
import type { InngestRuntimeConfig } from "@bakery/config";
import { problemResponse, StandardError } from "@bakery/contracts/http";
import type { AuthVariables } from "../auth/middleware.ts";
import {
  DEFAULT_LEASE_SECONDS,
  isPgConnectionFailure,
} from "@bakery/persistence";
import { claimJob } from "./claim.ts";
import {
  cancelWorkerEnrollment,
  dispatchBlockers,
  getWorker,
  inspectEnrollment,
  listWorkerComponents,
  listWorkerEnrollments,
  listWorkers,
  repairWorkerEnrollment,
  replaceWorkerEnrollment,
  reportInventory,
  revokeWorker,
  updateWorker,
  workerEnrollmentStatus,
} from "./machines.ts";
import {
  cancelProviderAuthAttempt,
  createProviderAuthAttempt,
  createProviderBinding,
  getProviderAuthAttempt,
  listModelProviderAccounts,
  listProviderBindings,
  reportProviderAuth,
  updateProviderBinding,
} from "./provider-bindings.ts";
import {
  outputBindingRoute,
  outputFinalizationRevokeRoute,
  outputFinalizationRoute,
} from "./output.ts";
import { events } from "./events.ts";
import { heartbeat } from "./heartbeat.ts";
import { enrollWorker, registerWorker } from "./registration.ts";
import { renewLease, resultRoute } from "./results.ts";
import { repositoryInspectionSourceRoute } from "../projects/inspection-source.ts";
import {
  createInngestHttpHandler,
  type IntegrationsBackgroundDependencies,
} from "./inngest-http.ts";
import {
  BASE_WORKER_PROTOCOL_VERSION,
  ENROLLMENT_TTL_MS,
  parseWorkerProtocolVersion,
  withWorkerProtocolHeader,
  WORKER_PROTOCOL_VERSION,
} from "./shared.ts";
import { createExecutionRunControlApp } from "./control.ts";
import { createAttemptReadApp } from "./attempt-read.ts";
import { createOutputReadApp } from "./output-read.ts";
import { secretIdentityToolRoute } from "./secret-identity.ts";
import type { ExecutionRouteOptions } from "./shared.ts";
import type { SkillSourceAdapter } from "../catalog/source-adapters.ts";
import type { SkillImportProcessHooks } from "../catalog/import-workflow.ts";
import type { SkillFileStoreOperations } from "../catalog/storage.ts";
import {
  workerSkillFileRoute,
  workerSkillVersionRoute,
} from "../catalog/worker-reads.ts";
import { WORKER_SKILL_READ_HEADERS } from "@bakery/contracts/worker-skill-read";

export type ExecutionRoutesOptions = ExecutionRouteOptions & {
  inngest?: InngestRuntimeConfig;
  skillFileStore?: SkillFileStoreOperations;
  skillImport?: Readonly<{
    sourceAdapter: SkillSourceAdapter;
    skillFileStore: SkillFileStoreOperations;
    processHooks?: SkillImportProcessHooks;
  }>;
  integrations?: IntegrationsBackgroundDependencies;
  /** Validated artifact preview origin; absent fails previews closed. */
  artifactPreviewOrigin?: string;
  /** Artifact registry shared with the MCP catalog tools. */
  artifactActions?: ArtifactActions;
};

/**
 * Worker routes report a lost database connection as a retryable dependency
 * outage (503) instead of a permanent 500 INTERNAL, so the worker retries
 * rather than shutting down. Every other error passes through unchanged.
 */
export function workerRouteError(error: unknown): unknown {
  return isPgConnectionFailure(error)
    ? new StandardError({ code: "DEPENDENCY_UNAVAILABLE", cause: error })
    : error;
}

function workerRouteHandler(
  options: ExecutionRouteOptions,
  handler: (context: Context) => Promise<Response>,
): (context: Context) => Promise<Response> {
  return async (context) => {
    let version = BASE_WORKER_PROTOCOL_VERSION;
    try {
      version = parseWorkerProtocolVersion(context.req.raw.headers);
      return withWorkerProtocolHeader(await handler(context), version);
    } catch (error) {
      const response = problemResponse(context, workerRouteError(error), {
        publicBaseUrl: options.publicBaseUrl,
      });
      const advertisedVersion = error instanceof StandardError &&
          error.code === "WORKER_PROTOCOL_UNSUPPORTED"
        ? WORKER_PROTOCOL_VERSION
        : version;
      return withWorkerProtocolHeader(response, advertisedVersion);
    }
  };
}

function workerSkillReadRouteHandler(
  options: ExecutionRoutesOptions,
  handler: (context: Context) => Promise<Response>,
) {
  return async (context: Context, next: () => Promise<void>) => {
    const workerRead = context.req.header(
          "X-Bakery-Worker-Protocol-Version",
        ) !== undefined ||
      Object.values(WORKER_SKILL_READ_HEADERS).some((header) =>
        context.req.header(header) !== undefined
      );
    if (!workerRead) {
      await next();
      return;
    }
    const workerHandler = workerRouteHandler(options, handler);
    const response = await workerHandler(context);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function routeHandler(
  options: ExecutionRouteOptions,
  handler: (context: Context) => Promise<Response>,
): (context: Context) => Promise<Response> {
  return async (context) => {
    try {
      return await handler(context);
    } catch (error) {
      return problemResponse(context, error, {
        publicBaseUrl: options.publicBaseUrl,
      });
    }
  };
}

export function createExecutionRoutes(
  options: ExecutionRoutesOptions,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.route("/", createExecutionRunControlApp(options));
  app.route("/", createOutputReadApp(options));
  app.route("/", createAttemptReadApp(options));
  app.onError((error, context) =>
    problemResponse(context, error, { publicBaseUrl: options.publicBaseUrl })
  );
  if (options.inngest) {
    const inngest = createInngestHttpHandler({
      config: options.inngest,
      database: options.database,
      budget: options.budget,
      skillImport: options.skillImport,
      integrations: options.integrations,
    });
    app.all("/api/inngest", inngest);
    app.all("/api/inngest/*", inngest);
  }

  app.use("/v1/worker-enrollments", options.browserSession);
  app.use("/v1/worker-enrollments/*", options.browserSession);
  app.use("/v1/workers", options.browserSession);
  app.use("/v1/workers/*", options.browserSession);
  app.use("/v1/model-provider-accounts", options.browserSession);
  app.post(
    "/v1/worker-enrollments",
    routeHandler(options, (context) => enrollWorker(context, options)),
  );
  app.get(
    "/v1/worker-enrollments",
    routeHandler(options, (context) => listWorkerEnrollments(context, options)),
  );
  app.get(
    "/v1/worker-enrollments/:id",
    routeHandler(
      options,
      (context) => workerEnrollmentStatus(context, options),
    ),
  );
  app.patch(
    "/v1/worker-enrollments/:id",
    routeHandler(
      options,
      (context) => cancelWorkerEnrollment(context, options),
    ),
  );
  app.post(
    "/v1/worker-enrollments/:id/replacements",
    routeHandler(
      options,
      (context) => replaceWorkerEnrollment(context, options),
    ),
  );
  app.post(
    "/v1/worker/enrollment-inspection",
    routeHandler(options, (context) => inspectEnrollment(context, options)),
  );
  app.post(
    "/v1/worker/inventory",
    workerRouteHandler(options, (context) => reportInventory(context, options)),
  );
  app.get(
    "/v1/workers",
    routeHandler(options, (context) => listWorkers(context, options)),
  );
  app.get(
    "/v1/workers/:id/dispatch-blockers",
    routeHandler(options, (context) => dispatchBlockers(context, options)),
  );
  app.get(
    "/v1/workers/:id",
    routeHandler(options, (context) => getWorker(context, options)),
  );
  app.patch(
    "/v1/workers/:id",
    routeHandler(options, (context) => updateWorker(context, options)),
  );
  app.post(
    "/v1/workers/:id/revocations",
    routeHandler(options, (context) => revokeWorker(context, options)),
  );
  app.post(
    "/v1/workers/:id/enrollments",
    routeHandler(
      options,
      (context) => repairWorkerEnrollment(context, options),
    ),
  );
  app.get(
    "/v1/workers/:id/components",
    routeHandler(options, (context) => listWorkerComponents(context, options)),
  );
  app.get(
    "/v1/model-provider-accounts",
    routeHandler(
      options,
      (context) => listModelProviderAccounts(context, options),
    ),
  );
  app.get(
    "/v1/workers/:id/provider-bindings",
    routeHandler(options, (context) => listProviderBindings(context, options)),
  );
  app.post(
    "/v1/workers/:id/provider-bindings",
    routeHandler(options, (context) => createProviderBinding(context, options)),
  );
  app.patch(
    "/v1/workers/:id/provider-bindings/:bindingId",
    routeHandler(options, (context) => updateProviderBinding(context, options)),
  );
  app.post(
    "/v1/workers/:id/provider-bindings/:bindingId/auth-attempts",
    routeHandler(
      options,
      (context) => createProviderAuthAttempt(context, options),
    ),
  );
  app.get(
    "/v1/workers/:id/provider-bindings/:bindingId/auth-attempts/:authAttemptId",
    routeHandler(
      options,
      (context) => getProviderAuthAttempt(context, options),
    ),
  );
  app.patch(
    "/v1/workers/:id/provider-bindings/:bindingId/auth-attempts/:authAttemptId",
    routeHandler(
      options,
      (context) => cancelProviderAuthAttempt(context, options),
    ),
  );
  app.post(
    "/v1/worker/provider-auth-attempts/:id/reports",
    workerRouteHandler(
      options,
      (context) => reportProviderAuth(context, options),
    ),
  );
  app.post(
    "/v1/worker/registration",
    workerRouteHandler(options, (context) => registerWorker(context, options)),
  );
  app.post(
    "/v1/worker/heartbeat",
    workerRouteHandler(options, (context) => heartbeat(context, options)),
  );
  app.post(
    "/v1/worker/claims",
    workerRouteHandler(options, (context) => claimJob(context, options)),
  );
  app.post(
    "/v1/worker/attempts/:id/output-bindings",
    workerRouteHandler(
      options,
      (context) => outputBindingRoute(context, options, "open"),
    ),
  );
  app.post(
    "/v1/worker/attempts/:id/output-bindings/close",
    workerRouteHandler(
      options,
      (context) => outputBindingRoute(context, options, "close"),
    ),
  );
  app.post(
    "/v1/worker/attempts/:id/output-finalizations/:grantId",
    workerRouteHandler(
      options,
      (context) => outputFinalizationRoute(context, options),
    ),
  );
  app.post(
    "/v1/worker/attempts/:id/output-finalizations/:grantId/revoke",
    workerRouteHandler(
      options,
      (context) => outputFinalizationRevokeRoute(context, options),
    ),
  );
  app.post(
    "/v1/worker/attempts/:id/events",
    workerRouteHandler(options, (context) => events(context, options)),
  );
  app.post(
    "/v1/worker/attempts/:id/lease-renewals",
    workerRouteHandler(options, (context) => renewLease(context, options)),
  );
  app.get(
    "/v1/job-attempts/:id/repository-source",
    workerRouteHandler(
      options,
      (context) => repositoryInspectionSourceRoute(context, options),
    ),
  );
  app.get(
    "/v1/skill-versions/:id",
    workerSkillReadRouteHandler(
      options,
      (context) => workerSkillVersionRoute(context, options),
    ),
  );
  app.get(
    "/v1/skill-versions/:id/files/:path{.+}",
    workerSkillReadRouteHandler(
      options,
      (context) => workerSkillFileRoute(context, options),
    ),
  );
  app.post(
    "/v1/worker/attempts/:id/tools/secrets",
    workerRouteHandler(
      options,
      (context) => secretIdentityToolRoute(context, options),
    ),
  );
  app.post(
    "/v1/worker/attempts/:id/result",
    workerRouteHandler(options, (context) => resultRoute(context, options)),
  );
  return app;
}

export const executionProtocol = Object.freeze({
  version: WORKER_PROTOCOL_VERSION,
  defaultLeaseSeconds: DEFAULT_LEASE_SECONDS,
  enrollmentTtlSeconds: ENROLLMENT_TTL_MS / 1000,
});
