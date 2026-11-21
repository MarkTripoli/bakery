import { createHash } from "node:crypto";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import {
  PLUGIN_AUTHORING_KIT_DIGEST,
  PLUGIN_AUTHORING_KIT_FILES,
} from "@bakery/contracts/plugin-authoring-kit";
import {
  parsePluginManifest,
  PLUGIN_SDK_VERSION,
  type PluginInstallCapability,
  type PluginManifest,
} from "@bakery/contracts/plugin-sdk";
import type { PgTransactionClient } from "../../../platform/database.ts";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import type { ScopedOrganizationBlobStore } from "../../catalog/blob-store.ts";
import { blobObjectKey } from "../../catalog/storage-port.ts";
import {
  createPluginPackage,
  createPluginVersion,
} from "../../catalog/plugin-postgres.ts";
import {
  createPluginInstall,
  updatePluginInstall,
} from "../../catalog/plugin-install-postgres.ts";
import { addedCapabilities } from "../../catalog/plugin-install-upgrade.ts";
import {
  buildPluginBundle,
  checkPluginPackage,
  freezeAuthoringPolicy,
  type PluginPackageDiagnostic,
  type PluginPackageFiles,
  readPluginBundle,
} from "./checks.ts";
import { createPreviewRelay, type PreviewRelay } from "./preview-relay.ts";
import { HOST_OWNED_FILES } from "@bakery/contracts/plugin-authoring-kit";

/**
 * Prompt-to-private-plugin authoring (#45, B14.04).
 *
 * A person asks for a backend plugin and says which capabilities it may hold.
 * A generator writes a package; the host checks it with the same list on every
 * attempt; a package that fails is handed back with every diagnostic, up to the
 * attempt cap and the budget. A package that passes is published as a private
 * version, installed for that person (or moved onto their existing install),
 * and run once in a private preview through the same two state operations a
 * scheduled job has. Only a preview that returns a result finishes the run.
 *
 * Everything happens in the request's transaction. Each publish-and-preview is
 * under a savepoint, so a version whose preview failed leaves nothing behind,
 * and a run that crashes part way leaves nothing published at all.
 */

export const PLUGIN_AUTHORING_MAX_ATTEMPTS = 3;

export type PluginGeneratorInput = Readonly<{
  request: string;
  kit: Readonly<Record<string, string>>;
  /** The package the install runs now, for a revision. */
  current?: PluginPackageFiles;
  /** The last attempt and why it was refused, for a repair. */
  previous?: Readonly<{
    files: PluginPackageFiles;
    diagnostics: readonly PluginPackageDiagnostic[];
  }>;
}>;

export type PluginGeneratorOutput = Readonly<{
  files: PluginPackageFiles;
  usage: Readonly<{ costUsd: number }>;
}>;

/** Writes a package. It sees the request and the kit, never the policy. */
export type PluginGenerator = Readonly<{
  modelId: string;
  /** What one more attempt is expected to cost, checked against the budget first. */
  estimateCostUsd?: () => number;
  generate(input: PluginGeneratorInput): Promise<PluginGeneratorOutput>;
}>;

export type PreviewOutcome =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; reason: string; detail?: string }>;

/** Runs a package's job once, contained, talking to the host only through `relay`. */
export type PreviewRunner = Readonly<{
  run(
    input: Readonly<{
      organizationId: string;
      installId: string;
      /** Every file of the bundle, host files included. */
      files: Readonly<Record<string, string>>;
      mode: "run" | Readonly<{ migrateFrom: number }>;
      relay: PreviewRelay;
    }>,
  ): Promise<PreviewOutcome>;
}>;

export type PluginAuthoringDependencies = Readonly<{
  generator?: PluginGenerator;
  preview?: PreviewRunner;
  bundles?: Pick<ScopedOrganizationBlobStore, "putIfAbsent" | "stat" | "read">;
}>;

export type PluginAuthoringRequest = Readonly<{
  request: string;
  authorizedCapabilities: readonly PluginInstallCapability[];
  budgetUsd: number;
  maxAttempts: number;
  installId?: string;
}>;

type RunStatus = "running" | "succeeded" | "blocked" | "budget_exhausted";

const sha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");

const usd = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

function sdkVersionText(): string {
  const v = PLUGIN_SDK_VERSION;
  return `${v.major}.${v.minor}.${v.patch}`;
}

function unavailable(): never {
  // A missing generator or runtime is a refusal, never a pretend success.
  throw new StandardError({
    code: "DEPENDENCY_UNAVAILABLE",
    params: { reason: "plugin_authoring_unavailable" },
  });
}

/** The state an install holds, as a digest of its rows in a fixed order. */
export async function stateDigest(
  transaction: PgTransactionClient,
  organizationId: string,
  installId: string,
): Promise<string> {
  const rows = await transaction.query<
    {
      owner_principal_id: string | null;
      namespace: string;
      key: string;
      schema_version: number;
      value: unknown;
    }
  >(
    `select owner_principal_id, namespace, key, schema_version, value
       from bakery.plugin_state
      where organization_id = $1 and plugin_install_id = $2
      order by namespace, key, owner_principal_id nulls first`,
    [organizationId, installId],
  );
  return sha256(JSON.stringify(rows.rows.map((row) => [
    row.owner_principal_id,
    row.namespace,
    row.key,
    row.schema_version,
    row.value,
  ])));
}

/**
 * Moves an install back to a version it left, restoring the state as that
 * version left it (#34). The caller is the install's owner; the move is the
 * same PATCH a person sends, so it is refused for the same reasons.
 */
export async function rollbackPluginInstall(
  context: ActionContext,
  installId: string,
  toVersionId: string,
) {
  return await updatePluginInstall(
    context,
    { versionId: toVersionId, restoreState: true },
    installId,
  );
}

type BaseInstall = Readonly<{
  id: string;
  packageId: string;
  versionId: string;
  manifest: PluginManifest;
  files: PluginPackageFiles;
}>;

async function loadBaseInstall(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  installId: string,
  bundles: Pick<ScopedOrganizationBlobStore, "stat" | "read">,
): Promise<BaseInstall> {
  const result = await transaction.query<{
    id: string;
    plugin_package_id: string;
    plugin_version_id: string;
    scope: string;
    owner_principal_id: string | null;
    status: string;
    manifest: unknown;
    bundle_digest: string;
  }>(
    `select i.id, i.plugin_package_id, i.plugin_version_id, i.scope,
            i.owner_principal_id, i.status, v.manifest, v.bundle_digest
       from bakery.plugin_installs i
       join bakery.plugin_versions v
         on v.organization_id = i.organization_id
        and v.id = i.plugin_version_id
      where i.organization_id = $1 and i.id = $2
      for update of i`,
    [organizationId, installId],
  );
  const row = result.rows[0];
  // Authoring revises only the caller's own private install. Anything else is
  // not found, as the install routes answer it, so the run cannot be used to
  // learn whether somebody else's install exists.
  if (
    row === undefined || row.scope !== "personal" ||
    row.owner_principal_id !== principalId
  ) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_install_not_found" },
    });
  }
  if (row.status !== "enabled") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "plugin_install_not_enabled" },
    });
  }
  const stat = await bundles.stat(organizationId, row.bundle_digest);
  if (stat === null) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_bundle_missing" },
    });
  }
  let files: Record<string, string>;
  try {
    files = readPluginBundle(
      await bundles.read(organizationId, row.bundle_digest, stat.sizeBytes),
    );
  } catch {
    // An install of a package that was not authored has no files to revise.
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "plugin_install_not_authored" },
    });
  }
  for (const path of Object.keys(HOST_OWNED_FILES)) delete files[path];
  return {
    id: row.id,
    packageId: row.plugin_package_id,
    versionId: row.plugin_version_id,
    manifest: parsePluginManifest(row.manifest),
    files,
  };
}

type AttemptRecord = Readonly<{
  number: number;
  outcome: "failed" | "passed";
  filesDigest: string | null;
  checkReport: unknown;
  diagnostics: readonly unknown[];
  costUsd: number;
  versionId: string | null;
  previewResult: unknown;
}>;

async function recordAttempt(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  attempt: AttemptRecord,
): Promise<void> {
  await transaction.query(
    `insert into bakery.plugin_authoring_attempts
       (organization_id, plugin_authoring_run_id, attempt_number, outcome,
        files_digest, check_report, diagnostics, cost_usd, plugin_version_id,
        preview_result)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb)`,
    [
      organizationId,
      runId,
      attempt.number,
      attempt.outcome,
      attempt.filesDigest,
      attempt.checkReport === null ? null : JSON.stringify(attempt.checkReport),
      JSON.stringify(attempt.diagnostics),
      attempt.costUsd,
      attempt.versionId,
      attempt.previewResult === undefined
        ? null
        : JSON.stringify(attempt.previewResult),
    ],
  );
}

async function recordEvent(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  kind: string,
  detail: unknown,
): Promise<void> {
  await transaction.query(
    `insert into bakery.plugin_authoring_events
       (organization_id, plugin_authoring_run_id, kind, detail)
     values ($1, $2, $3, $4::jsonb)`,
    [organizationId, runId, kind, JSON.stringify(detail)],
  );
}

async function finishRun(
  transaction: PgTransactionClient,
  organizationId: string,
  runId: string,
  outcome: Readonly<{
    status: RunStatus;
    spentUsd: number;
    packageId?: string | null;
    versionId?: string | null;
    installId?: string | null;
    failure?: unknown;
  }>,
): Promise<void> {
  await transaction.query(
    `update bakery.plugin_authoring_runs
        set status = $3, spent_usd = $4, plugin_package_id = $5,
            plugin_version_id = $6, plugin_install_id = $7,
            failure = $8::jsonb, updated_at = now(), finished_at = now()
      where organization_id = $1 and id = $2`,
    [
      organizationId,
      runId,
      outcome.status,
      outcome.spentUsd,
      outcome.packageId ?? null,
      outcome.versionId ?? null,
      outcome.installId ?? null,
      outcome.failure === undefined ? null : JSON.stringify(outcome.failure),
    ],
  );
}

type PublishOutcome =
  | Readonly<{
    ok: true;
    packageId: string;
    versionId: string;
    installId: string;
    preview: unknown;
  }>
  | Readonly<{
    ok: false;
    diagnostics: PluginPackageDiagnostic[];
    blocked?: unknown;
  }>;

const previewDiagnostic = (
  reason: string,
  detail?: string,
): PluginPackageDiagnostic =>
  Object.freeze({
    check: "build",
    code: "PREVIEW_FAILED",
    message: detail === undefined ? reason : `${reason}: ${detail}`,
  });

/** Runs one attempt's job (or migration) and says why it did not return. */
async function preview(
  deps: Required<Pick<PluginAuthoringDependencies, "preview">>,
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    installId: string;
    files: Readonly<Record<string, string>>;
    manifest: PluginManifest;
    mode: "run" | Readonly<{ migrateFrom: number }>;
  }>,
): Promise<PreviewOutcome> {
  try {
    return await deps.preview.run({
      organizationId: input.organizationId,
      installId: input.installId,
      files: input.files,
      mode: input.mode,
      relay: createPreviewRelay(transaction, {
        organizationId: input.organizationId,
        installId: input.installId,
        stateNamespaces: input.manifest.stateNamespaces,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "preview_runtime_error",
      detail: error instanceof Error ? error.message.slice(0, 500) : undefined,
    };
  }
}

/**
 * Publishes a passing package and proves it in a private preview, under a
 * savepoint. A preview that does not return a result rolls the savepoint back:
 * no package, version or install from this attempt survives it.
 */
async function publishAndPreview(
  context: ActionContext,
  deps: Required<PluginAuthoringDependencies>,
  input: Readonly<{
    runId: string;
    attempt: number;
    requestDigest: string;
    modelId: string;
    files: PluginPackageFiles;
    manifest: PluginManifest;
    sdkRange: string;
    checkReport: unknown;
    base: BaseInstall | null;
  }>,
): Promise<PublishOutcome> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const bundle = buildPluginBundle(input.files);
  // The bytes go to the store first; a version row then proves they are there.
  // Bytes whose version is rolled back are unreferenced and collectable.
  await deps.bundles.putIfAbsent(organizationId, bundle.digest, bundle.bytes);
  const savepoint = `plugin_authoring_${input.attempt}`;
  await transaction.query(`savepoint ${savepoint}`);
  const stateBefore = input.base === null
    ? null
    : await stateDigest(transaction, organizationId, input.base.id);
  const failed = async (
    diagnostics: PluginPackageDiagnostic[],
    extra: { blocked?: unknown; rolledBack?: unknown } = {},
  ): Promise<PublishOutcome> => {
    await transaction.query(`rollback to savepoint ${savepoint}`);
    if (extra.rolledBack !== undefined) {
      await recordEvent(
        transaction,
        organizationId,
        input.runId,
        "rolled_back",
        {
          ...(extra.rolledBack as Record<string, unknown>),
          stateDigestAfterRollback: await stateDigest(
            transaction,
            organizationId,
            input.base!.id,
          ),
        },
      );
    }
    return { ok: false, diagnostics, blocked: extra.blocked };
  };

  const packageId = input.base?.packageId ?? (await createPluginPackage(
    context,
    {
      name: `${input.manifest.name}-${input.runId.slice(0, 8)}`,
      displayName: input.manifest.name,
      license: "UNLICENSED",
      provenance: {
        generatedBy: "plugin-authoring",
        runId: input.runId,
        modelId: input.modelId,
        kitDigest: PLUGIN_AUTHORING_KIT_DIGEST,
      },
    },
  )).id;
  const version = await createPluginVersion(
    context,
    {
      versionName: `authored-${input.runId.slice(0, 8)}-${input.attempt}`,
      sdkRange: input.sdkRange,
      manifest: JSON.parse(input.files["manifest.json"]),
      bundleObjectRef: blobObjectKey(organizationId, bundle.digest),
      bundleDigest: bundle.digest,
      sourceEvidence: {
        kind: "plugin-authoring",
        requestDigest: input.requestDigest,
        runId: input.runId,
        attempt: input.attempt,
      },
      buildEvidence: {
        checks: input.checkReport,
        kitDigest: PLUGIN_AUTHORING_KIT_DIGEST,
        sdkVersion: sdkVersionText(),
        modelId: input.modelId,
        runId: input.runId,
      },
    },
    packageId,
    { bundles: deps.bundles },
  );

  let installId: string;
  if (input.base === null) {
    // First authoring: a personal, private install for the caller only.
    installId = (await createPluginInstall(context, {
      packageId,
      versionId: version.id,
      scope: "personal",
    })).id;
  } else {
    installId = input.base.id;
    // Exactly the added capabilities are approved, and only because each is
    // already inside what the request authorized (the authority check).
    const moved = await updatePluginInstall(
      context,
      {
        versionId: version.id,
        approveCapabilities: addedCapabilities(
          input.base.manifest,
          input.manifest,
        ),
      },
      installId,
    );
    if (moved.pluginVersionId !== version.id) {
      return await failed([], {
        blocked: {
          reason: "plugin_update_refused",
          lastUpdateFailure: moved.lastUpdateFailure,
        },
      });
    }
  }

  const files = { ...input.files, ...HOST_OWNED_FILES };
  if (
    input.base !== null &&
    input.manifest.stateSchemaVersion > input.base.manifest.stateSchemaVersion
  ) {
    // The new version writes a newer shape: its migrate moves what the old
    // one saved before the job runs on it.
    const migrated = await preview(deps, transaction, {
      organizationId,
      installId,
      files,
      manifest: input.manifest,
      mode: { migrateFrom: input.base.manifest.stateSchemaVersion },
    });
    if (!migrated.ok) {
      return await failed(
        [previewDiagnostic(`migrate ${migrated.reason}`, migrated.detail)],
        {
          rolledBack: await rollBackRevision(context, input.base, {
            stateBefore: stateBefore!,
            failedVersionId: version.id,
            stage: "migrate",
            reason: migrated.reason,
          }),
        },
      );
    }
  }
  const ran = await preview(deps, transaction, {
    organizationId,
    installId,
    files,
    manifest: input.manifest,
    mode: "run",
  });
  if (!ran.ok) {
    return await failed(
      [previewDiagnostic(ran.reason, ran.detail)],
      input.base === null ? {} : {
        rolledBack: await rollBackRevision(context, input.base, {
          stateBefore: stateBefore!,
          failedVersionId: version.id,
          stage: "preview",
          reason: ran.reason,
        }),
      },
    );
  }
  await transaction.query(`release savepoint ${savepoint}`);
  return {
    ok: true,
    packageId,
    versionId: version.id,
    installId,
    preview: ran.result,
  };
}

/**
 * Puts a revised install back on the version it left, restoring its state the
 * way a person's rollback does (#34), and says what the state was on each side.
 */
async function rollBackRevision(
  context: ActionContext,
  base: BaseInstall,
  input: Readonly<{
    stateBefore: string;
    failedVersionId: string;
    stage: "migrate" | "preview";
    reason: string;
  }>,
): Promise<Record<string, unknown>> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const restored = await rollbackPluginInstall(
    context,
    base.id,
    base.versionId,
  );
  return {
    installId: base.id,
    fromVersionId: input.failedVersionId,
    toVersionId: base.versionId,
    restoredVersionId: restored.pluginVersionId,
    stage: input.stage,
    reason: input.reason,
    stateDigestBefore: input.stateBefore,
    stateDigestRestored: await stateDigest(
      transaction,
      organizationId,
      base.id,
    ),
  };
}

/** Runs one authoring request to an outcome and answers with the run's id. */
export async function runPluginAuthoring(
  context: ActionContext,
  deps: PluginAuthoringDependencies,
  request: PluginAuthoringRequest,
): Promise<string> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const { generator, preview: previewRunner, bundles } = deps;
  if (
    generator === undefined || previewRunner === undefined ||
    bundles === undefined
  ) unavailable();
  if (
    !Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 ||
    request.maxAttempts > PLUGIN_AUTHORING_MAX_ATTEMPTS
  ) {
    throw new StandardError({
      code: "VALIDATION_FAILED",
      params: { reason: "plugin_authoring_attempts_out_of_range" },
    });
  }
  // Built here, from the authorized request, and frozen. Nothing a generator
  // writes reaches it.
  const policy = freezeAuthoringPolicy(request.authorizedCapabilities);
  const base = request.installId === undefined ? null : await loadBaseInstall(
    transaction,
    organizationId,
    principalId,
    request.installId,
    bundles,
  );
  const requestDigest = sha256(request.request);
  const created = await transaction.query<{ id: string }>(
    `insert into bakery.plugin_authoring_runs
       (organization_id, actor_principal_id, status, request_text,
        request_digest, authorized_capabilities, budget_usd, max_attempts,
        kit_digest, sdk_version, model_id, base_plugin_install_id)
     values ($1, $2, 'running', $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      organizationId,
      principalId,
      request.request,
      requestDigest,
      JSON.stringify(policy.authorizedCapabilities),
      request.budgetUsd,
      request.maxAttempts,
      PLUGIN_AUTHORING_KIT_DIGEST,
      sdkVersionText(),
      generator.modelId,
      base?.id ?? null,
    ],
  );
  const runId = created.rows[0].id;
  const full = { generator, preview: previewRunner, bundles };

  let spent = 0;
  let lastCost = 0;
  let previous: PluginGeneratorInput["previous"];
  for (let attempt = 1; attempt <= request.maxAttempts; attempt++) {
    const estimate = generator.estimateCostUsd?.() ?? lastCost;
    if (usd(spent + estimate) > request.budgetUsd) {
      await finishRun(transaction, organizationId, runId, {
        status: "budget_exhausted",
        spentUsd: usd(spent),
        failure: { reason: "budget_exhausted", attempts: attempt - 1 },
      });
      return runId;
    }
    let generated: PluginGeneratorOutput;
    try {
      generated = await generator.generate({
        request: request.request,
        kit: PLUGIN_AUTHORING_KIT_FILES,
        ...(base === null ? {} : { current: base.files }),
        ...(previous === undefined ? {} : { previous }),
      });
    } catch (error) {
      const diagnostics = [{
        check: "generator",
        code: "GENERATOR_FAILED",
        message: error instanceof Error ? error.message.slice(0, 500) : "",
      }];
      await recordAttempt(transaction, organizationId, runId, {
        number: attempt,
        outcome: "failed",
        filesDigest: null,
        checkReport: null,
        diagnostics,
        costUsd: 0,
        versionId: null,
        previewResult: undefined,
      });
      continue;
    }
    lastCost = Math.max(0, generated.usage.costUsd);
    spent += lastCost;
    const checked = await checkPluginPackage(generated.files, policy);
    if (
      !checked.ok || checked.manifest === null || checked.sdkRange === null
    ) {
      await recordAttempt(transaction, organizationId, runId, {
        number: attempt,
        outcome: "failed",
        filesDigest: checked.report.filesDigest,
        checkReport: checked.report,
        diagnostics: checked.diagnostics,
        costUsd: usd(lastCost),
        versionId: null,
        previewResult: undefined,
      });
      previous = { files: generated.files, diagnostics: checked.diagnostics };
      continue;
    }
    const published = await publishAndPreview(context, full, {
      runId,
      attempt,
      requestDigest,
      modelId: generator.modelId,
      files: generated.files,
      manifest: checked.manifest,
      sdkRange: checked.sdkRange,
      checkReport: checked.report,
      base,
    });
    if (!published.ok) {
      await recordAttempt(transaction, organizationId, runId, {
        number: attempt,
        outcome: "failed",
        filesDigest: checked.report.filesDigest,
        checkReport: checked.report,
        diagnostics: published.diagnostics,
        costUsd: usd(lastCost),
        versionId: null,
        previewResult: undefined,
      });
      if (published.blocked !== undefined) {
        await finishRun(transaction, organizationId, runId, {
          status: "blocked",
          spentUsd: usd(spent),
          failure: published.blocked,
        });
        return runId;
      }
      previous = { files: generated.files, diagnostics: published.diagnostics };
      continue;
    }
    await recordAttempt(transaction, organizationId, runId, {
      number: attempt,
      outcome: "passed",
      filesDigest: checked.report.filesDigest,
      checkReport: checked.report,
      diagnostics: [],
      costUsd: usd(lastCost),
      versionId: published.versionId,
      previewResult: published.preview,
    });
    await finishRun(transaction, organizationId, runId, {
      status: "succeeded",
      spentUsd: usd(spent),
      packageId: published.packageId,
      versionId: published.versionId,
      installId: published.installId,
    });
    return runId;
  }
  await finishRun(transaction, organizationId, runId, {
    status: "blocked",
    spentUsd: usd(spent),
    failure: { reason: "attempts_exhausted", attempts: request.maxAttempts },
  });
  return runId;
}
