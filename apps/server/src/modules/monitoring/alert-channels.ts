import { Hono, type MiddlewareHandler } from "hono";
import type { SecretsKeyConfig } from "@bakery/config";
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
  AlertChannelImplementedAction as Action,
  alertChannelImplementedActions,
  assertImplementedActionRegistry,
} from "@bakery/contracts/implemented-actions";
import {
  createApiRouter,
  requireCommandMetadata,
  StandardError,
} from "@bakery/contracts/http";
import type { z } from "zod";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";
import {
  newSigningSecret,
  sendSignedWebhook,
  type WebhookOutcome,
} from "../../platform/alerts/webhook.ts";
import type { AddressPolicy } from "../../platform/telemetry-destinations/address-policy.ts";
import { installationActor } from "../integrations/postgres.ts";
import {
  openInstallationSecret,
  readInstallationSecretRevision,
  sealInstallationSecret,
  type SecretQueryable,
  writeInstallationSecretVersion,
} from "../secrets/installation-secrets.ts";

type Channel = z.output<typeof contractSchemas.AlertChannel>;
type ChannelList = z.output<typeof contractSchemas.AlertChannelList>;
type Issued = z.output<typeof contractSchemas.AlertChannelSecretIssued>;
type CreateInput = z.output<typeof contractSchemas.AlertChannelCreate>;
type UpdateInput = z.output<typeof contractSchemas.AlertChannelUpdate>;
type TestResult = z.output<typeof contractSchemas.AlertChannelTestResult>;

/** The most alert channels one installation can have, so the page and the list stay small. */
export const ALERT_CHANNEL_LIMIT = 20;
/** How long a test message waits for the receiver. */
export const ALERT_TEST_TIMEOUT_MS = 10_000;
const SECRET_PROVIDER = "alerts";

export type AlertChannelDependencies = Readonly<{
  secretsKey: SecretsKeyConfig | undefined;
  fetch: typeof fetch;
  /** Checked when an address is saved and again when a message is sent. */
  addressPolicy: AddressPolicy;
}>;

type Row = {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  settings: { address?: string };
  secret_id: string;
  secret_created_at: string;
  last_answer_at: string | null;
  last_answer_ok: boolean | null;
  last_answer_status: number | null;
  last_answer_reason: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};

const stamp = (column: string): string =>
  `to_char(${column} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const COLUMNS = `id, kind, name, enabled, settings, secret_id,
  ${stamp("secret_created_at")} as secret_created_at,
  ${stamp("last_answer_at")} as last_answer_at,
  last_answer_ok, last_answer_status, last_answer_reason,
  ${stamp("created_at")} as created_at,
  ${stamp("updated_at")} as updated_at,
  version`;

/** A channel as an administrator may see it: no signing secret, ever. */
export function channelProjection(row: Row): Channel {
  const state = !row.enabled
    ? "off"
    : row.last_answer_ok === null
    ? "not_tested_yet"
    : row.last_answer_ok
    ? "working"
    : "failing";
  return contractSchemas.AlertChannel.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    settings: row.settings,
    signingSecretCreatedAt: row.secret_created_at,
    state,
    lastAnswerAt: row.last_answer_at,
    lastAnswerOk: row.last_answer_ok,
    lastAnswerReason: row.last_answer_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function problem(field: string, code: string, message: string): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: [{ path: ["values", field], code, message }] },
  });
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["name"],
          code: "invalid",
          message: "Give the channel a name of 1 to 100 characters.",
        }],
      },
    });
  }
  return trimmed;
}

/** Reads the supplied settings: a webhook has one, its address, as text. */
function suppliedAddress(values: unknown): string | undefined {
  if (values === undefined) return undefined;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw problem("values", "invalid", "Give the settings as an object.");
  }
  const entries = Object.entries(values as Record<string, unknown>);
  for (const [name] of entries) {
    if (name !== "address") {
      throw problem(name, "unknown", "A webhook has no such setting.");
    }
  }
  const address = (values as Record<string, unknown>).address;
  if (address === undefined) return undefined;
  if (typeof address !== "string" || address.length > 2000) {
    throw problem(
      "address",
      "invalid",
      "Give the address as text of at most 2000 characters.",
    );
  }
  return address.trim();
}

async function checkAddress(
  policy: AddressPolicy,
  address: string | undefined,
): Promise<string> {
  if (address === undefined || address === "") {
    throw problem("address", "required", "This setting is required.");
  }
  const verdict = await policy(address);
  if (!verdict.ok) throw problem("address", "invalid", verdict.reason);
  return address;
}

function nameTaken(): StandardError {
  return new StandardError({
    code: "STATE_CONFLICT",
    params: { reason: "name_taken" },
  });
}

async function readRow(
  query: SecretQueryable,
  id: string,
  lock = false,
): Promise<Row | undefined> {
  const result = await query.query<Row>(
    `select ${COLUMNS} from bakery.alert_channels where id = $1${
      lock ? " for update" : ""
    }`,
    [id],
  );
  return result.rows[0];
}

function expectedVersion(context: ActionContext): number {
  const expected = requireCommandMetadata(context).expectedVersion;
  if (expected === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  return expected;
}

/** alertChannels.list */
export async function listAlertChannels(
  context: ActionContext,
): Promise<ChannelList> {
  const { context: value } = installationActor(context);
  const rows = await value.transaction.query<Row>(
    `select ${COLUMNS} from bakery.alert_channels
      order by created_at, id limit ${ALERT_CHANNEL_LIMIT}`,
  );
  return contractSchemas.AlertChannelList.parse({
    channels: rows.rows.map(channelProjection),
  });
}

/** alertChannels.create: the signing secret is made here and answered once. */
export async function createAlertChannel(
  context: ActionContext,
  input: CreateInput,
  dependencies: AlertChannelDependencies,
): Promise<Issued> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const name = checkName(input.name);
  const address = await checkAddress(
    dependencies.addressPolicy,
    suppliedAddress(input.values),
  );
  // One create at a time per table: without it two requests can both count 19
  // and both insert, going past the limit.
  await transaction.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    ["bakery:alert_channels:create"],
  );
  const count = await transaction.query<{ count: string }>(
    "select count(*)::text as count from bakery.alert_channels",
  );
  if (Number(count.rows[0].count) >= ALERT_CHANNEL_LIMIT) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "channel_limit" },
    });
  }
  const signingSecret = newSigningSecret();
  const sealed = await sealInstallationSecret(
    dependencies.secretsKey,
    null,
    signingSecret,
  );
  await writeInstallationSecretVersion(transaction, sealed, {
    name: `Alert channel ${name}`,
    provider: SECRET_PROVIDER,
    principalId,
  });
  const id = crypto.randomUUID();
  let row: Row | undefined;
  try {
    row = (await transaction.query<Row>(
      `insert into bakery.alert_channels (
         id, kind, name, enabled, settings, secret_id, created_by, updated_by
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)
       returning ${COLUMNS}`,
      [
        id,
        input.kind,
        name,
        input.enabled ?? true,
        JSON.stringify({ address }),
        sealed.secretId,
        principalId,
      ],
    )).rows[0];
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw nameTaken();
    }
    throw error;
  }
  if (!row) throw new Error("ALERT_CHANNEL_INSERT_FAILED");
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.AlertChannelsCreate,
    resourceType: "alert_channel",
    resourceId: id,
    details: { kind: row.kind, enabled: row.enabled },
  });
  return contractSchemas.AlertChannelSecretIssued.parse({
    channel: channelProjection(row),
    signingSecret,
  });
}

/** alertChannels.update: name, on or off, address. The signing secret is untouched. */
export async function updateAlertChannel(
  context: ActionContext,
  input: UpdateInput,
  dependencies: AlertChannelDependencies,
): Promise<Channel> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expected = expectedVersion(context);
  const current = await readRow(transaction, id, true);
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (current.version !== expected) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const name = input.name === undefined ? current.name : checkName(input.name);
  const supplied = suppliedAddress(input.values);
  const address = supplied === undefined
    ? current.settings.address
    : await checkAddress(dependencies.addressPolicy, supplied);
  const moved = address !== current.settings.address;
  let row: Row | undefined;
  try {
    row = (await transaction.query<Row>(
      `update bakery.alert_channels
          set name = $3, enabled = $4, settings = $5::jsonb,
              last_answer_at = case when $6::boolean then null
                else last_answer_at end,
              last_answer_ok = case when $6::boolean then null
                else last_answer_ok end,
              last_answer_status = case when $6::boolean then null
                else last_answer_status end,
              last_answer_reason = case when $6::boolean then null
                else last_answer_reason end,
              updated_by = $7, updated_at = now(), version = version + 1
        where id = $1 and version = $2
        returning ${COLUMNS}`,
      [
        id,
        expected,
        name,
        input.enabled ?? current.enabled,
        JSON.stringify({ address }),
        moved,
        principalId,
      ],
    )).rows[0];
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw nameTaken();
    }
    throw error;
  }
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.AlertChannelsUpdate,
    resourceType: "alert_channel",
    resourceId: id,
    details: {
      kind: row.kind,
      enabled: row.enabled,
      addressChanged: moved,
      version: row.version,
    },
  });
  return channelProjection(row);
}

/** alertChannels.delete */
export async function deleteAlertChannel(
  context: ActionContext,
): Promise<null> {
  const { context: value, actor } = installationActor(context);
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expected = expectedVersion(context);
  const deleted = await value.transaction.query<{ kind: string }>(
    `delete from bakery.alert_channels
      where id = $1 and version = $2 returning kind`,
    [id, expected],
  );
  if (deleted.rows.length === 0) {
    const exists = await value.transaction.query(
      "select 1 from bakery.alert_channels where id = $1",
      [id],
    );
    throw new StandardError({
      code: exists.rows.length === 1
        ? "PRECONDITION_FAILED"
        : "RESOURCE_NOT_FOUND",
    });
  }
  await recordAuthAudit(value.transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.AlertChannelsDelete,
    resourceType: "alert_channel",
    resourceId: id,
    details: { kind: deleted.rows[0].kind },
  });
  return null;
}

/**
 * alertChannels.test: one signed message to the saved channel and its real
 * answer, kept on the row so the page can say Working or Failing. The row's
 * version is not bumped: a test must not make the page's If-Match stale. The
 * wait is capped, so the transaction holding this request is too.
 */
export async function testAlertChannel(
  context: ActionContext,
  dependencies: AlertChannelDependencies,
): Promise<TestResult> {
  const { context: value, actor } = installationActor(context);
  const transaction = value.transaction;
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const row = await readRow(transaction, id, true);
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const secret = await openInstallationSecret(
    transaction,
    dependencies.secretsKey,
    row.secret_id,
  );
  const started = performance.now();
  const outcome: WebhookOutcome = await sendSignedWebhook({
    address: row.settings.address ?? "",
    secret,
    message: {
      id: crypto.randomUUID(),
      type: "alert.test",
      text:
        "This is a test message from Bakery. If you can read it, alerts to this channel work.",
      sentAt: Math.floor(Date.now() / 1000),
    },
    fetch: dependencies.fetch,
    addressPolicy: dependencies.addressPolicy,
    signal: AbortSignal.timeout(ALERT_TEST_TIMEOUT_MS),
  });
  await transaction.query(
    `update bakery.alert_channels
        set last_answer_at = now(), last_answer_ok = $2,
            last_answer_status = $3, last_answer_reason = $4
      where id = $1`,
    [id, outcome.ok, outcome.status, outcome.reason],
  );
  // A test sends a message to an address an administrator chose, so it is
  // recorded; the signing secret and the receiver's answer are not.
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.AlertChannelsTest,
    resourceType: "alert_channel",
    resourceId: id,
    details: { kind: row.kind, ok: outcome.ok, status: outcome.status },
  });
  return contractSchemas.AlertChannelTestResult.parse({
    ok: outcome.ok,
    status: outcome.status,
    reason: outcome.reason,
    answer: outcome.answer,
    tookMs: Math.round(performance.now() - started),
  });
}

/** alertChannels.rotateSecret: a new signing secret, answered once; the old one stops at once. */
export async function rotateAlertChannelSecret(
  context: ActionContext,
  dependencies: AlertChannelDependencies,
): Promise<Issued> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expected = expectedVersion(context);
  const current = await readRow(transaction, id, true);
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (current.version !== expected) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const revision = await readInstallationSecretRevision(
    transaction,
    current.secret_id,
  );
  const signingSecret = newSigningSecret();
  const sealed = await sealInstallationSecret(
    dependencies.secretsKey,
    revision === null ? null : { secretId: current.secret_id, revision },
    signingSecret,
  );
  await writeInstallationSecretVersion(transaction, sealed, {
    name: `Alert channel ${current.name}`,
    provider: SECRET_PROVIDER,
    principalId,
  });
  const row = (await transaction.query<Row>(
    `update bakery.alert_channels
        set secret_id = $3, secret_created_at = now(), updated_by = $4,
            updated_at = now(), version = version + 1
      where id = $1 and version = $2
      returning ${COLUMNS}`,
    [id, expected, sealed.secretId, principalId],
  )).rows[0];
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.AlertChannelsRotateSecret,
    resourceType: "alert_channel",
    resourceId: id,
    details: { kind: row.kind, version: row.version },
  });
  return contractSchemas.AlertChannelSecretIssued.parse({
    channel: channelProjection(row),
    signingSecret,
  });
}

export function createAlertChannelActionRegistry(
  database: PgDatabase,
  dependencies: AlertChannelDependencies,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
    "natural-idempotency",
  );
  const policy = {
    access: ActionAccess.InstallationAdministrator,
    organizationContext:
      OrganizationContextPolicy.InstallationAdministratorScope,
  } as const;
  registry.register({
    name: Action.AlertChannelsList,
    method: HttpMethod.Get,
    path: "/v1/installation/alert-channels",
    input: contractSchemas.Empty,
    output: contractSchemas.AlertChannelList,
    policy: { ...policy, type: ActionKind.Query },
    handler: (context) => listAlertChannels(context),
  }).register({
    name: Action.AlertChannelsCreate,
    method: HttpMethod.Post,
    path: "/v1/installation/alert-channels",
    input: contractSchemas.AlertChannelCreate,
    output: contractSchemas.AlertChannelSecretIssued,
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      createAlertChannel(context, input, dependencies),
  }).register({
    name: Action.AlertChannelsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/installation/alert-channels/:id",
    input: contractSchemas.AlertChannelUpdate,
    output: contractSchemas.AlertChannel,
    explicitIdempotency: "key-and-if-match",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      updateAlertChannel(context, input, dependencies),
  }).register({
    name: Action.AlertChannelsDelete,
    method: HttpMethod.Delete,
    path: "/v1/installation/alert-channels/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    explicitIdempotency: "key-and-if-match",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context) => deleteAlertChannel(context),
  }).register({
    name: Action.AlertChannelsTest,
    method: HttpMethod.Post,
    path: "/v1/installation/alert-channels/:id/tests",
    input: contractSchemas.IdPath,
    output: contractSchemas.AlertChannelTestResult,
    explicitIdempotency: "key",
    successStatus: 200,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context) => testAlertChannel(context, dependencies),
  }).register({
    name: Action.AlertChannelsRotateSecret,
    method: HttpMethod.Post,
    path: "/v1/installation/alert-channels/:id/secret-rotations",
    input: contractSchemas.IdPath,
    output: contractSchemas.AlertChannelSecretIssued,
    explicitIdempotency: "key-and-if-match",
    successStatus: 200,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context) => rotateAlertChannelSecret(context, dependencies),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, alertChannelImplementedActions);
  return registry;
}

export function createAlertChannelRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  dependencies: AlertChannelDependencies;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/installation/alert-channels", options.browserSession);
  app.use("/v1/installation/alert-channels/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createAlertChannelActionRegistry(
        options.database,
        options.dependencies,
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
