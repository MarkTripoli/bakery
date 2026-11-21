export { createTaskCommand, updateTaskCommand } from "./postgres.ts";
export { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
export { workBakeryMigrationSource } from "./migrations.ts";
export { createTicketRoutes } from "./ticket-routes.ts";
export { createGroupRoutes } from "./group-routes.ts";
export { createNotificationRoutes } from "./notification-routes.ts";
export { createRunRequestRoutes } from "./run-request-routes.ts";
export { registerNotificationProjection } from "./notification-projection.ts";

import { createTaskCommand, updateTaskCommand } from "./postgres.ts";
import { createRunCommand } from "./run-command.ts";
import { withAgentSpawnChecks, withAgentTaskChecks } from "./agent-spawn.ts";
import { DEFAULT_AGENT_SPAWN } from "@bakery/config";
import {
  createTaskDependencyCommand,
  deleteTaskDependencyCommand,
} from "./dependency-command.ts";
import { createTaskQueryHandlers } from "./task-query.ts";
import { createRunQueryHandlers } from "./run-query.ts";
import { createSyncQueryHandler } from "./sync-query.ts";
import { createUsageQueryHandlers } from "./usage.ts";
import { createWorkflowPresetHandlers } from "./workflow-presets.ts";
import type { AgentSpawnConfig, BudgetRuntimeConfig } from "@bakery/config";
export function createWorkTaskHandlers(
  secret: string,
  options: { budget?: BudgetRuntimeConfig; agentSpawn?: AgentSpawnConfig } = {},
) {
  return {
    ...createWorkflowPresetHandlers(options),
    ...createTaskQueryHandlers(secret),
    ...createRunQueryHandlers(secret),
    ...createUsageQueryHandlers(),
    create: withAgentTaskChecks(createTaskCommand),
    update: updateTaskCommand,
    createDependency: createTaskDependencyCommand,
    deleteDependency: deleteTaskDependencyCommand,
    runsCreate: withAgentSpawnChecks(
      createRunCommand,
      options.agentSpawn ?? DEFAULT_AGENT_SPAWN,
    ),
    sync: createSyncQueryHandler(secret),
  };
}
