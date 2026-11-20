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
};

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
      const moved = stored === null ||
        stored.endpoint !== destination.endpoint ||
        stored.region !== destination.region ||
        stored.bucket !== destination.bucket ||
        stored.prefix !== destination.prefix;
      if (supplied === null && !moved) return { skip: true };
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

/**
 * backupRunner.settings: what the host runner needs, including the decrypted
 * credential pair. This is the one deliberate path where the secret leaves
 * the server: only over the runner credential, never to a user session, never
 * cached, never audited, never logged.
 */
export async function readRunnerSettings(
  transaction: PgTransactionClient,
  dependencies: Pick<BackupSettingsDependencies, "secretsKey">,
): Promise<RunnerSettings> {
  const schedule = await readBackupSchedule(transaction);
  const offsite = await readBackupOffsite(transaction);
  const effective = schedule === null
    ? { ...DEFAULT_BACKUP_SCHEDULE, version: 0 }
    : schedule;
  const configured = offsite !== null && offsite.secretId !== null;
  const credentials = configured
    ? await openBackupCredentials(transaction, dependencies.secretsKey, offsite)
    : null;
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
    offsiteVersion: offsite?.version ?? 0,
  });
}
