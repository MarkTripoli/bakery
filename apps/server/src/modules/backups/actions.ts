import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  BackupImplementedAction as Action,
} from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  problemResponse,
  StandardError,
} from "@bakery/contracts/http";
import { withPgTransaction } from "@bakery/persistence";
import type { z } from "zod";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { installationActor } from "../integrations/postgres.ts";
import { parseContract } from "../execution/http.ts";
import {
  authenticateRunner,
  claimRun,
  issueRunnerCredential,
  listBackupRuns,
  readBackupStatus,
  reportRun,
  requestBackup,
} from "./postgres.ts";
import { takeCutoff } from "./cutoff.ts";
import { listBackupDrills, recordDrill } from "./drill.ts";
import { getRestore, takeRestoreStep } from "./restore-release.ts";
import { maintainRun } from "./maintenance.ts";
import {
  type BackupSettingsDependencies,
  checkRunnerDestination,
  createBackupSettingsAuthorityRunner,
  getOffsite,
  getSchedule,
  prepareRunnerRead,
  putOffsite,
  putSchedule,
  recordVerification,
  releaseRunnerSettings,
} from "./settings-actions.ts";
import {
  getPointInTime,
  putPointInTime,
  recordWalReport,
} from "./point-in-time.ts";

type Run = z.output<typeof contractSchemas.BackupRun>;
type Status = z.output<typeof contractSchemas.BackupStatus>;
type Page = z.output<typeof contractSchemas["Page<BackupRun>"]>;
type Issued = z.output<typeof contractSchemas.BackupRunnerCredentialIssued>;

/** The one runner credential has one audit identity: there is no row id. */
const RUNNER_CREDENTIAL_RESOURCE_ID = "backup-runner";

export type BackupRouteOptions = {
  readonly database: PgDatabase;
  readonly browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  readonly publicBaseUrl: string;
  /** Signs list cursors, as every other list does. */
  readonly secret: string;
  /** What the off-site destination and the runner's settings read need. */
  readonly settings: BackupSettingsDependencies;
};

/** backups.list */
function list(
  context: ActionContext,
  input: { cursor?: string; limit?: number },
  secret: string,
): Promise<Page> {
  const { context: value, actor } = installationActor(context);
  return listBackupRuns(
    value.transaction,
    actor.subject.principalId,
    input,
    secret,
  );
}

/** backups.drills.list */
function listDrills(
  context: ActionContext,
  input: { cursor?: string; limit?: number },
  secret: string,
) {
  const { context: value, actor } = installationActor(context);
  return listBackupDrills(
    value.transaction,
    actor.subject.principalId,
    input,
    secret,
  );
}

/** installationRestore.get */
function getInstallationRestore(context: ActionContext) {
  const { context: value } = installationActor(context);
  return getRestore(value.transaction);
}

/** installationRestore.step */
function takeInstallationRestoreStep(
  context: ActionContext,
  input: { step: "intake" | "dispatch" | "workers"; confirmation: string },
) {
  const { context: value, actor } = installationActor(context);
  return takeRestoreStep(
    value.transaction,
    value,
    actor.subject.principalId,
    input,
  );
}

/** backups.status */
function status(context: ActionContext): Promise<Status> {
  const { context: value } = installationActor(context);
  return readBackupStatus(value.transaction);
}

/** backups.start: queues one manual backup, or returns the one already waiting. */
async function start(context: ActionContext): Promise<Run> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const { run, created } = await requestBackup(value.transaction, principalId);
  await recordAuthAudit(value.transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.BackupsStart,
    resourceType: "backup_run",
    resourceId: run.id,
    details: { created },
  });
  return run;
}

/** backupRunnerCredential.issue: the secret is returned here once and no audit row holds it. */
async function issueCredential(context: ActionContext): Promise<Issued> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const issued = await issueRunnerCredential(value.transaction, principalId);
  await recordAuthAudit(value.transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.BackupRunnerCredentialIssue,
    resourceType: "backup_runner_credential",
    resourceId: RUNNER_CREDENTIAL_RESOURCE_ID,
    details: { generation: issued.generation },
  });
  return contractSchemas.BackupRunnerCredentialIssued.parse({
    credential: issued.credential,
    generation: issued.generation,
    issuedAt: issued.issuedAt.toISOString(),
  });
}

const ADMIN_ACTIONS = [
  Action.BackupsList,
  Action.BackupsDrillsList,
  Action.InstallationRestoreGet,
  Action.InstallationRestoreStep,
  Action.BackupsStatus,
  Action.BackupsStart,
  Action.BackupRunnerCredentialIssue,
  Action.BackupScheduleGet,
  Action.BackupSchedulePut,
  Action.BackupPointInTimeGet,
  Action.BackupPointInTimePut,
  Action.BackupOffsiteGet,
  Action.BackupOffsitePut,
  Action.BackupOffsiteVerify,
] as const;

export function createBackupActionRegistry(
  database: PgDatabase,
  secret: string,
  settings: BackupSettingsDependencies,
): ActionRegistry {
  const registry = new ActionRegistry(
    createBackupSettingsAuthorityRunner(
      new PostgresAuthorityRunner(database),
      settings,
    ),
    createPostgresCommandRunner(),
    "natural-idempotency",
  );
  const policy = {
    access: ActionAccess.InstallationAdministrator,
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
  } as const;
  registry.register({
    name: Action.BackupsList,
    method: HttpMethod.Get,
    path: "/v1/installation/backups",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<BackupRun>"],
    policy: { ...policy, type: ActionKind.Query },
    handler: (context, input) => list(context, input, secret),
  }).register({
    name: Action.BackupsDrillsList,
    method: HttpMethod.Get,
    path: "/v1/installation/backups/drills",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<BackupDrill>"],
    policy: { ...policy, type: ActionKind.Query },
    handler: (context, input) => listDrills(context, input, secret),
  }).register({
    name: Action.InstallationRestoreGet,
    method: HttpMethod.Get,
    path: "/v1/installation/restore",
    input: contractSchemas.Empty,
    output: contractSchemas.InstallationRestore,
    policy: { ...policy, type: ActionKind.Query },
    handler: getInstallationRestore,
  }).register({
    name: Action.InstallationRestoreStep,
    method: HttpMethod.Post,
    path: "/v1/installation/restore/steps",
    input: contractSchemas.InstallationRestoreStep,
    output: contractSchemas.InstallationRestore,
    // Idempotency-Key is required. A browser session only, like the other
    // installation settings: a restore step is never taken with a token.
    explicitIdempotency: "key",
    successStatus: 200,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) => takeInstallationRestoreStep(context, input),
  }).register({
    name: Action.BackupsStatus,
    method: HttpMethod.Get,
    path: "/v1/installation/backups/status",
    input: contractSchemas.Empty,
    output: contractSchemas.BackupStatus,
    policy: { ...policy, type: ActionKind.Query },
    handler: status,
  }).register({
    name: Action.BackupsStart,
    method: HttpMethod.Post,
    path: "/v1/installation/backups",
    input: contractSchemas.Empty,
    output: contractSchemas.BackupRun,
    explicitIdempotency: "key",
    // The request is queued for the runner, not done: an accepted receipt.
    successStatus: 202,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: start,
  }).register({
    name: Action.BackupRunnerCredentialIssue,
    method: HttpMethod.Post,
    path: "/v1/installation/backup-runner/credential",
    input: contractSchemas.Empty,
    output: contractSchemas.BackupRunnerCredentialIssued,
    // No Idempotency-Key: the secret is returned once and never replayed from
    // a stored response.
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: issueCredential,
  }).register({
    name: Action.BackupScheduleGet,
    method: HttpMethod.Get,
    path: "/v1/installation/backup-schedule",
    input: contractSchemas.Empty,
    output: contractSchemas.BackupSchedule,
    policy: { ...policy, type: ActionKind.Query },
    handler: getSchedule,
  }).register({
    name: Action.BackupSchedulePut,
    method: HttpMethod.Put,
    path: "/v1/installation/backup-schedule",
    input: contractSchemas.BackupSchedulePut,
    output: contractSchemas.BackupSchedule,
    // Idempotency-Key is required; If-Match is parsed when sent and the
    // handler requires it once a schedule exists.
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: putSchedule,
  }).register({
    name: Action.BackupPointInTimeGet,
    method: HttpMethod.Get,
    path: "/v1/installation/backup-point-in-time",
    input: contractSchemas.Empty,
    output: contractSchemas.BackupPointInTime,
    policy: { ...policy, type: ActionKind.Query },
    handler: getPointInTime,
  }).register({
    name: Action.BackupPointInTimePut,
    method: HttpMethod.Put,
    path: "/v1/installation/backup-point-in-time",
    input: contractSchemas.BackupPointInTimePut,
    output: contractSchemas.BackupPointInTime,
    // Like the schedule: Idempotency-Key required, If-Match once it exists.
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: putPointInTime,
  }).register({
    name: Action.BackupOffsiteGet,
    method: HttpMethod.Get,
    path: "/v1/installation/backup-offsite",
    input: contractSchemas.Empty,
    output: contractSchemas.BackupOffsite,
    policy: { ...policy, type: ActionKind.Query },
    handler: getOffsite,
  }).register({
    name: Action.BackupOffsitePut,
    method: HttpMethod.Put,
    path: "/v1/installation/backup-offsite",
    input: contractSchemas.BackupOffsitePut,
    output: contractSchemas.BackupOffsite,
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) => putOffsite(context, input, settings),
  }).register({
    name: Action.BackupOffsiteVerify,
    method: HttpMethod.Post,
    path: "/v1/installation/backup-offsite/verification",
    input: contractSchemas.Empty,
    output: contractSchemas.BackupOffsiteVerification,
    // Idempotency-Key only: a test changes no setting. The completed test
    // result is 200, not a created resource.
    explicitIdempotency: "key",
    successStatus: 200,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: recordVerification,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, ADMIN_ACTIONS);
  return registry;
}

function noStoreJson(value: unknown, status: 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      // A claim carries a lease token; nothing may cache it.
      "cache-control": "no-store",
    },
  });
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The host runner's two routes. They authenticate with the runner credential,
 * never a session or an access token, and they take no backup bytes or key
 * material: the report schema is strict and has no field for either.
 */
export function createBackupRunnerRoutes(
  options: Pick<BackupRouteOptions, "database" | "publicBaseUrl" | "settings">,
): Hono {
  const app = new Hono();
  const guarded = (
    handler: (context: Context) => Promise<Response>,
  ) =>
  async (context: Context) => {
    try {
      return await handler(context);
    } catch (error) {
      return problemResponse(context, error, {
        publicBaseUrl: options.publicBaseUrl,
      });
    }
  };
  app.post(
    "/v1/backup-runner/claims",
    guarded((context) =>
      withPgTransaction(options.database, async (transaction) => {
        await authenticateRunner(transaction, context.req.raw.headers);
        return noStoreJson(await claimRun(transaction), 200);
      })
    ),
  );
  // The one route that returns the decrypted off-site credentials, and only to
  // the runner credential; the response is never cached. Three steps: read and
  // form the saved destination, hold its host to the address policy OUTSIDE any
  // transaction (a slow resolver never holds the runner credential's row), then
  // release the credentials and write the audit row in a second transaction.
  app.get(
    "/v1/backup-runner/settings",
    guarded(async (context) => {
      const headers = context.req.raw.headers;
      const prepared = await withPgTransaction(
        options.database,
        async (transaction) => {
          await authenticateRunner(transaction, headers);
          return await prepareRunnerRead(transaction, options.settings);
        },
      );
      const check = await checkRunnerDestination(
        prepared,
        options.settings,
        context.req.raw.signal,
      );
      return withPgTransaction(options.database, async (transaction) => {
        const runner = await authenticateRunner(transaction, headers);
        return noStoreJson(
          await releaseRunnerSettings(
            transaction,
            prepared,
            check,
            options.settings,
            {
              generation: runner.generation,
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
            },
          ),
          200,
        );
      });
    }),
  );
  app.post(
    "/v1/backup-runner/runs/:id/reports",
    guarded(async (context) => {
      const runId = context.req.param("id") ?? "";
      if (!UUID.test(runId)) {
        throw new StandardError({ code: "MALFORMED_REQUEST" });
      }
      // Authenticate before reading the body, so an unauthenticated caller
      // cannot make the server buffer one.
      await withPgTransaction(
        options.database,
        (transaction) =>
          authenticateRunner(transaction, context.req.raw.headers),
      );
      const report = await parseContract(
        context,
        contractSchemas.BackupRunReport,
      );
      return withPgTransaction(options.database, async (transaction) => {
        const runner = await authenticateRunner(
          transaction,
          context.req.raw.headers,
        );
        const run = await reportRun(transaction, runId.toLowerCase(), report, {
          generation: runner.generation,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        });
        return noStoreJson(run, 200);
      });
    }),
  );
  // The runner holds the installation for the run it claimed, then asks again
  // until nothing is left in flight: new work is refused from the first ask.
  app.post(
    "/v1/backup-runner/runs/:id/maintenance",
    guarded(async (context) => {
      const runId = context.req.param("id") ?? "";
      if (!UUID.test(runId)) {
        throw new StandardError({ code: "MALFORMED_REQUEST" });
      }
      // Authenticate before reading the body, like the report route.
      await withPgTransaction(
        options.database,
        (transaction) =>
          authenticateRunner(transaction, context.req.raw.headers),
      );
      const input = await parseContract(
        context,
        contractSchemas.BackupRunMaintenance,
      );
      return withPgTransaction(options.database, async (transaction) => {
        const runner = await authenticateRunner(
          transaction,
          context.req.raw.headers,
        );
        const view = await maintainRun(
          transaction,
          runId.toLowerCase(),
          input.leaseToken,
          {
            generation: runner.generation,
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          },
        );
        return noStoreJson(view, 200);
      });
    }),
  );
  // The cutoff of the backup this runner holds: the database clock at the
  // moment the installation is quiet, with a census of unsettled effects. Only
  // answered while the run holds the installation quiesced.
  app.post(
    "/v1/backup-runner/runs/:id/cutoff",
    guarded(async (context) => {
      const runId = context.req.param("id") ?? "";
      if (!UUID.test(runId)) {
        throw new StandardError({ code: "MALFORMED_REQUEST" });
      }
      // Authenticate before reading the body, like the report route.
      await withPgTransaction(
        options.database,
        (transaction) =>
          authenticateRunner(transaction, context.req.raw.headers),
      );
      const input = await parseContract(
        context,
        contractSchemas.BackupRunCutoff,
      );
      return withPgTransaction(options.database, async (transaction) => {
        const runner = await authenticateRunner(
          transaction,
          context.req.raw.headers,
        );
        const view = await takeCutoff(
          transaction,
          runId.toLowerCase(),
          input.leaseToken,
          {
            generation: runner.generation,
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          },
        );
        return noStoreJson(view, 200);
      });
    }),
  );
  // The restorable window the runner holds off-site: the oldest kept base
  // backup and the newest archived WAL segment. No WAL bytes, no key.
  app.post(
    "/v1/backup-runner/wal",
    guarded(async (context) => {
      await withPgTransaction(
        options.database,
        (transaction) =>
          authenticateRunner(transaction, context.req.raw.headers),
      );
      const input = await parseContract(
        context,
        contractSchemas.BackupWalReport,
      );
      return withPgTransaction(options.database, async (transaction) => {
        await authenticateRunner(transaction, context.req.raw.headers);
        return noStoreJson(await recordWalReport(transaction, input), 200);
      });
    }),
  );
  // One restore drill the runner ran on the host: a backup set restored into an
  // isolated, throwaway database and checked there. The runner chooses the id,
  // so reporting it again returns the stored record.
  app.post(
    "/v1/backup-runner/drills",
    guarded(async (context) => {
      // Authenticate before reading the body, like the other runner routes.
      await withPgTransaction(
        options.database,
        (transaction) =>
          authenticateRunner(transaction, context.req.raw.headers),
      );
      const input = await parseContract(
        context,
        contractSchemas.BackupDrillReport,
      );
      return withPgTransaction(options.database, async (transaction) => {
        const runner = await authenticateRunner(
          transaction,
          context.req.raw.headers,
        );
        const view = await recordDrill(transaction, input, {
          generation: runner.generation,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        });
        return noStoreJson(view, 200);
      });
    }),
  );
  return app;
}

export function createBackupRoutes(options: BackupRouteOptions) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/installation/backups", options.browserSession);
  app.use("/v1/installation/backups/*", options.browserSession);
  app.use("/v1/installation/backup-schedule", options.browserSession);
  app.use("/v1/installation/backup-point-in-time", options.browserSession);
  app.use("/v1/installation/backup-offsite", options.browserSession);
  app.use("/v1/installation/backup-offsite/*", options.browserSession);
  app.use("/v1/installation/backup-runner/*", options.browserSession);
  app.use("/v1/installation/restore", options.browserSession);
  app.use("/v1/installation/restore/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createBackupActionRegistry(
        options.database,
        options.secret,
        options.settings,
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  app.route("/", createBackupRunnerRoutes(options));
  return app;
}
