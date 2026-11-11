export { createTaskCommand, updateTaskCommand } from "./postgres.ts";
export { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
export { workBakeryMigrationSource } from "./migrations.ts";
export { createTicketRoutes } from "./ticket-routes.ts";

import { createTaskCommand, updateTaskCommand } from "./postgres.ts";
import { createRunCommand } from "./run-command.ts";
import {
  createTaskDependencyCommand,
  deleteTaskDependencyCommand,
} from "./dependency-command.ts";
import { createTaskQueryHandlers } from "./task-query.ts";
import { createRunQueryHandlers } from "./run-query.ts";
import { createSyncQueryHandler } from "./sync-query.ts";
import { createUsageQueryHandlers } from "./usage.ts";
import { createWorkflowPresetHandlers } from "./workflow-presets.ts";
import type { BudgetRuntimeConfig } from "@bakery/config";
export function createWorkTaskHandlers(
  secret: string,
  options: { budget?: BudgetRuntimeConfig } = {},
) {
  return {
    ...createWorkflowPresetHandlers(options),
    ...createTaskQueryHandlers(secret),
    ...createRunQueryHandlers(secret),
    ...createUsageQueryHandlers(),
    create: createTaskCommand,
    update: updateTaskCommand,
    createDependency: createTaskDependencyCommand,
    deleteDependency: deleteTaskDependencyCommand,
    runsCreate: createRunCommand,
    sync: createSyncQueryHandler(secret),
  };
}
