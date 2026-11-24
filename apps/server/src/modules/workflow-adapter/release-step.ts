import type { PgTransactionClient } from "../../platform/database.ts";
import { buildWorkflowPlan } from "@bakery/contracts/workflow-compiler";
import type { WorkflowSemanticDocument } from "@bakery/contracts/workflow-compiler";

export type RunReleaseStep = "yes" | "no" | "unknown";

const MERGE_STEP = "delivery.merge";
const RELEASE_STEP = "delivery.deploy";

type JsonRecord = Record<string, unknown>;

const recordOf = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;

function planRunActions(frozen: JsonRecord): readonly string[] | null {
  const document = recordOf(recordOf(frozen.runtime)?.document);
  if (document === undefined) return null;
  try {
    return buildWorkflowPlan(document as unknown as WorkflowSemanticDocument)
      .steps.flatMap((step) =>
        typeof step.action === "string" && step.action.length > 0
          ? [step.action]
          : []
      );
  } catch {
    return null;
  }
}

function flatRunActions(frozen: JsonRecord): readonly string[] | null {
  const steps = recordOf(frozen.workflow)?.normalizedSpec;
  const list = recordOf(steps)?.steps;
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry) => {
    const uses = recordOf(entry)?.uses;
    return typeof uses === "string" && uses.length > 0 ? [uses] : [];
  });
}

export function releaseStepOf(snapshot: unknown): RunReleaseStep {
  const frozen = recordOf(snapshot);
  if (frozen === undefined) return "unknown";
  const actions = planRunActions(frozen) ?? flatRunActions(frozen);
  if (actions === null) return "unknown";
  const mergeAt = actions.indexOf(MERGE_STEP);
  if (mergeAt === -1) return "no";
  return actions.slice(mergeAt + 1).includes(RELEASE_STEP) ? "yes" : "no";
}

export async function readRunReleaseStep(
  transaction: Pick<PgTransactionClient, "query">,
  input: Readonly<{ organizationId: string; runId: string }>,
): Promise<RunReleaseStep> {
  const row = (await transaction.query<{ snapshot: unknown }>(
    `select snapshot from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [input.organizationId, input.runId],
  )).rows[0];
  return releaseStepOf(row?.snapshot);
}
