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
  assertImplementedActionRegistry,
  TelemetryDestinationImplementedAction as Action,
  telemetryDestinationImplementedActions,
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
import { sha256Hex } from "../../platform/canonical-json.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import {
  decodeSequenceCursor,
  decodeSequenceIdCursor,
  encodeSequenceCursor,
  encodeSequenceIdCursor,
} from "../../platform/cursor.ts";
import type { PgDatabase } from "../../platform/database.ts";
import {
  POSTGRES_UNIQUE_VIOLATION,
  postgresErrorCode,
} from "../../platform/postgres-errors.ts";
import {
  defaultProviderKey,
  DESTINATION_PROVIDERS,
  type DestinationFanout,
  destinationProvider,
  type DestinationRuntimeState,
  isMeasurementKind,
  MEASUREMENT_KINDS,
  type MeasurementKind,
  type ProviderDependencies,
  type TelemetryProvider,
  type TelemetryProviderRegistry,
} from "../../platform/telemetry-destinations/index.ts";
import { installationActor } from "../integrations/postgres.ts";
import {
  openInstallationSecret,
  readInstallationSecretRevision,
  sealInstallationSecret,
  type SecretQueryable,
  writeInstallationSecretVersion,
} from "../secrets/installation-secrets.ts";

type Destination = z.output<typeof contractSchemas.TelemetryDestination>;
type DestinationList = z.output<
  typeof contractSchemas.TelemetryDestinationList
>;
type CreateInput = z.output<typeof contractSchemas.TelemetryDestinationCreate>;
type UpdateInput = z.output<typeof contractSchemas.TelemetryDestinationUpdate>;
type TestInput = z.output<typeof contractSchemas.TelemetryDestinationTest>;
type TestResult = z.output<
  typeof contractSchemas.TelemetryDestinationTestResult
>;

/** The most destinations one installation can have, so a list read stays small. */
export const TELEMETRY_DESTINATION_LIMIT = 200;
/** How long a test send waits for the destination. */
export const TELEMETRY_TEST_TIMEOUT_MS = 10_000;
const SECRET_PROVIDER = "telemetry";

/** What the six kinds of measurement are called and what each one holds. */
const MEASUREMENT_HELP: Readonly<
  Record<MeasurementKind, { label: string; help: string }>
> = Object.freeze({
  cost: {
    label: "Cost and token use",
    help: "The cost and tokens of each use.",
  },
  durations: {
    label: "How long work takes",
    help: "How long each job takes.",
  },
  results: {
    label: "Workflow results",
    help: "How each job ended: completed, failed or canceled.",
  },
  skills: {
    label: "Skills used",
    help: "The names of the skills a run used.",
  },
  health: {
    label: "System health",
    help:
      "Queue age, leases and retries, and measurements Bakery could not send.",
  },
  errors: {
    label: "Errors",
    help:
      "Failures inside Bakery, with where they happened. Never prompts, code or diffs.",
  },
});

export type TelemetryDestinationDependencies = Readonly<{
  registry: TelemetryProviderRegistry;
  fanout: DestinationFanout;
  providerDependencies: ProviderDependencies;
  secretsKey: SecretsKeyConfig | undefined;
  /** Asked after a change so the running server picks it up without waiting. */
  refresh?: () => void;
}>;

type Row = {
  id: string;
  kind: string;
  /** The provider chosen when it was added; null on rows saved before it existed. */
  provider: string | null;
  name: string;
  enabled: boolean;
  measurements: string[];
  settings: Record<string, string>;
  secret_fields: string[];
  secret_id: string | null;
  credential_updated_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};

const COLUMNS =
  `id, kind, provider, name, enabled, measurements, settings, secret_fields,
  secret_id,
  to_char(credential_updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as credential_updated_at,
  to_char(created_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
  to_char(updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
  version`;

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

/** A destination as an administrator may see it: no secret value, ever. */
export function destinationProjection(
  row: Row,
  runtime: DestinationRuntimeState | undefined,
): Destination {
  const state = !row.enabled ? "off" : runtime?.state ?? "not_tested_yet";
  return contractSchemas.TelemetryDestination.parse({
    id: row.id,
    kind: row.kind,
    provider: row.provider ?? defaultProviderKey(row.kind),
    name: row.name,
    enabled: row.enabled,
    measurements: row.measurements,
    settings: row.settings,
    secretFieldsSet: row.secret_fields,
    credentialUpdatedAt: row.credential_updated_at,
    state,
    lastAcceptedAt: iso(runtime?.lastAcceptedAt ?? null),
    lastAnswerAt: iso(runtime?.lastAnswer?.at ?? null),
    lastAnswerOk: runtime?.lastAnswer?.ok ?? null,
    lastAnswerReason: runtime?.lastAnswer?.reason ?? null,
    dropped: runtime?.dropped ?? 0,
    droppedSince: iso(runtime?.droppedSince ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

/**
 * The provider to save: the one the person chose, which must be a known
 * provider that delivers through this kind, or the kind's default when none was
 * chosen.
 */
function checkProvider(chosen: string | undefined, kind: string): string {
  if (chosen === undefined) return defaultProviderKey(kind);
  const known = destinationProvider(chosen);
  if (known === undefined || known.kind !== kind) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["provider"],
          code: "invalid",
          message: known === undefined
            ? "Choose one of the providers the list offers."
            : "That provider does not use this kind of destination.",
        }],
      },
    });
  }
  return known.key;
}

function problems(
  found: Readonly<Record<string, string>>,
): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: Object.entries(found).slice(0, 20).map(([field, message]) => ({
        path: ["values", field],
        code: "invalid",
        message,
      })),
    },
  });
}

function providerOf(
  registry: TelemetryProviderRegistry,
  kind: string,
): TelemetryProvider {
  const provider = registry.get(kind);
  if (provider === undefined) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["kind"],
          code: "unknown_kind",
          message: "That kind of destination is not available.",
        }],
      },
    });
  }
  return provider;
}

/** Splits supplied values into the non-secret and the secret fields of a kind. */
function splitValues(
  provider: TelemetryProvider,
  suppliedValues: unknown,
): { settings: Record<string, string>; secrets: Record<string, string> } {
  const supplied =
    suppliedValues !== null && typeof suppliedValues === "object" &&
      !Array.isArray(suppliedValues)
      ? suppliedValues as Record<string, unknown>
      : {};
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const known = new Map(provider.descriptor.fields.map((f) => [f.name, f]));
  const unknown: Record<string, string> = {};
  for (const [name, value] of Object.entries(supplied)) {
    const field = known.get(name);
    if (field === undefined) {
      unknown[name] = "This kind of destination has no such setting.";
    } else if (typeof value !== "string" || value.length > 2000) {
      unknown[name] = "Give this setting as text of at most 2000 characters.";
    } else {
      (field.secret ? secrets : settings)[name] = value;
    }
  }
  if (Object.keys(unknown).length > 0) throw problems(unknown);
  return { settings, secrets };
}

/**
 * A saved secret is only ever sent to the address it was saved for. When a
 * setting that says where secrets go is changed, every saved secret must be
 * entered again, so a new or test address can never receive the stored value.
 */
function refuseSavedSecretsForANewTarget(
  provider: TelemetryProvider,
  saved: Readonly<Record<string, string>>,
  savedSecretNames: readonly string[],
  suppliedSettings: Readonly<Record<string, string>>,
  suppliedSecrets: Readonly<Record<string, string>>,
): void {
  const moved = provider.secretBoundFields.some((field) =>
    suppliedSettings[field] !== undefined &&
    suppliedSettings[field].trim() !== (saved[field] ?? "").trim()
  );
  if (!moved) return;
  const stale: Record<string, string> = {};
  for (const name of savedSecretNames) {
    if ((suppliedSecrets[name] ?? "") === "") {
      stale[name] =
        "Enter this again: a saved value is not sent to a different address.";
    }
  }
  if (Object.keys(stale).length > 0) throw problems(stale);
}

/** Checks required fields and the adapter's own rules against the whole set. */
async function validateValues(
  provider: TelemetryProvider,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const found: Record<string, string> = {
    ...await provider.validate(values),
  };
  for (const field of provider.descriptor.fields) {
    if (field.required && (values[field.name] ?? "").trim() === "") {
      found[field.name] ??= "This setting is required.";
    }
  }
  if (Object.keys(found).length > 0) throw problems(found);
}

function checkMeasurements(
  provider: TelemetryProvider,
  requested: readonly string[],
): MeasurementKind[] {
  const unique = [...new Set(requested)];
  const can = new Set<string>(provider.descriptor.measurements);
  if (
    unique.length === 0 ||
    !unique.every((m) => isMeasurementKind(m) && can.has(m))
  ) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["measurements"],
          code: "invalid",
          message:
            "Choose at least one kind of measurement this destination can receive.",
        }],
      },
    });
  }
  return unique as MeasurementKind[];
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
          message: "Give the destination a name of 1 to 100 characters.",
        }],
      },
    });
  }
  return trimmed;
}

async function readRow(
  query: SecretQueryable,
  id: string,
  lock = false,
): Promise<Row | undefined> {
  const result = await query.query<Row>(
    `select ${COLUMNS} from bakery.telemetry_destinations where id = $1${
      lock ? " for update" : ""
    }`,
    [id],
  );
  return result.rows[0];
}

/** The stored secret values of a destination, opened in memory only. */
async function openSecrets(
  query: SecretQueryable,
  secretsKey: SecretsKeyConfig | undefined,
  row: Pick<Row, "secret_id">,
): Promise<Record<string, string>> {
  if (row.secret_id === null) return {};
  return JSON.parse(
    await openInstallationSecret(query, secretsKey, row.secret_id),
  ) as Record<string, string>;
}

type ListQuery = z.output<typeof contractSchemas.TelemetryDestinationListQuery>;
type DroppedQuery = z.output<
  typeof contractSchemas.TelemetryDestinationDroppedQuery
>;

const STATE_COUNT_KEYS = [
  "working",
  "not_tested_yet",
  "failing",
  "dropping_data",
  "off",
] as const;

/** Failing first, then dropping data, then the rest. */
const stateRank = (state: Destination["state"]): number =>
  state === "failing" ? 0 : state === "dropping_data" ? 1 : 2;

/** The list's order: state rank, then name ignoring case, then id. */
function compareDestinations(a: Destination, b: Destination): number {
  const byRank = stateRank(a.state) - stateRank(b.state);
  if (byRank !== 0) return byRank;
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The providers whose kind this server can deliver to, for the chooser. */
const availableProviders = (dependencies: TelemetryDestinationDependencies) =>
  DESTINATION_PROVIDERS.filter((entry) =>
    dependencies.registry.get(entry.kind) !== undefined
  ).map((entry) => ({ ...entry, prefill: { ...entry.prefill } }));

const measurementList = () =>
  MEASUREMENT_KINDS.map((kind) => ({ kind, ...MEASUREMENT_HELP[kind] }));

/** telemetryDestinations.list */
export async function listTelemetryDestinations(
  context: ActionContext,
  query: ListQuery,
  dependencies: TelemetryDestinationDependencies,
  cursorSecret: string,
): Promise<DestinationList> {
  const { context: value, actor } = installationActor(context);
  // At most TELEMETRY_DESTINATION_LIMIT rows exist, and a destination's state
  // lives in memory, so the whole set is read, ordered and paged here.
  const rows = await value.transaction.query<Row>(
    `select ${COLUMNS} from bakery.telemetry_destinations`,
  );
  const states = dependencies.fanout.states();
  const all = rows.rows.map((row) =>
    destinationProjection(row, states.get(row.id))
  );
  const stateCounts: Record<string, number> = { all: all.length };
  for (const key of STATE_COUNT_KEYS) {
    stateCounts[key] = all.filter((d) => d.state === key).length;
  }
  const needle = query.search?.trim().toLowerCase() ?? "";
  const matching = all.filter((d) =>
    (needle === "" || d.name.toLowerCase().includes(needle)) &&
    (query.state === undefined || d.state === query.state) &&
    (query.kind === undefined || d.kind === query.kind) &&
    (query.provider === undefined || d.provider === query.provider)
  ).sort(compareDestinations);
  const cursorBinding = {
    action: Action.TelemetryDestinationsList,
    principalId: actor.subject.principalId,
    ordering: "stateRank:asc,nameFolded:asc,id:asc",
    filters: await sha256Hex(
      JSON.stringify([
        needle,
        query.state ?? null,
        query.kind ?? null,
        query.provider ?? null,
      ]),
    ),
    schemaVersion: 1,
  };
  const after = await decodeSequenceIdCursor(
    cursorSecret,
    query.cursor,
    cursorBinding,
  );
  // Continue after the last destination the caller saw; when it is gone, from
  // as many rows as the caller had already read.
  const seen = after === null
    ? -1
    : matching.findIndex((d) => d.id === after.id);
  const start = after === null
    ? 0
    : seen >= 0
    ? seen + 1
    : Math.min(Number(after.sequence), matching.length);
  const limit = query.limit ?? 25;
  const page = matching.slice(start, start + limit);
  const last = page.at(-1);
  const more = start + page.length < matching.length;
  return contractSchemas.TelemetryDestinationList.parse({
    kinds: dependencies.registry.list().map((provider) => ({
      ...provider.descriptor,
    })),
    measurements: measurementList(),
    destinations: page,
    destinationLimit: TELEMETRY_DESTINATION_LIMIT,
    nextCursor: more && last
      ? await encodeSequenceIdCursor(cursorSecret, cursorBinding, {
        sequence: String(start + page.length),
        id: last.id,
      })
      : null,
    total: matching.length,
    stateCounts,
    providers: availableProviders(dependencies),
  });
}

/** telemetryDestinations.get */
export async function getTelemetryDestination(
  context: ActionContext,
  dependencies: TelemetryDestinationDependencies,
): Promise<z.output<typeof contractSchemas.TelemetryDestinationDetail>> {
  const { context: value } = installationActor(context);
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const row = await readRow(value.transaction, id);
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const provider = dependencies.registry.get(row.kind);
  const providerOfRow = destinationProvider(
    row.provider ?? defaultProviderKey(row.kind),
  );
  return contractSchemas.TelemetryDestinationDetail.parse({
    destination: destinationProjection(
      row,
      dependencies.fanout.states().get(row.id),
    ),
    kind: provider === undefined ? null : { ...provider.descriptor },
    provider: providerOfRow
      ? { ...providerOfRow, prefill: { ...providerOfRow.prefill } }
      : null,
    measurements: measurementList(),
  });
}

/** telemetryDestinations.dropped */
export async function listTelemetryDestinationDrops(
  context: ActionContext,
  query: DroppedQuery,
  dependencies: TelemetryDestinationDependencies,
  cursorSecret: string,
): Promise<z.output<typeof contractSchemas.TelemetryDestinationDropped>> {
  const { context: value, actor } = installationActor(context);
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (!await readRow(value.transaction, id)) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const cursorBinding = {
    action: Action.TelemetryDestinationsDropped,
    principalId: actor.subject.principalId,
    ordering: "id:desc",
    filters: id,
    schemaVersion: 1,
  };
  const after = await decodeSequenceCursor(
    cursorSecret,
    query.cursor,
    cursorBinding,
  );
  const newestFirst = dependencies.fanout.drops(id).toReversed();
  const older = after === null
    ? newestFirst
    : newestFirst.filter((report) => report.id < Number(after.sequence));
  const limit = query.limit ?? 25;
  const page = older.slice(0, limit);
  const last = page.at(-1);
  const runtime = dependencies.fanout.states().get(id);
  return contractSchemas.TelemetryDestinationDropped.parse({
    items: page.map((report) => ({
      id: report.id,
      at: new Date(report.at).toISOString(),
      reason: report.reason,
      count: report.count,
    })),
    nextCursor: older.length > page.length && last
      ? await encodeSequenceCursor(cursorSecret, cursorBinding, {
        sequence: String(last.id),
      })
      : null,
    droppedTotal: runtime?.dropped ?? 0,
    droppedSince: iso(runtime?.droppedSince ?? null),
  });
}

/** telemetryDestinations.create */
export async function createTelemetryDestination(
  context: ActionContext,
  input: CreateInput,
  dependencies: TelemetryDestinationDependencies,
): Promise<Destination> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const provider = providerOf(dependencies.registry, input.kind);
  const providerKey = checkProvider(input.provider, provider.descriptor.kind);
  const name = checkName(input.name);
  const measurements = checkMeasurements(provider, input.measurements);
  const { settings, secrets } = splitValues(provider, input.values);
  await validateValues(provider, { ...settings, ...secrets });
  // One create at a time per table: without it two requests can both count 19
  // and both insert, going past the limit.
  await transaction.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    ["bakery:telemetry_destinations:create"],
  );
  const count = await transaction.query<{ count: string }>(
    "select count(*)::text as count from bakery.telemetry_destinations",
  );
  if (Number(count.rows[0].count) >= TELEMETRY_DESTINATION_LIMIT) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "destination_limit" },
    });
  }
  const filled = Object.fromEntries(
    Object.entries(secrets).filter(([, v]) => v !== ""),
  );
  const sealed = Object.keys(filled).length === 0
    ? null
    : await sealInstallationSecret(
      dependencies.secretsKey,
      null,
      JSON.stringify(filled),
    );
  if (sealed) {
    await writeInstallationSecretVersion(transaction, sealed, {
      name: `Telemetry destination ${name}`,
      provider: SECRET_PROVIDER,
      principalId,
    });
  }
  const id = crypto.randomUUID();
  let row: Row | undefined;
  try {
    row = (await transaction.query<Row>(
      `insert into bakery.telemetry_destinations (
         id, kind, provider, name, enabled, measurements, settings, secret_fields,
         secret_id, credential_updated_at, created_by, updated_by
       ) values ($1, $2, $10, $3, $4, $5, $6::jsonb, $7, $8,
         case when $8::uuid is null then null else now() end, $9, $9)
       returning ${COLUMNS}`,
      [
        id,
        provider.descriptor.kind,
        name,
        input.enabled ?? true,
        measurements,
        JSON.stringify(settings),
        Object.keys(filled),
        sealed?.secretId ?? null,
        principalId,
        providerKey,
      ],
    )).rows[0];
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "name_taken" },
      });
    }
    throw error;
  }
  if (!row) throw new Error("TELEMETRY_DESTINATION_INSERT_FAILED");
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.TelemetryDestinationsCreate,
    resourceType: "telemetry_destination",
    resourceId: id,
    details: {
      kind: row.kind,
      provider: providerKey,
      enabled: row.enabled,
      measurements,
      secretFieldsSet: row.secret_fields,
    },
  });
  dependencies.refresh?.();
  return destinationProjection(row, undefined);
}

/** telemetryDestinations.update */
export async function updateTelemetryDestination(
  context: ActionContext,
  input: UpdateInput,
  dependencies: TelemetryDestinationDependencies,
): Promise<Destination> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expected = requireCommandMetadata(context).expectedVersion;
  if (expected === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const current = await readRow(transaction, id, true);
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (current.version !== expected) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const provider = providerOf(dependencies.registry, current.kind);
  const name = input.name === undefined ? current.name : checkName(input.name);
  const measurements = input.measurements === undefined
    ? (current.measurements as MeasurementKind[])
    : checkMeasurements(provider, input.measurements);
  const supplied = splitValues(provider, input.values);
  const savedSecrets = await openSecrets(
    transaction,
    dependencies.secretsKey,
    current,
  );
  refuseSavedSecretsForANewTarget(
    provider,
    current.settings,
    Object.keys(savedSecrets),
    supplied.settings,
    supplied.secrets,
  );
  const settings = { ...current.settings, ...supplied.settings };
  const secrets = { ...savedSecrets, ...supplied.secrets };
  for (const [key, text] of Object.entries(settings)) {
    if (text === "") delete settings[key];
  }
  for (const [key, text] of Object.entries(secrets)) {
    if (text === "") delete secrets[key];
  }
  await validateValues(provider, { ...settings, ...secrets });
  let secretId = current.secret_id;
  const replaced = Object.keys(supplied.secrets).length > 0;
  if (replaced) {
    const revision = secretId === null
      ? null
      : await readInstallationSecretRevision(transaction, secretId);
    const sealed = await sealInstallationSecret(
      dependencies.secretsKey,
      secretId !== null && revision !== null ? { secretId, revision } : null,
      JSON.stringify(secrets),
    );
    await writeInstallationSecretVersion(transaction, sealed, {
      name: `Telemetry destination ${name}`,
      provider: SECRET_PROVIDER,
      principalId,
    });
    secretId = sealed.secretId;
  }
  let row: Row | undefined;
  try {
    row = (await transaction.query<Row>(
      `update bakery.telemetry_destinations
          set name = $3, enabled = $4, measurements = $5, settings = $6::jsonb,
              secret_fields = $7, secret_id = $8,
              credential_updated_at = case when $9::boolean then now()
                else credential_updated_at end,
              updated_by = $10, updated_at = now(), version = version + 1
        where id = $1 and version = $2
        returning ${COLUMNS}`,
      [
        id,
        expected,
        name,
        input.enabled ?? current.enabled,
        measurements,
        JSON.stringify(settings),
        Object.keys(secrets),
        secretId,
        replaced,
        principalId,
      ],
    )).rows[0];
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_UNIQUE_VIOLATION) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "name_taken" },
      });
    }
    throw error;
  }
  if (!row) throw new StandardError({ code: "PRECONDITION_FAILED" });
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.TelemetryDestinationsUpdate,
    resourceType: "telemetry_destination",
    resourceId: id,
    details: {
      kind: row.kind,
      enabled: row.enabled,
      measurements,
      secretReplaced: replaced,
      secretFieldsSet: row.secret_fields,
      version: row.version,
    },
  });
  dependencies.refresh?.();
  return destinationProjection(
    row,
    dependencies.fanout.states().get(row.id),
  );
}

/** telemetryDestinations.delete */
export async function deleteTelemetryDestination(
  context: ActionContext,
  dependencies: TelemetryDestinationDependencies,
): Promise<null> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expected = requireCommandMetadata(context).expectedVersion;
  if (expected === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }
  const deleted = await value.transaction.query<{ kind: string }>(
    `delete from bakery.telemetry_destinations
      where id = $1 and version = $2 returning kind`,
    [id, expected],
  );
  if (deleted.rows.length === 0) {
    const exists = await value.transaction.query(
      "select 1 from bakery.telemetry_destinations where id = $1",
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
    principalId,
    operation: Action.TelemetryDestinationsDelete,
    resourceType: "telemetry_destination",
    resourceId: id,
    details: { kind: deleted.rows[0].kind },
  });
  dependencies.refresh?.();
  return null;
}

/**
 * telemetryDestinations.test: one harmless message to the destination, with the
 * unsaved values or the saved destination's own, and its real answer. The wait is
 * capped, so the transaction holding this request is too.
 */
export async function testTelemetryDestination(
  context: ActionContext,
  input: TestInput,
  dependencies: TelemetryDestinationDependencies,
): Promise<TestResult> {
  const { context: value, actor } = installationActor(context);
  const transaction = value.transaction;
  let kind = input.kind;
  let saved: Record<string, string> = {};
  let savedSettings: Record<string, string> = {};
  let savedSecrets: Record<string, string> = {};
  if (input.id !== undefined) {
    const row = await readRow(transaction, input.id);
    if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    kind = row.kind;
    savedSettings = row.settings;
    savedSecrets = await openSecrets(transaction, dependencies.secretsKey, row);
    saved = { ...savedSettings, ...savedSecrets };
  }
  if (kind === undefined) {
    throw new StandardError({
      code: "UNPROCESSABLE",
      params: {
        issues: [{
          path: ["kind"],
          code: "required",
          message: "Name a saved destination or a kind to test.",
        }],
      },
    });
  }
  const provider = providerOf(dependencies.registry, kind);
  const supplied = splitValues(provider, input.values);
  refuseSavedSecretsForANewTarget(
    provider,
    savedSettings,
    Object.keys(savedSecrets),
    supplied.settings,
    supplied.secrets,
  );
  const values: Record<string, string> = {
    ...saved,
    ...Object.fromEntries(
      Object.entries({ ...supplied.settings, ...supplied.secrets }).filter((
        [, v],
      ) => v !== ""),
    ),
  };
  await validateValues(provider, values);
  const started = performance.now();
  const outcome = await provider.probe(
    values,
    dependencies.providerDependencies,
    AbortSignal.timeout(TELEMETRY_TEST_TIMEOUT_MS),
  );
  // A test sends a message to an address an administrator chose, so it is
  // recorded; the values and the destination's answer are not.
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.TelemetryDestinationsTest,
    resourceType: "telemetry_destination",
    resourceId: input.id ?? "unsaved",
    details: { kind, ok: outcome.ok, status: outcome.status },
  });
  return contractSchemas.TelemetryDestinationTestResult.parse({
    ok: outcome.ok,
    status: outcome.status,
    reason: outcome.reason,
    answer: outcome.answer,
    tookMs: Math.round(performance.now() - started),
  });
}

export function createTelemetryDestinationActionRegistry(
  database: PgDatabase,
  dependencies: TelemetryDestinationDependencies,
  cursorSecret: string,
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
    name: Action.TelemetryDestinationsList,
    method: HttpMethod.Get,
    path: "/v1/installation/telemetry-destinations",
    input: contractSchemas.TelemetryDestinationListQuery,
    output: contractSchemas.TelemetryDestinationList,
    policy: { ...policy, type: ActionKind.Query },
    handler: (context, input) =>
      listTelemetryDestinations(context, input, dependencies, cursorSecret),
  }).register({
    name: Action.TelemetryDestinationsGet,
    method: HttpMethod.Get,
    path: "/v1/installation/telemetry-destinations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.TelemetryDestinationDetail,
    policy: { ...policy, type: ActionKind.Query },
    handler: (context) => getTelemetryDestination(context, dependencies),
  }).register({
    name: Action.TelemetryDestinationsDropped,
    method: HttpMethod.Get,
    path: "/v1/installation/telemetry-destinations/:id/dropped",
    input: contractSchemas.TelemetryDestinationDroppedQuery,
    output: contractSchemas.TelemetryDestinationDropped,
    policy: { ...policy, type: ActionKind.Query },
    handler: (context, input) =>
      listTelemetryDestinationDrops(context, input, dependencies, cursorSecret),
  }).register({
    name: Action.TelemetryDestinationsCreate,
    method: HttpMethod.Post,
    path: "/v1/installation/telemetry-destinations",
    input: contractSchemas.TelemetryDestinationCreate,
    output: contractSchemas.TelemetryDestination,
    explicitIdempotency: "key",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      createTelemetryDestination(context, input, dependencies),
  }).register({
    name: Action.TelemetryDestinationsUpdate,
    method: HttpMethod.Patch,
    path: "/v1/installation/telemetry-destinations/:id",
    input: contractSchemas.TelemetryDestinationUpdate,
    output: contractSchemas.TelemetryDestination,
    explicitIdempotency: "key-and-if-match",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      updateTelemetryDestination(context, input, dependencies),
  }).register({
    name: Action.TelemetryDestinationsDelete,
    method: HttpMethod.Delete,
    path: "/v1/installation/telemetry-destinations/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.NoContent,
    explicitIdempotency: "key-and-if-match",
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context) => deleteTelemetryDestination(context, dependencies),
  }).register({
    name: Action.TelemetryDestinationsTest,
    method: HttpMethod.Post,
    path: "/v1/installation/telemetry-destination-tests",
    input: contractSchemas.TelemetryDestinationTest,
    output: contractSchemas.TelemetryDestinationTestResult,
    explicitIdempotency: "key",
    successStatus: 200,
    policy: { ...policy, type: ActionKind.Command, sessionOnly: true },
    handler: (context, input) =>
      testTelemetryDestination(context, input, dependencies),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(
    registry,
    telemetryDestinationImplementedActions,
  );
  return registry;
}

export function createTelemetryDestinationRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  /** Signs the list cursors. */
  cursorSecret: string;
  dependencies: TelemetryDestinationDependencies;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/installation/telemetry-destinations", options.browserSession);
  app.use("/v1/installation/telemetry-destinations/*", options.browserSession);
  app.use(
    "/v1/installation/telemetry-destination-tests",
    options.browserSession,
  );
  app.route(
    "/",
    createApiRouter({
      registry: createTelemetryDestinationActionRegistry(
        options.database,
        options.dependencies,
        options.cursorSecret,
      ),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
