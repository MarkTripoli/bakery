import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { BatchImplementedAction } from "@bakery/contracts/implemented-actions";
import { StandardError } from "@bakery/contracts/http";
import {
  FIXED_CODING_PRESET,
  type WorkflowPresetDefinition,
} from "@bakery/contracts/workflow-presets";
import type { BudgetRuntimeConfig } from "@bakery/config";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { presetAvailability } from "./workflow-presets.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * What a batch would take in a repository, read-only (#58).
 *
 * The list is the open issues of the repository's enabled sources whose last stored
 * readiness check passes everything a batch needs, in the order the supervisor takes
 * them: lowest issue number first. A batch starts an issue as an explicit manual request,
 * so the two checks that decide how an automatic request is authorized do not count: the
 * request label (`intent_authorized`) and who applied it (`authority_live`). An issue that
 * only lacks the request label can still be started, and admission re-checks the starter's
 * authority live. No provider is read here; a batch reads GitHub again
 * before it starts each issue, so the list is a forecast and carries when it was checked.
 */

type Startable = z.output<typeof contractSchemas.BatchStartable>;
type StartableQuery = z.output<typeof contractSchemas.BatchStartableQuery>;

type Row = {
  id: string;
  number: number;
  title: string | null;
  safe_url: string | null;
  checked_at: string;
};

/**
 * The least a spend limit can be and still start one issue: the reservation of one
 * mandatory path plus one repair cycle, from the same call admission's preset check makes.
 * Null when the repository cannot run work now, so no amount would start one.
 */
export async function smallestBatchSpend(
  transaction: PgTransactionClient,
  organizationId: string,
  repositoryId: string,
  budget: BudgetRuntimeConfig | undefined,
  preset: WorkflowPresetDefinition = FIXED_CODING_PRESET,
): Promise<string | null> {
  const availability = await presetAvailability(
    transaction,
    organizationId,
    repositoryId,
    preset,
    preset.defaultBudgetLimitUsd,
    budget,
  );
  return availability.minimumBudgetLimitUsd ?? null;
}

/** `batches.startable`. */
export function createBatchStartableHandler(
  dependencies: {
    cursorSecret: string;
    budget: BudgetRuntimeConfig | undefined;
  },
) {
  return async (
    context: ActionContext,
    input: StartableQuery,
  ): Promise<Startable> => {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const repository = await transaction.query(
      `select 1 from bakery.repositories
        where organization_id = $1 and id = $2`,
      [organizationId, input.repositoryId],
    );
    if (repository.rows.length === 0) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
    const binding: CursorBinding = {
      action: BatchImplementedAction.BatchesStartable,
      organizationId,
      principalId,
      ordering: "position:asc,iteration:asc,id:asc",
      filters: JSON.stringify({ repositoryId: input.repositoryId }),
      schemaVersion: 1,
    };
    const position = await decodeCursor(
      dependencies.cursorSecret,
      input.cursor,
      binding,
    );
    const limit = input.limit ?? 25;
    const rows = (await transaction.query<Row>(
      `select ticket.id, ticket.number::int as number,
              ticket.snapshot ->> 'title' as title, ticket.safe_url,
              to_char(report.evaluated_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as checked_at
         from bakery.external_tickets as ticket
         join bakery.ticket_sources as source
           on source.organization_id = ticket.organization_id
          and source.id = ticket.ticket_source_id
         join lateral (
           select latest.evaluated_at, latest.checks
             from bakery.ticket_readiness_reports as latest
            where latest.organization_id = ticket.organization_id
              and latest.external_ticket_id = ticket.id
            order by latest.version desc
            limit 1
         ) as report on true
        where ticket.organization_id = $1 and source.repository_id = $2
          and source.enabled and ticket.state = 'open'
          and ticket.number ~ '^[0-9]+$'
          and not exists (
            select 1 from jsonb_array_elements(report.checks) as pass_check
             where pass_check ->> 'status' <> 'pass'
               and pass_check ->> 'id' not in ('intent_authorized', 'authority_live')
          )
          and not exists (
            select 1 from bakery.ticket_requests as open_request
             where open_request.organization_id = ticket.organization_id
               and open_request.external_ticket_id = ticket.id
               and open_request.disposition
                 in ('waiting', 'admitted', 'active', 'suspended')
          )
          and ($3::int is null
               or (ticket.number::int, ticket.id) > ($3::int, $4::uuid))
        order by ticket.number::int asc, ticket.id asc
        limit $5`,
      [
        organizationId,
        input.repositoryId,
        position?.position ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    )).rows;
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => ({
        externalTicketId: row.id,
        number: String(row.number),
        title: row.title,
        url: row.safe_url,
        checkedAt: row.checked_at,
      })),
      nextCursor: rows.length > limit && last
        ? await encodeCursor(dependencies.cursorSecret, binding, {
          position: last.number,
          iteration: 0,
          id: last.id,
        })
        : null,
      smallestSpendUsd: await smallestBatchSpend(
        transaction,
        organizationId,
        input.repositoryId,
        dependencies.budget,
      ),
    } as Startable;
  };
}
