import type { Context } from "hono";
import { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { AuthVariables } from "../auth/middleware.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import { jsonResponse } from "./http.ts";
import { machineTransaction } from "./machines.ts";
import type { ExecutionRouteOptions } from "./shared.ts";

function parseQuery(context: Context<{ Variables: AuthVariables }>) {
  const search = new URL(context.req.url).searchParams;
  const single = (name: string) => {
    const values = search.getAll(name);
    if (values.length > 1) {
      throw new StandardError({ code: "MALFORMED_REQUEST" });
    }
    return values[0];
  };
  const limit = single("limit");
  const cursor = single("cursor");
  const parsed = contractSchemas.CursorQuery.safeParse({
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  });
  if (!parsed.success) throw new StandardError({ code: "MALFORMED_REQUEST" });
  return { cursor: parsed.data.cursor, limit: parsed.data.limit ?? 25 };
}

export async function listMachineModels(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "machines.models",
    async (transaction, organization, principal) => {
      const hosts = await transaction.query(
        `select 1 from bakery.worker_hosts
          where organization_id = $1 and id::text = $2`,
        [organization, workerHostId],
      );
      if (hosts.rows.length === 0) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const query = parseQuery(context);
      const binding: CursorBinding = {
        action: "machines.models",
        organizationId: organization,
        principalId: principal.principalId,
        ordering: "createdAt:desc,id:desc",
        filters: JSON.stringify({ workerHostId }),
        schemaVersion: 1,
      };
      const position = await decodeCursor(
        options.secret,
        query.cursor,
        binding,
      );
      const result = await transaction.query<{ row: unknown }>(
        `select jsonb_build_object(
           'id', route.id, 'provider', route.provider, 'model', route.model,
           'harness', route.harness, 'billingRoute', route.billing_route,
           'status', route.status, 'health', route.health,
           'inferenceVerifiedAt', to_char(
             route.inference_verified_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           'createdAt', to_char(route.created_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as row
         from bakery.provider_routes as route
         join bakery.worker_provider_bindings as binding
           on binding.organization_id = route.organization_id
          and binding.id = route.worker_binding_id
        where route.organization_id = $1 and binding.worker_host_id::text = $2
          and ($3::timestamptz is null
            or (route.created_at, route.id) < ($3::timestamptz, $4::uuid))
        order by route.created_at desc, route.id desc
        limit $5`,
        [
          organization,
          workerHostId,
          position?.createdAt ?? null,
          position?.id ?? null,
          query.limit + 1,
        ],
      );
      const rows = result.rows.map(({ row }) =>
        contractSchemas.MachineModel.parse(row)
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor = rows.length > query.limit && last
        ? await encodeCursor(options.secret, binding, {
          createdAt: last.createdAt,
          id: last.id,
        })
        : null;
      return jsonResponse(
        contractSchemas["Page<MachineModel>"].parse({ items, nextCursor }),
        200,
        false,
      );
    },
  );
}
