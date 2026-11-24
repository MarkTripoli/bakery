import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { requireWorkTransaction } from "../../work/work-transaction.ts";

type PluginAuthoringRun = z.output<typeof contractSchemas.PluginAuthoringRun>;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** Numeric columns come back as strings; the contract's decimal is exact text. */
const decimal = (value: string | number): string => {
  const text = String(value);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
};

/**
 * Reads one authoring run with its attempts and events (#45). A run is its
 * author's: anybody else, in this organization or another, is told it does not
 * exist, the same answer a personal install gives.
 */
export async function getPluginAuthoringRun(
  context: ActionContext,
  runId: string,
): Promise<PluginAuthoringRun> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const runs = await transaction.query<{
    id: string;
    actor_principal_id: string;
    status: string;
    request_text: string;
    request_digest: string;
    authorized_capabilities: unknown;
    budget_usd: string;
    spent_usd: string;
    max_attempts: number;
    kit_digest: string;
    sdk_version: string;
    model_id: string;
    base_plugin_install_id: string | null;
    plugin_package_id: string | null;
    plugin_version_id: string | null;
    plugin_install_id: string | null;
    failure: unknown;
    created_at: Date | string;
    updated_at: Date | string;
    finished_at: Date | string | null;
  }>(
    `select id, actor_principal_id, status, request_text, request_digest,
            authorized_capabilities, budget_usd, spent_usd, max_attempts,
            kit_digest, sdk_version, model_id, base_plugin_install_id,
            plugin_package_id, plugin_version_id, plugin_install_id, failure,
            created_at, updated_at, finished_at
       from bakery.plugin_authoring_runs
      where organization_id = $1 and id = $2`,
    [organizationId, runId],
  );
  const run = runs.rows[0];
  if (run === undefined || run.actor_principal_id !== principalId) {
    throw new StandardError({
      code: "RESOURCE_NOT_FOUND",
      params: { reason: "plugin_authoring_run_not_found" },
    });
  }
  const attempts = await transaction.query<{
    attempt_number: number;
    outcome: string;
    files_digest: string | null;
    check_report: unknown;
    diagnostics: unknown;
    cost_usd: string;
    plugin_version_id: string | null;
    preview_result: unknown;
    created_at: Date | string;
  }>(
    `select attempt_number, outcome, files_digest, check_report, diagnostics,
            cost_usd, plugin_version_id, preview_result, created_at
       from bakery.plugin_authoring_attempts
      where organization_id = $1 and plugin_authoring_run_id = $2
      order by attempt_number`,
    [organizationId, runId],
  );
  const events = await transaction.query<{
    kind: string;
    detail: unknown;
    created_at: Date | string;
  }>(
    `select kind, detail, created_at
       from bakery.plugin_authoring_events
      where organization_id = $1 and plugin_authoring_run_id = $2
      order by created_at, id`,
    [organizationId, runId],
  );
  return {
    id: run.id,
    organizationId,
    actorPrincipalId: run.actor_principal_id,
    status: run.status as PluginAuthoringRun["status"],
    request: run.request_text,
    requestDigest: run.request_digest,
    authorizedCapabilities: run
      .authorized_capabilities as PluginAuthoringRun["authorizedCapabilities"],
    budgetUsd: decimal(run.budget_usd),
    spentUsd: decimal(run.spent_usd),
    maxAttempts: run.max_attempts,
    kitDigest: run.kit_digest,
    sdkVersion: run.sdk_version,
    modelId: run.model_id,
    basePluginInstallId: run.base_plugin_install_id,
    pluginPackageId: run.plugin_package_id,
    pluginVersionId: run.plugin_version_id,
    pluginInstallId: run.plugin_install_id,
    failure: (run.failure ?? null) as PluginAuthoringRun["failure"],
    attempts: attempts.rows.map((row) => ({
      attemptNumber: row.attempt_number,
      outcome: row.outcome as PluginAuthoringRun["attempts"][number]["outcome"],
      filesDigest: row.files_digest,
      checkReport: (row.check_report ?? null) as PluginAuthoringRun[
        "attempts"
      ][number]["checkReport"],
      diagnostics: row.diagnostics as PluginAuthoringRun[
        "attempts"
      ][number]["diagnostics"],
      costUsd: decimal(row.cost_usd),
      pluginVersionId: row.plugin_version_id,
      previewResult: (row.preview_result ?? null) as PluginAuthoringRun[
        "attempts"
      ][number]["previewResult"],
      createdAt: iso(row.created_at)!,
    })),
    events: events.rows.map((row) => ({
      kind: row.kind as PluginAuthoringRun["events"][number]["kind"],
      detail: row.detail as PluginAuthoringRun["events"][number]["detail"],
      createdAt: iso(row.created_at)!,
    })),
    createdAt: iso(run.created_at)!,
    updatedAt: iso(run.updated_at)!,
    finishedAt: iso(run.finished_at),
  };
}
