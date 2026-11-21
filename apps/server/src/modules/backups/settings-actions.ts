import type { SecretsKeyConfig } from "@bakery/config";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  type ActionDefinition,
  type EncodedSuccessResponse,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { BackupImplementedAction as Action } from "@bakery/contracts/implemented-actions";
import {
  createNormalizedCommandMetadata,
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import type { z } from "zod";
import { recordAuthAudit } from "../auth/application/audit.ts";
import { readCompletedCommandReplay } from "../../platform/command-replay.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { installationActor } from "../integrations/postgres.ts";
import {
  BACKUP_SETTINGS_ID,
  type BackupS3Credentials,
  DEFAULT_BACKUP_SCHEDULE,
  openBackupCredentials,
  readBackupOffsite,
  readBackupSchedule,
  sealBackupCredentials,
  type StoredBackupOffsite,
  type StoredBackupSchedule,
  upsertBackupOffsite,
  upsertBackupSchedule,
  writeBackupSecretVersion,
} from "./settings.ts";
import {
  isTimeOfDayUtc,
  MAX_DAYS_TO_KEEP,
  MIN_DAYS_TO_KEEP,
} from "./schedule.ts";
import {
  checkDestinationHost,
  type DestinationAddressCheck,
  type HostResolver,
  resolveHostAddresses,
} from "./dns.ts";
import {
  type BackupDestination,
  BackupDestinationInvalid,
  BackupProbeOutcome,
  type BackupProbeResult,
  isCredentialText,
  probeBackupDestination,
  resolveBackupDestination,
} from "./s3.ts";

type Schedule = z.output<typeof contractSchemas.BackupSchedule>;
type SchedulePut = z.output<typeof contractSchemas.BackupSchedulePut>;
type Offsite = z.output<typeof contractSchemas.BackupOffsite>;
type OffsitePut = z.output<typeof contractSchemas.BackupOffsitePut>;
type Verification = z.output<typeof contractSchemas.BackupOffsiteVerification>;
type RunnerSettings = z.output<typeof contractSchemas.BackupRunnerSettings>;

export type BackupSettingsDependencies = {
  readonly secretsKey?: SecretsKeyConfig;
  /** True only when BAKERY_ENV is test: a loopback http endpoint is allowed. */
  readonly allowLoopbackEndpoint: boolean;
  /** Probe runner; tests inject one so no suite reaches a real destination. */
  readonly probe?: typeof probeBackupDestination;
  /** Host resolver; tests inject one so no suite touches real DNS. */
  readonly resolve?: HostResolver;
};

const resolverOf = (
  dependencies: Pick<BackupSettingsDependencies, "resolve">,
) => dependencies.resolve ?? resolveHostAddresses;

function malformed(path: string, message: string): StandardError {
  return new StandardError({
    code: "MALFORMED_REQUEST",
    params: { issues: [{ path: [path], code: "invalid", message }] },
  });
}

/* ------------------------------------------------------------------ */
/* Schedule                                                            */
/* ------------------------------------------------------------------ */

export function scheduleProjection(
  stored: StoredBackupSchedule | null,
): Schedule {
  return contractSchemas.BackupSchedule.parse(
    stored === null
      ? { ...DEFAULT_BACKUP_SCHEDULE, updatedAt: null, version: 0 }
      : {
        enabled: stored.enabled,
        interval: stored.interval,
        timeOfDayUtc: stored.timeOfDayUtc,
        daysToKeep: stored.daysToKeep,
        updatedAt: stored.updatedAt,
        version: stored.version,
      },
  );
}

/** backupSchedule.get */
export async function getSchedule(context: ActionContext): Promise<Schedule> {
  const { context: value } = installationActor(context);
  return scheduleProjection(await readBackupSchedule(value.transaction));
}

/** backupSchedule.put: validates, checks If-Match under the row lock, saves, audits. */
export async function putSchedule(
  context: ActionContext,
  input: SchedulePut,
): Promise<Schedule> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  if (!isTimeOfDayUtc(input.timeOfDayUtc)) {
    throw unprocessable(["timeOfDayUtc"], "invalid_time_of_day");
  }
  if (
    !Number.isInteger(input.daysToKeep) ||
    input.daysToKeep < MIN_DAYS_TO_KEEP ||
    input.daysToKeep > MAX_DAYS_TO_KEEP
  ) throw unprocessable(["daysToKeep"], "invalid_days_to_keep");
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  const stored = await readBackupSchedule(transaction, { lock: true });
  if (stored) {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== stored.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else if (expectedVersion !== undefined) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  const saved = await upsertBackupSchedule(transaction, stored, {
    enabled: input.enabled,
    interval: input.interval,
    timeOfDayUtc: input.timeOfDayUtc,
    daysToKeep: input.daysToKeep,
    principalId,
  });
  if (!saved) throw new StandardError({ code: "PRECONDITION_FAILED" });
  const result = await readBackupSchedule(transaction);
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.BackupSchedulePut,
    resourceType: "backup_schedule_settings",
    resourceId: BACKUP_SETTINGS_ID,
    details: {
      enabled: input.enabled,
      interval: input.interval,
      timeOfDayUtc: input.timeOfDayUtc,
      daysToKeep: input.daysToKeep,
      version: result?.version ?? null,
    },
  });
  return scheduleProjection(result);
}

/* ------------------------------------------------------------------ */
/* Off-site destination                                                */
/* ------------------------------------------------------------------ */

const unconfiguredOffsite: Offsite = {
  configured: false,
  endpoint: null,
  region: null,
  bucket: null,
  prefix: null,
  credentialUpdatedAt: null,
  credentialRevision: null,
  updatedAt: null,
  version: 0,
};

/** Explicit projection of stored settings; no secret, id or ciphertext. */
export function offsiteProjection(stored: StoredBackupOffsite | null): Offsite {
  if (stored === null) return unconfiguredOffsite;
  return contractSchemas.BackupOffsite.parse({
    configured: stored.secretId !== null && stored.credentialRevision !== null,
    endpoint: stored.endpoint,
    region: stored.region,
    bucket: stored.bucket,
    prefix: stored.prefix,
    credentialUpdatedAt: stored.credentialUpdatedAt,
    credentialRevision: stored.credentialRevision,
    updatedAt: stored.updatedAt,
    version: stored.version,
  });
}

/** backupOffsite.get */
export async function getOffsite(context: ActionContext): Promise<Offsite> {
  const { context: value } = installationActor(context);
  return offsiteProjection(await readBackupOffsite(value.transaction));
}

/** The credential pair when both halves were supplied; refuses a lone half. */
function suppliedCredentials(input: OffsitePut): BackupS3Credentials | null {
  const { accessKeyId, secretAccessKey } = input;
  if (accessKeyId === undefined && secretAccessKey === undefined) return null;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw malformed(
      accessKeyId === undefined ? "accessKeyId" : "secretAccessKey",
      "The access key id and secret access key are supplied together.",
    );
  }
  if (!isCredentialText(accessKeyId)) {
    throw malformed("accessKeyId", "The access key id has invalid characters.");
  }
  if (!isCredentialText(secretAccessKey)) {
    throw malformed(
      "secretAccessKey",
      "The secret access key has invalid characters.",
    );
  }
  return { accessKeyId, secretAccessKey };
}

/**
 * True when a save points the saved destination at another host: a new
 * endpoint, region or bucket. A prefix is only a folder in the same bucket, so
 * a prefix-only change is not a move.
 */
export function movesDestination(
  stored: Pick<StoredBackupOffsite, "endpoint" | "region" | "bucket"> | null,
  destination: Pick<BackupDestination, "endpoint" | "region" | "bucket">,
): boolean {
  return stored !== null && (
    stored.endpoint !== destination.endpoint ||
    stored.region !== destination.region ||
    stored.bucket !== destination.bucket
  );
}

/**
 * The saved key pair belongs to the saved destination. Pointing the save at
 * another host without both halves again would send that pair to a host the
 * person never proved they could use it for (and the runner read would then
 * release it there), so a move without the pair is refused before anything is
 * opened, tested or written.
 */
export function assertKeysForMove(
  stored: Pick<StoredBackupOffsite, "endpoint" | "region" | "bucket"> | null,
  destination: Pick<BackupDestination, "endpoint" | "region" | "bucket">,
  credentials: BackupS3Credentials | null,
): void {
  if (credentials === null && movesDestination(stored, destination)) {
    throw unprocessable(["accessKeyId"], "credentials_required");
  }
}

/** The validated destination, or a 422 naming the field that is wrong. */
function destinationOf(
  input: Pick<OffsitePut, "endpoint" | "region" | "bucket" | "prefix">,
  dependencies: Pick<BackupSettingsDependencies, "allowLoopbackEndpoint">,
): BackupDestination {
  try {
    return resolveBackupDestination(
      {
        endpoint: input.endpoint,
        region: input.region,
        bucket: input.bucket,
        prefix: input.prefix ?? "",
      },
      { allowLoopbackEndpoint: dependencies.allowLoopbackEndpoint },
    );
  } catch (error) {
    if (error instanceof BackupDestinationInvalid) {
      throw unprocessable([error.field], `invalid_${error.field}`);
    }
    throw error;
  }
}

/**
 * backupOffsite.put: validates, checks If-Match under the row lock, seals the
 * credential pair as the next revision of one installation secret and saves
 * the non-secret fields at the next version, in one transaction with its audit
 * row. The test object has already been sent by the authority wrapper below.
 */
export async function putOffsite(
  context: ActionContext,
  input: OffsitePut,
  dependencies: BackupSettingsDependencies,
): Promise<Offsite> {
  const { context: value, actor } = installationActor(context);
  const principalId = actor.subject.principalId;
  const transaction = value.transaction;
  const credentials = suppliedCredentials(input);
  const destination = destinationOf(input, dependencies);
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  const stored = await readBackupOffsite(transaction, { lock: true });
  if (stored) {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== stored.version) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else {
    if (expectedVersion !== undefined) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
    if (credentials === null) {
      throw malformed(
        "accessKeyId",
        "The first save needs the access key id and secret access key.",
      );
    }
  }
  // The same rule as before the test, now under the row lock: the pair the save
  // keeps is only ever the pair for the host it was saved with.
  assertKeysForMove(stored, destination, credentials);
  const sealed = credentials === null
    ? null
    : await sealBackupCredentials(dependencies.secretsKey, stored, credentials);
  if (sealed) {
    await writeBackupSecretVersion(transaction, sealed, stored, principalId);
  }
  const saved = await upsertBackupOffsite(transaction, stored, {
    endpoint: destination.endpoint,
    region: destination.region,
    bucket: destination.bucket,
    prefix: destination.prefix,
    secretId: sealed?.secretId ?? null,
    credentialsReplaced: sealed !== null,
    principalId,
  });
  if (!saved) throw new StandardError({ code: "PRECONDITION_FAILED" });
  const result = await readBackupOffsite(transaction);
  // Identifiers, flags and revision numbers only: no credential, ciphertext,
  // key id or secret record id.
  await recordAuthAudit(transaction, value, {
    organizationId: null,
    principalId,
    operation: Action.BackupOffsitePut,
    resourceType: "backup_offsite_settings",
    resourceId: BACKUP_SETTINGS_ID,
    details: {
      bucket: destination.bucket,
      region: destination.region,
      replaced: stored !== null,
      credentialsRotated: sealed !== null,
      credentialRevision: result?.credentialRevision ?? null,
      version: result?.version ?? null,
    },
  });
  return offsiteProjection(result);
}

const verificationSlot = Symbol("backup destination test outcome");
type VerifiedContext = ActionContext & { [verificationSlot]?: Verification };

/** What the pre-save stage decided before any call to the destination. */
type PutStage =
  | { readonly skip: true }
  | {
    readonly destination: BackupDestination;
    readonly credentials: BackupS3Credentials;
    readonly credentialsSupplied: boolean;
  };

/**
 * A save whose host the address policy refused: a private, loopback, link-local
 * or metadata address is `destination_private_address`; a name that cannot be
 * resolved at all is `destination_unreachable`. Nothing is stored.
 */
function addressRefusal(
  check: Extract<DestinationAddressCheck, { ok: false }>,
): StandardError {
  const private_ = check.refusal === "destination_private_address";
  return new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: [{
        path: ["endpoint"],
        code: private_
          ? "destination_private_address"
          : "destination_unreachable",
        message: private_
          ? "The destination resolves to an address the server may not connect to."
          : "The destination's name could not be resolved.",
      }],
    },
  });
}

function probeFailure(
  result: BackupProbeResult,
  credentialsSupplied: boolean,
): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: [{
        path: [credentialsSupplied ? "secretAccessKey" : "endpoint"],
        code: result.outcome,
        // The destination's own answer, bounded and with the credentials
        // removed, so the page can quote what the bucket said.
        message: result.detail ?? result.outcome.replaceAll("_", " "),
      }],
    },
  });
}

/**
 * backupOffsite.put: a save that supplies credentials or moves the
 * destination first sends a test object, between committed transactions, so
 * the destination is never called inside the save's transaction. A failed test
 * rejects with the stable cause and stores nothing, so the old settings keep
 * serving. A save that changes nothing about where or how to connect goes
 * straight through.
 */
async function runPut(
  authority: ActionAuthorityRunner,
  action: ActionDefinition,
  context: ActionContext,
  input: unknown,
  next: (context: ActionContext) => Promise<unknown>,
  dependencies: BackupSettingsDependencies,
): Promise<unknown> {
  const parsed = contractSchemas.BackupOffsitePut.parse(input);
  const metadata = createNormalizedCommandMetadata(
    action,
    context.request,
    context.params,
    parsed,
  );
  const stage = await authority.run(
    action,
    context,
    parsed,
    async (authorized): Promise<PutStage> => {
      const { context: value } = installationActor(authorized);
      // Field and pair errors are reported by the save itself, in order.
      const supplied = suppliedCredentials(parsed);
      const destination = destinationOf(parsed, dependencies);
      const replay = await readCompletedCommandReplay({
        context: authorized,
        metadata,
        input: parsed,
      });
      if (replay) return { skip: true };
      const stored = await readBackupOffsite(value.transaction);
      // A move of the host needs the pair again, before any lookup, any open of
      // the stored pair and any test object.
      assertKeysForMove(stored, destination, supplied);
      // Every save holds the host to the address policy, even one that moves
      // nothing: a name re-pointed since the last save is caught here.
      const addresses = await checkDestinationHost(
        destination,
        resolverOf(dependencies),
        authorized.signal,
      );
      if (!addresses.ok) throw addressRefusal(addresses);
      // What counts as a move of the host lives in `movesDestination`; a new
      // folder in the same bucket still gets a test object, with the stored pair.
      const changed = stored === null ||
        movesDestination(stored, destination) ||
        stored.prefix !== destination.prefix;
      if (supplied === null && !changed) return { skip: true };
      const credentials = supplied ??
        (stored?.secretId == null ? null : await openBackupCredentials(
          value.transaction,
          dependencies.secretsKey,
          stored,
        ));
      // The first save without credentials is refused by the save itself.
      if (credentials === null) return { skip: true };
      return {
        destination,
        credentials,
        credentialsSupplied: supplied !== null,
      };
    },
  ) as PutStage;
  if (!("skip" in stage)) {
    context.signal.throwIfAborted();
    const result = await (dependencies.probe ?? probeBackupDestination)(
      stage.destination,
      stage.credentials,
      context.signal,
      resolverOf(dependencies),
    );
    if (result.outcome !== BackupProbeOutcome.Verified) {
      throw probeFailure(result, stage.credentialsSupplied);
    }
  }
  return await authority.run(action, context, parsed, next);
}

/** What the verify stage decided before any call to the destination. */
type VerifyStage =
  | { readonly replay: EncodedSuccessResponse }
  | { readonly result: BackupProbeResult }
  | {
    readonly destination: BackupDestination;
    readonly credentials: BackupS3Credentials;
  };

/**
 * backupOffsite.verify ("Send a test"): returns a completed Idempotency-Key
 * replay, else decrypts the stored credentials in memory, sends the bounded
 * test object outside any transaction, and records the outcome and its audit
 * row. A failed test still answers 200 with a stable outcome.
 */
async function runVerify(
  authority: ActionAuthorityRunner,
  action: ActionDefinition,
  context: ActionContext,
  input: unknown,
  next: (context: ActionContext) => Promise<unknown>,
  dependencies: BackupSettingsDependencies,
): Promise<unknown> {
  const parsed = contractSchemas.Empty.parse(input);
  const metadata = createNormalizedCommandMetadata(
    action,
    context.request,
    context.params,
    parsed,
  );
  const stage = await authority.run(
    action,
    context,
    parsed,
    async (authorized): Promise<VerifyStage> => {
      const { context: value } = installationActor(authorized);
      const replay = await readCompletedCommandReplay({
        context: authorized,
        metadata,
        input: parsed,
      });
      if (replay) {
        return { replay: validateEncodedSuccessResponse(action, replay) };
      }
      const stored = await readBackupOffsite(value.transaction);
      if (stored === null || stored.secretId === null) {
        return {
          result: { outcome: BackupProbeOutcome.NotConfigured, detail: null },
        };
      }
      let destination: BackupDestination;
      try {
        destination = resolveBackupDestination(stored, {
          allowLoopbackEndpoint: dependencies.allowLoopbackEndpoint,
        });
      } catch (error) {
        if (error instanceof BackupDestinationInvalid) {
          return {
            result: {
              outcome: BackupProbeOutcome.DestinationRefused,
              detail: "The saved destination is not valid.",
            },
          };
        }
        throw error;
      }
      // The saved host may have been re-pointed since the save: hold it to the
      // address policy again before anything is dialled.
      const addresses = await checkDestinationHost(
        destination,
        resolverOf(dependencies),
        authorized.signal,
      );
      if (!addresses.ok) {
        return {
          result: addresses.refusal === "destination_private_address"
            ? {
              outcome: BackupProbeOutcome.DestinationPrivateAddress,
              detail:
                "The destination resolves to an address the server may not connect to.",
            }
            : {
              outcome: BackupProbeOutcome.DestinationUnreachable,
              detail: "The destination's name could not be resolved.",
            },
        };
      }
      // No usable secrets key, or one that cannot open the stored version,
      // answers STATE_CONFLICT.
      const credentials = await openBackupCredentials(
        value.transaction,
        dependencies.secretsKey,
        stored,
      );
      return { destination, credentials };
    },
  ) as VerifyStage;
  if ("replay" in stage) return stage.replay;
  context.signal.throwIfAborted();
  const probed = "result" in stage
    ? stage.result
    : await (dependencies.probe ?? probeBackupDestination)(
      stage.destination,
      stage.credentials,
      context.signal,
      resolverOf(dependencies),
    );
  const result: Verification = {
    outcome: probed.outcome,
    detail: probed.detail,
    checkedAt: new Date().toISOString(),
  };
  return await authority.run(
    action,
    context,
    parsed,
    (authorized) =>
      next(
        Object.assign(authorized, {
          [verificationSlot]: result,
        }) as VerifiedContext,
      ),
  );
}

/** backupOffsite.verify, after the test: audits and returns the outcome. */
export async function recordVerification(
  context: ActionContext,
): Promise<Verification> {
  const { context: value, actor } = installationActor(context);
  const result = (context as VerifiedContext)[verificationSlot];
  if (!result) throw new StandardError({ code: "INTERNAL" });
  await recordAuthAudit(value.transaction, value, {
    organizationId: null,
    principalId: actor.subject.principalId,
    operation: Action.BackupOffsiteVerify,
    resourceType: "backup_offsite_settings",
    resourceId: BACKUP_SETTINGS_ID,
    // The outcome word only: the destination's answer text stays off the audit.
    details: { outcome: result.outcome },
  });
  return contractSchemas.BackupOffsiteVerification.parse(result);
}

export function createBackupSettingsAuthorityRunner(
  authority: ActionAuthorityRunner,
  dependencies: BackupSettingsDependencies,
): ActionAuthorityRunner {
  return {
    run(action, context, input, next) {
      if (action.name === Action.BackupOffsitePut) {
        return runPut(authority, action, context, input, next, dependencies);
      }
      if (action.name === Action.BackupOffsiteVerify) {
        return runVerify(authority, action, context, input, next, dependencies);
      }
      return authority.run(action, context, input, next);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Runner read                                                         */
/* ------------------------------------------------------------------ */

/** What a runner read has before the destination's addresses are checked. */
export type RunnerReadPrepared = {
  /** The saved destination as read, or null when none is saved. */
  readonly offsite: StoredBackupOffsite | null;
  /** The destination's host check, or null when there is nothing to check. */
  readonly destination: BackupDestination | null;
  /** Why the saved destination could not even be formed, when it could not. */
  readonly invalid: boolean;
};

/**
 * Step 1 of backupRunner.settings, inside the first transaction: reads the
 * saved destination and forms it. No credential is opened yet.
 */
export async function prepareRunnerRead(
  transaction: PgTransactionClient,
  dependencies: Pick<BackupSettingsDependencies, "allowLoopbackEndpoint">,
): Promise<RunnerReadPrepared> {
  const offsite = await readBackupOffsite(transaction);
  if (offsite === null || offsite.secretId === null) {
    return { offsite, destination: null, invalid: false };
  }
  try {
    return {
      offsite,
      destination: resolveBackupDestination(offsite, {
        allowLoopbackEndpoint: dependencies.allowLoopbackEndpoint,
      }),
      invalid: false,
    };
  } catch (error) {
    if (error instanceof BackupDestinationInvalid) {
      return { offsite, destination: null, invalid: true };
    }
    throw error;
  }
}

/**
 * Step 2, between the transactions: resolves the host and holds every address
 * to the policy. Done outside any transaction so a slow resolver never holds
 * the runner credential's row.
 */
export function checkRunnerDestination(
  prepared: RunnerReadPrepared,
  dependencies: Pick<BackupSettingsDependencies, "resolve">,
  signal?: AbortSignal,
): Promise<DestinationAddressCheck | null> {
  if (prepared.destination === null) return Promise.resolve(null);
  return checkDestinationHost(
    prepared.destination,
    resolverOf(dependencies),
    signal,
  );
}

/** Why the runner was not given the credentials of a saved destination. */
export type RunnerRefusal =
  | "destination_private_address"
  | "destination_unresolvable"
  | "destination_invalid";

/** Operation name of the audit row each credential release (or refusal) writes. */
export const RUNNER_SETTINGS_OPERATION = Action.BackupRunnerSettings;
/** The runner credential has no principal: its audit identity is this one id. */
const RUNNER_CREDENTIAL_RESOURCE_ID = "backup-runner";

/**
 * Step 3, in the second transaction: backupRunner.settings. This is the one
 * deliberate path where the secret leaves the server: only over the runner
 * credential, never to a user session, never cached, never logged.
 *
 * - Nothing saved or no credentials stored: nothing is released and no audit
 *   row is written (the runner polls; a read that releases nothing is not an
 *   event worth a row).
 * - Credentials released: ONE audit row, `backupRunner.settings`, with no
 *   principal (the runner has none), the runner credential as the resource and
 *   its generation, the bucket and the endpoint host. Never a key.
 * - Saved but refused (the host now resolves to a refused address, cannot be
 *   resolved, or is not a valid destination): the credentials are withheld,
 *   `offsiteConfigured` stays true, `offsiteRefusal` names why, and ONE audit
 *   row with `released: false` records the refusal.
 */
export async function releaseRunnerSettings(
  transaction: PgTransactionClient,
  prepared: RunnerReadPrepared,
  check: DestinationAddressCheck | null,
  dependencies: Pick<BackupSettingsDependencies, "secretsKey">,
  runner: {
    readonly generation: number;
    readonly requestId: string;
    readonly traceId: string;
  },
): Promise<RunnerSettings> {
  const schedule = await readBackupSchedule(transaction);
  const offsite = await readBackupOffsite(transaction);
  // The destination the host check judged must still be the saved one.
  if (
    (offsite?.version ?? 0) !== (prepared.offsite?.version ?? 0) ||
    offsite?.endpoint !== prepared.offsite?.endpoint
  ) throw new StandardError({ code: "STATE_CONFLICT" });
  const effective = schedule === null
    ? { ...DEFAULT_BACKUP_SCHEDULE, version: 0 }
    : schedule;
  const configured = offsite !== null && offsite.secretId !== null;
  let refusal: RunnerRefusal | null = null;
  if (configured) {
    if (prepared.invalid) refusal = "destination_invalid";
    else if (check !== null && !check.ok) refusal = check.refusal;
  }
  const credentials = configured && refusal === null
    ? await openBackupCredentials(transaction, dependencies.secretsKey, offsite)
    : null;
  if (configured) {
    let endpointHost: string | null = null;
    try {
      endpointHost = new URL(offsite.endpoint).hostname;
    } catch {
      endpointHost = null;
    }
    await recordAuthAudit(
      transaction,
      { requestId: runner.requestId, traceId: runner.traceId },
      {
        organizationId: null,
        principalId: null,
        operation: RUNNER_SETTINGS_OPERATION,
        resourceType: "backup_runner_credential",
        resourceId: RUNNER_CREDENTIAL_RESOURCE_ID,
        // Identifiers and non-secret destination facts only: never an access
        // key, a secret or any key material.
        details: {
          released: credentials !== null,
          generation: runner.generation,
          bucket: offsite.bucket,
          region: offsite.region,
          endpointHost,
          credentialRevision: offsite.credentialRevision,
          ...(refusal === null ? {} : { refusal }),
        },
      },
    );
  }
  return contractSchemas.BackupRunnerSettings.parse({
    scheduleEnabled: effective.enabled,
    scheduleInterval: effective.interval,
    scheduleTimeOfDayUtc: effective.timeOfDayUtc,
    daysToKeep: effective.daysToKeep,
    scheduleVersion: effective.version,
    offsiteConfigured: configured,
    offsiteEndpoint: offsite?.endpoint ?? null,
    offsiteRegion: offsite?.region ?? null,
    offsiteBucket: offsite?.bucket ?? null,
    offsitePrefix: offsite?.prefix ?? null,
    offsiteAccessKeyId: credentials?.accessKeyId ?? null,
    offsiteSecretAccessKey: credentials?.secretAccessKey ?? null,
    offsiteRefusal: refusal,
    offsiteVersion: offsite?.version ?? 0,
  });
}
