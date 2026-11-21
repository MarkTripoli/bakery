import { createHash } from "node:crypto";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import {
  HOST_OWNED_FILES,
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
import {
  createPreviewRelay,
  type PreviewCall,
  type PreviewRelay,
} from "./preview-relay.ts";

/**
 * Prompt-to-private-plugin authoring (#45, B14.04).
 *
 * A person asks for a backend plugin and says which capabilities it may hold.
 * A generator writes a package; the host checks it with the same list on every
 * attempt; a package that fails is handed back with every diagnostic, up to the
 * attempt cap and the budget. A package that passes is published as a private
 * version, installed for that person (or moved onto their existing install),
 * and run once in a preview through the two state operations a scheduled job
 * has. Only a preview that returns a result finishes the run.
 *
 * Transactions are short and never span the slow parts. Generation, the
 * typecheck and the preview hold no transaction and no connection; each write
 * (the run row, an attempt, the publish-and-install, a compensation, the
 * outcome) is its own transaction under the caller's live authority, and each
 * preview state call is one more. A published version is previewed after its
 * transaction commits, so a preview that fails is compensated explicitly: a new
 * install is uninstalled and its package withdrawn, a revised install is rolled
 * back to the version and state it left. The run row names what is published
 * and not yet previewed, so a run a crash interrupts is settled the same way
 * when it is next read (`settleInterruptedRun`).
 */

export const PLUGIN_AUTHORING_MAX_ATTEMPTS = 3;
/** A running run not touched for this long was interrupted. */
export const PLUGIN_AUTHORING_STALE_AFTER_MS = 15 * 60 * 1000;

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

/** The points between transactions a fault can be injected at, in order. */
export type AuthoringBoundary =
  | "run_created"
  | "attempt_recorded"
  | "published";

export type PluginAuthoringDependencies = Readonly<{
  generator?: PluginGenerator;
  preview?: PreviewRunner;
  bundles?: Pick<ScopedOrganizationBlobStore, "putIfAbsent" | "stat" | "read">;
  /**
   * Fault injection for recovery tests: called as each boundary is crossed.
   * A throw ends the request there, exactly as a crash would.
   */
  boundary?: (name: AuthoringBoundary) => void | Promise<void>;
  staleRunAfterMs?: number;
}>;

/**
 * Runs `work` in one short transaction under the caller's live authority and
 * commits it. The route supplies it; every write here goes through it.
 */
export type AuthoringTransaction = <T>(
  work: (context: ActionContext) => Promise<T>,
) => Promise<T>;

export type PluginAuthoringRequest = Readonly<{
  /** The caller's Idempotency-Key; a retry with it returns the same run. */
  idempotencyKey: string;
  /** Digest of the request body the key was first sent with. */
  bodyDigest: string;
  request: string;
  authorizedCapabilities: readonly PluginInstallCapability[];
  budgetUsd: number;
  maxAttempts: number;
  installId?: string;
}>;

type RunStatus =
  | "running"
  | "succeeded"
  | "unchanged"
  | "blocked"
  | "budget_exhausted"
  | "interrupted";

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

/** The state an install holds, as a digest of its rows' content in a fixed order. */
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
      where i.organization_id = $1 and i.id = $2`,
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
    spentUsd?: number;
    packageId?: string | null;
    versionId?: string | null;
    installId?: string | null;
    failure?: unknown;
  }>,
): Promise<void> {
  await transaction.query(
    `update bakery.plugin_authoring_runs
        set status = $3, spent_usd = coalesce($4, spent_usd),
            plugin_package_id = $5, plugin_version_id = $6,
            plugin_install_id = $7, failure = $8::jsonb, phase = 'finished',
            pending_plugin_version_id = null, pending_plugin_install_id = null,
            pending_first_install = null, pending_state_digest = null,
            updated_at = now(), finished_at = now()
      where organization_id = $1 and id = $2`,
    [
      organizationId,
      runId,
      outcome.status,
      outcome.spentUsd ?? null,
      outcome.packageId ?? null,
      outcome.versionId ?? null,
      outcome.installId ?? null,
      outcome.failure === undefined ? null : JSON.stringify(outcome.failure),
    ],
  );
}

const previewDiagnostic = (
  reason: string,
  detail?: string,
): PluginPackageDiagnostic =>
  Object.freeze({
    check: "build",
    code: "PREVIEW_FAILED",
    message: detail === undefined ? reason : `${reason}: ${detail}`,
  });

/** Thrown inside the publish transaction to roll it back on a refused move. */
class MoveRefused extends Error {
  constructor(readonly lastUpdateFailure: unknown) {
    super("plugin_update_refused");
  }
}

/** What a run published and has not yet proven, as the run row records it. */
type Pending = Readonly<{
  runId: string;
  versionId: string;
  installId: string;
  firstInstall: boolean;
  packageId: string;
  /** Digest of the install's state before the move (revisions only). */
  stateDigestBefore: string | null;
  /** The version a revision left (revisions only). */
  previousVersionId: string | null;
}>;

/**
 * Undoes a publish whose preview did not prove it, in one transaction.
 *
 * A new install is uninstalled, which revokes its grants, and its package (made
 * by this run alone) is withdrawn so it cannot be installed again. A revised
 * install is moved back to the version it left with that version's state
 * restored (#34), and the state digest on each side is kept as evidence.
 */
async function compensate(
  context: ActionContext,
  pending: Pending,
  why: Readonly<{ kind: string; stage: string; reason: string }>,
): Promise<void> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  if (pending.firstInstall) {
    await updatePluginInstall(
      context,
      { status: "uninstalled" },
      pending.installId,
    );
    await transaction.query(
      `update bakery.plugin_packages
          set listing_status = 'withdrawn', updated_at = now(),
              version = version + 1
        where organization_id = $1 and id = $2`,
      [organizationId, pending.packageId],
    );
    await recordEvent(transaction, organizationId, pending.runId, why.kind, {
      action: "uninstalled",
      installId: pending.installId,
      versionId: pending.versionId,
      packageId: pending.packageId,
      stage: why.stage,
      reason: why.reason,
    });
    return;
  }
  const restored = await rollbackPluginInstall(
    context,
    pending.installId,
    pending.previousVersionId!,
  );
  await recordEvent(transaction, organizationId, pending.runId, why.kind, {
    action: "rolled_back",
    installId: pending.installId,
    fromVersionId: pending.versionId,
    toVersionId: pending.previousVersionId,
    restoredVersionId: restored.pluginVersionId,
    stage: why.stage,
    reason: why.reason,
    stateDigestBefore: pending.stateDigestBefore,
    stateDigestRestored: await stateDigest(
      transaction,
      organizationId,
      pending.installId,
    ),
  });
}

/**
 * Settles a run a crash left `running` and stale, under its author's authority.
 * Whatever it had published and not proven is compensated, the run says
 * `interrupted`, and an event names what was done. Answers whether it settled.
 */
export async function settleInterruptedRun(
  context: ActionContext,
  runId: string,
  staleAfterMs: number = PLUGIN_AUTHORING_STALE_AFTER_MS,
): Promise<boolean> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const found = await transaction.query<{
    phase: string;
    pending_plugin_version_id: string | null;
    pending_plugin_install_id: string | null;
    pending_first_install: boolean | null;
    pending_state_digest: string | null;
    base_plugin_install_id: string | null;
    actor_principal_id: string;
  }>(
    `select phase, pending_plugin_version_id, pending_plugin_install_id,
            pending_first_install, pending_state_digest,
            base_plugin_install_id, actor_principal_id
       from bakery.plugin_authoring_runs
      where organization_id = $1 and id = $2 and status = 'running'
        and updated_at < now() - make_interval(secs => $3::double precision / 1000)
      for update`,
    [organizationId, runId, staleAfterMs],
  );
  const row = found.rows[0];
  if (row === undefined || row.actor_principal_id !== principalId) {
    return false;
  }
  if (
    row.phase === "previewing" && row.pending_plugin_version_id !== null &&
    row.pending_plugin_install_id !== null
  ) {
    const pending: Pending = {
      runId,
      versionId: row.pending_plugin_version_id,
      installId: row.pending_plugin_install_id,
      firstInstall: row.pending_first_install === true,
      packageId: (await transaction.query<{ plugin_package_id: string }>(
        `select plugin_package_id from bakery.plugin_versions
          where organization_id = $1 and id = $2`,
        [organizationId, row.pending_plugin_version_id],
      )).rows[0].plugin_package_id,
      stateDigestBefore: row.pending_state_digest,
      previousVersionId: row.pending_first_install === true
        ? null
        : (await transaction.query<{ to_version: string }>(
          `select detail->>'previousVersionId' as to_version
             from bakery.plugin_authoring_events
            where organization_id = $1 and plugin_authoring_run_id = $2
              and kind = 'published'
            order by created_at desc, id desc limit 1`,
          [organizationId, runId],
        )).rows[0].to_version,
    };
    await compensate(context, pending, {
      kind: "interrupted",
      stage: "preview",
      reason: "run_interrupted",
    });
  } else {
    await recordEvent(transaction, organizationId, runId, "interrupted", {
      action: "none",
      phase: row.phase,
      reason: "run_interrupted",
    });
  }
  await finishRun(transaction, organizationId, runId, {
    status: "interrupted",
    failure: { reason: "run_interrupted", phase: row.phase },
  });
  return true;
}

/** Runs one authoring request to an outcome and answers with the run's id. */
export async function runPluginAuthoring(
  tx: AuthoringTransaction,
  deps: PluginAuthoringDependencies,
  request: PluginAuthoringRequest,
): Promise<string> {
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
  const boundary = async (name: AuthoringBoundary) => {
    await deps.boundary?.(name);
  };
  // Built here, from the authorized request, and frozen. Nothing a generator
  // writes reaches it.
  const policy = freezeAuthoringPolicy(request.authorizedCapabilities);
  const requestDigest = sha256(request.request);

  // Transaction 1: the run row.
  const started = await tx(async (context) => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const base = request.installId === undefined ? null : await loadBaseInstall(
      transaction,
      organizationId,
      principalId,
      request.installId,
      bundles,
    );
    // A retry of the same request answers with its run, as the generic
    // command replay would: the same body gets the run, another body is a
    // payload mismatch, and a run still working is in flight. The key is
    // locked first so two concurrent retries cannot both start a run.
    await transaction.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`plugin-authoring:${organizationId}:${principalId}:${request.idempotencyKey}`],
    );
    const replay = await transaction.query<
      { id: string; request_body_digest: string; status: string }
    >(
      `select id, request_body_digest, status
         from bakery.plugin_authoring_runs
        where organization_id = $1 and actor_principal_id = $2
          and idempotency_key = $3`,
      [organizationId, principalId, request.idempotencyKey],
    );
    const earlier = replay.rows[0];
    if (earlier !== undefined) {
      if (earlier.request_body_digest !== request.bodyDigest) {
        throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
      }
      if (
        earlier.status === "running" &&
        !await settleInterruptedRun(context, earlier.id, deps.staleRunAfterMs)
      ) {
        throw new StandardError({ code: "IDEMPOTENCY_IN_FLIGHT" });
      }
      return { kind: "replayed", runId: earlier.id } as const;
    }
    const created = await transaction.query<{ id: string }>(
      `insert into bakery.plugin_authoring_runs
         (organization_id, actor_principal_id, status, request_text,
          request_digest, authorized_capabilities, budget_usd, max_attempts,
          kit_digest, sdk_version, model_id, base_plugin_install_id,
          idempotency_key, request_body_digest)
       values ($1, $2, 'running', $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11,
               $12, $13)
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
        request.idempotencyKey,
        request.bodyDigest,
      ],
    );
    return {
      kind: "created",
      runId: created.rows[0].id,
      base,
      organizationId,
    } as const;
  });
  if (started.kind === "replayed") return started.runId;
  const { runId, base, organizationId } = started;
  await boundary("run_created");

  const finish = (outcome: Parameters<typeof finishRun>[3]) =>
    tx((context) => {
      const { transaction } = requireWorkTransaction(context);
      return finishRun(transaction, organizationId, runId, outcome);
    });

  let spent = 0;
  let lastCost = 0;
  let previous: PluginGeneratorInput["previous"];
  for (let attempt = 1; attempt <= request.maxAttempts; attempt++) {
    const estimate = generator.estimateCostUsd?.() ?? lastCost;
    if (usd(spent + estimate) > request.budgetUsd) {
      await finish({
        status: "budget_exhausted",
        spentUsd: usd(spent),
        failure: { reason: "budget_exhausted", attempts: attempt - 1 },
      });
      return runId;
    }

    // No transaction: generation and every check, the typecheck included.
    let files: PluginPackageFiles | null = null;
    let diagnostics: readonly unknown[];
    let report: unknown = null;
    let filesDigest: string | null = null;
    let checked: Awaited<ReturnType<typeof checkPluginPackage>> | null = null;
    try {
      const generated = await generator.generate({
        request: request.request,
        kit: PLUGIN_AUTHORING_KIT_FILES,
        ...(base === null ? {} : { current: base.files }),
        ...(previous === undefined ? {} : { previous }),
      });
      lastCost = Math.max(0, generated.usage.costUsd);
      spent += lastCost;
      files = generated.files;
      checked = await checkPluginPackage(files, policy);
      diagnostics = checked.diagnostics;
      report = checked.report;
      filesDigest = checked.report.filesDigest;
    } catch (error) {
      lastCost = 0;
      diagnostics = [{
        check: "generator",
        code: "GENERATOR_FAILED",
        message: error instanceof Error ? error.message.slice(0, 500) : "",
      }];
    }
    const passedChecks = checked !== null && checked.ok &&
      checked.manifest !== null && checked.sdkRange !== null;

    // Transaction: the attempt and what the run has spent.
    const cost = usd(lastCost);
    await tx(async (context) => {
      const { transaction } = requireWorkTransaction(context);
      await transaction.query(
        `insert into bakery.plugin_authoring_attempts
           (organization_id, plugin_authoring_run_id, attempt_number, outcome,
            files_digest, check_report, diagnostics, cost_usd)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
        [
          organizationId,
          runId,
          attempt,
          passedChecks ? "checked" : "failed",
          filesDigest,
          report === null ? null : JSON.stringify(report),
          JSON.stringify(diagnostics),
          cost,
        ],
      );
      await transaction.query(
        `update bakery.plugin_authoring_runs
            set spent_usd = $3, updated_at = now()
          where organization_id = $1 and id = $2`,
        [organizationId, runId, usd(spent)],
      );
    });
    await boundary("attempt_recorded");
    if (!passedChecks || files === null || checked === null) {
      if (files !== null) {
        previous = {
          files,
          diagnostics: diagnostics as PluginPackageDiagnostic[],
        };
      }
      continue;
    }
    const manifest = checked.manifest!;
    const settleAttempt = (
      outcome: "passed" | "failed",
      extra: {
        diagnostics?: readonly unknown[];
        versionId?: string;
        preview?: unknown;
      },
    ) =>
    async (context: ActionContext) => {
      const { transaction } = requireWorkTransaction(context);
      await transaction.query(
        `update bakery.plugin_authoring_attempts
              set outcome = $4,
                  diagnostics = coalesce($5::jsonb, diagnostics),
                  plugin_version_id = $6, preview_result = $7::jsonb
            where organization_id = $1 and plugin_authoring_run_id = $2
              and attempt_number = $3`,
        [
          organizationId,
          runId,
          attempt,
          outcome,
          extra.diagnostics === undefined
            ? null
            : JSON.stringify(extra.diagnostics),
          extra.versionId ?? null,
          extra.preview === undefined ? null : JSON.stringify(extra.preview),
        ],
      );
    };

    // The bytes go to the store with no transaction held. Bytes whose version
    // never commits are unreferenced and collectable.
    const bundle = buildPluginBundle(files);
    await bundles.putIfAbsent(organizationId, bundle.digest, bundle.bytes);

    // Transaction: publish and install (or move), or recognise a revision that
    // changed nothing.
    let published:
      | Pending
      | { unchanged: string }
      | { refused: unknown };
    try {
      published = await tx(async (context) => {
        const { transaction } = requireWorkTransaction(context);
        if (base !== null) {
          const same = await transaction.query<{ id: string }>(
            `select id from bakery.plugin_versions
              where organization_id = $1 and plugin_package_id = $2
                and bundle_digest = $3`,
            [organizationId, base.packageId, bundle.digest],
          );
          if (same.rows[0] !== undefined) {
            // The same bytes are already a version of this package: a revision
            // that changes nothing, not a second label for identical content.
            await settleAttempt("passed", { versionId: same.rows[0].id })(
              context,
            );
            await finishRun(transaction, organizationId, runId, {
              status: "unchanged",
              spentUsd: usd(spent),
              packageId: base.packageId,
              versionId: same.rows[0].id,
              installId: base.id,
            });
            return { unchanged: same.rows[0].id };
          }
        }
        const stateBefore = base === null
          ? null
          : await stateDigest(transaction, organizationId, base.id);
        const packageId = base?.packageId ?? (await createPluginPackage(
          context,
          {
            name: `${manifest.name}-${runId.slice(0, 8)}-${attempt}`,
            displayName: manifest.name,
            license: "UNLICENSED",
            provenance: {
              generatedBy: "plugin-authoring",
              runId,
              modelId: generator.modelId,
              kitDigest: PLUGIN_AUTHORING_KIT_DIGEST,
            },
          },
        )).id;
        const version = await createPluginVersion(
          context,
          {
            versionName: `authored-${runId.slice(0, 8)}-${attempt}`,
            sdkRange: checked.sdkRange!,
            manifest: JSON.parse(files!["manifest.json"]),
            bundleObjectRef: blobObjectKey(organizationId, bundle.digest),
            bundleDigest: bundle.digest,
            sourceEvidence: {
              kind: "plugin-authoring",
              requestDigest,
              runId,
              attempt,
            },
            buildEvidence: {
              checks: checked.report,
              kitDigest: PLUGIN_AUTHORING_KIT_DIGEST,
              sdkVersion: sdkVersionText(),
              modelId: generator.modelId,
              runId,
            },
          },
          packageId,
          { bundles },
        );
        let installId: string;
        if (base === null) {
          // First authoring: a personal, private install for the caller only.
          installId = (await createPluginInstall(context, {
            packageId,
            versionId: version.id,
            scope: "personal",
          })).id;
        } else {
          installId = base.id;
          // Exactly the added capabilities are approved, and only because each
          // is already inside what the request authorized.
          const moved = await updatePluginInstall(
            context,
            {
              versionId: version.id,
              approveCapabilities: addedCapabilities(base.manifest, manifest),
            },
            installId,
          );
          if (moved.pluginVersionId !== version.id) {
            throw new MoveRefused(moved.lastUpdateFailure);
          }
        }
        // The run says what it published and has not proven, and an event says
        // why the install now points at an unpreviewed version, in the same
        // transaction that made it so.
        await transaction.query(
          `update bakery.plugin_authoring_runs
              set phase = 'previewing', pending_plugin_version_id = $3,
                  pending_plugin_install_id = $4, pending_first_install = $5,
                  pending_state_digest = $6, updated_at = now()
            where organization_id = $1 and id = $2`,
          [
            organizationId,
            runId,
            version.id,
            installId,
            base === null,
            stateBefore,
          ],
        );
        await recordEvent(transaction, organizationId, runId, "published", {
          versionId: version.id,
          installId,
          packageId,
          previousVersionId: base?.versionId ?? null,
          firstInstall: base === null,
          stateDigestBefore: stateBefore,
          previewed: false,
        });
        return {
          runId,
          versionId: version.id,
          installId,
          firstInstall: base === null,
          packageId,
          stateDigestBefore: stateBefore,
          previousVersionId: base?.versionId ?? null,
        };
      });
    } catch (error) {
      if (!(error instanceof MoveRefused)) throw error;
      published = { refused: error.lastUpdateFailure };
    }
    if ("unchanged" in published) return runId;
    if ("refused" in published) {
      const blocked = {
        reason: "plugin_update_refused",
        lastUpdateFailure: published.refused,
      };
      await tx(async (context) => {
        await settleAttempt("failed", {})(context);
        const { transaction } = requireWorkTransaction(context);
        await finishRun(transaction, organizationId, runId, {
          status: "blocked",
          spentUsd: usd(spent),
          failure: blocked,
        });
      });
      return runId;
    }
    const pending = published;
    await boundary("published");

    // No transaction: the preview. Each state call it makes is one short
    // transaction of its own.
    const relay: PreviewRelay = (call: PreviewCall) =>
      tx((context) =>
        createPreviewRelay(requireWorkTransaction(context).transaction, {
          organizationId,
          installId: pending.installId,
          stateNamespaces: manifest.stateNamespaces,
        })(call)
      );
    const runPreview = async (
      mode: "run" | Readonly<{ migrateFrom: number }>,
    ): Promise<PreviewOutcome> => {
      try {
        return await previewRunner.run({
          organizationId,
          installId: pending.installId,
          files: { ...files!, ...HOST_OWNED_FILES },
          mode,
          relay,
        });
      } catch (error) {
        return {
          ok: false,
          reason: "preview_runtime_error",
          detail: error instanceof Error
            ? error.message.slice(0, 500)
            : undefined,
        };
      }
    };
    let failed:
      | { stage: string; outcome: PreviewOutcome & { ok: false } }
      | null = null;
    if (
      base !== null &&
      manifest.stateSchemaVersion > base.manifest.stateSchemaVersion
    ) {
      // The new version writes a newer shape: its migrate moves what the old
      // one saved before the job runs on it.
      const migrated = await runPreview({
        migrateFrom: base.manifest.stateSchemaVersion,
      });
      if (!migrated.ok) failed = { stage: "migrate", outcome: migrated };
    }
    let ran: PreviewOutcome | null = null;
    if (failed === null) {
      ran = await runPreview("run");
      if (!ran.ok) failed = { stage: "preview", outcome: ran };
    }

    if (failed !== null) {
      const found = [
        previewDiagnostic(
          failed.stage === "migrate"
            ? `migrate ${failed.outcome.reason}`
            : failed.outcome.reason,
          failed.outcome.detail,
        ),
      ];
      // Transaction: compensate, and the attempt says why it failed.
      await tx(async (context) => {
        await compensate(context, pending, {
          kind: pending.firstInstall ? "compensated" : "rolled_back",
          stage: failed!.stage,
          reason: failed!.outcome.reason,
        });
        await settleAttempt("failed", { diagnostics: found })(context);
        const { transaction } = requireWorkTransaction(context);
        await transaction.query(
          `update bakery.plugin_authoring_runs
              set phase = 'generating', pending_plugin_version_id = null,
                  pending_plugin_install_id = null,
                  pending_first_install = null, pending_state_digest = null,
                  updated_at = now()
            where organization_id = $1 and id = $2`,
          [organizationId, runId],
        );
      });
      previous = { files, diagnostics: found };
      continue;
    }

    // Transaction: the outcome.
    await tx(async (context) => {
      await settleAttempt("passed", {
        versionId: pending.versionId,
        preview: (ran as { result: unknown }).result,
      })(context);
      const { transaction } = requireWorkTransaction(context);
      await finishRun(transaction, organizationId, runId, {
        status: "succeeded",
        spentUsd: usd(spent),
        packageId: pending.packageId,
        versionId: pending.versionId,
        installId: pending.installId,
      });
    });
    return runId;
  }
  await finish({
    status: "blocked",
    spentUsd: usd(spent),
    failure: { reason: "attempts_exhausted", attempts: request.maxAttempts },
  });
  return runId;
}
