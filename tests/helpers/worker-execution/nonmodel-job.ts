import type { PgDatabase } from "../../../apps/server/src/platform/database.ts";
import { seedEligibleJob } from "../worker-execution.ts";

/** Fresh claimable lifecycle work with no model binding or funding requirement. */
export function seedEligibleNonmodelJob(
  database: PgDatabase,
  organizationId: string,
  principalId: string,
  options: {
    action?: "quality.check";
    priority?: number;
    input?: Record<string, unknown>;
  } = {},
) {
  return seedEligibleJob(database, organizationId, principalId, {
    action: "quality.check",
    priority: options.priority,
    input: options.input ?? {
      repositoryId: crypto.randomUUID(),
      revision: "fixture",
      checks: ["source.integrity"],
    },
  });
}
