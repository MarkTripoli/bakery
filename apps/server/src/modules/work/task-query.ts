import type { ActionContext } from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { accessScopeClause } from "../auth/application/bindings.ts";
import { TASK_COLUMNS, type TaskRow, toTask } from "./postgres.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

const TASK_ORDERING = "createdAt:desc,id:desc";

function escapeIlikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll(
    "_",
    "\\_",
  );
}

type TaskCursorQuery = z.output<typeof contractSchemas.TaskCursorQuery>;

type KeysetTaskRow = TaskRow & { cursor_created_at: string };

function taskBinding(
  organizationId: string,
  principalId: string,
  filters: Pick<TaskCursorQuery, "status" | "repositoryId" | "search">,
): CursorBinding {
  return {
    action: "tasks.list",
    principalId,
    organizationId,
    ordering: TASK_ORDERING,
    filters: JSON.stringify(filters),
    schemaVersion: 1,
  };
}

export function createTaskQueryHandlers(secret: string) {
  return {
    async list(context: ActionContext, input: unknown) {
      const { transaction, organizationId, principalId, accessScope } =
        requireWorkTransaction(context);
      const query = input as TaskCursorQuery;
      const filters = {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.repositoryId === undefined
          ? {}
          : { repositoryId: query.repositoryId }),
        ...(query.search === undefined ? {} : { search: query.search }),
      };
      const binding = taskBinding(organizationId, principalId, filters);
      const position = await decodeCursor(secret, query.cursor, binding);
      const limit = query.limit ?? 25;
      const values: unknown[] = [organizationId];
      const where = ["organization_id = $1"];
      const add = (clause: string, value: unknown) => {
        values.push(value);
        where.push(clause.replace("?", `$${values.length}`));
      };
      if (accessScope !== undefined) {
        // Listing through resource bindings: only tasks they reach.
        const scoped = accessScopeClause(
          accessScope,
          { application: "application_id", repository: "repository_id" },
          values.length + 1,
        );
        values.push(...scoped.values);
        where.push(scoped.sql);
      }
      if (query.status !== undefined) add("status = ?", query.status);
      if (query.repositoryId !== undefined) {
        add("repository_id = ?::uuid", query.repositoryId);
      }
      if (query.search !== undefined) {
        const searchPattern = escapeIlikePattern(query.search);
        values.push(searchPattern, searchPattern);
        const first = values.length - 1;
        const second = values.length;
        where.push(
          `(title ilike '%' || $${first} || '%' escape E'\\\\' or description ilike '%' || $${second} || '%' escape E'\\\\')`,
        );
      }
      values.push(position?.createdAt ?? null, position?.id ?? null);
      where.push(
        `($${values.length - 1}::timestamptz is null or (created_at, id) < ($${
          values.length - 1
        }, $${values.length}::uuid))`,
      );
      values.push(limit + 1);
      const result = await transaction.query<KeysetTaskRow>(
        `select ${TASK_COLUMNS},
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_created_at
         from bakery.tasks
         where ${where.join("\n           and ")}
         order by created_at desc, id desc
         limit $${values.length}`,
        values,
      );
      const visible = result.rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        items: visible.map(toTask),
        nextCursor: result.rows.length > limit && last
          ? await encodeCursor(secret, binding, {
            createdAt: last.cursor_created_at,
            id: last.id,
          })
          : null,
      };
    },

    async get(context: ActionContext) {
      const { transaction, organizationId } = requireWorkTransaction(context);
      const taskId = context.params.id;
      if (!taskId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const result = await transaction.query<TaskRow>(
        `select ${TASK_COLUMNS}
         from bakery.tasks
         where organization_id = $1 and id = $2`,
        [organizationId, taskId],
      );
      const row = result.rows[0];
      if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      return toTask(row);
    },
  };
}
