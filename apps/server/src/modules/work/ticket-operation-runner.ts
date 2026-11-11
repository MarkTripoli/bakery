import type { BudgetRuntimeConfig } from "@bakery/config";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  type EncodedSuccessResponse,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import {
  createNormalizedCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import type {
  TicketRequestOrigin,
  TicketSourcePolicy,
} from "@bakery/contracts/ticket-admission";
import { readCompletedCommandReplay } from "../../platform/command-replay.ts";
import {
  mapPool,
  prefetchTicketReads,
  type TicketPrefetch,
} from "./ticket-prefetch.ts";
import {
  selectSyncCandidates,
  SYNC_OPERATION_LIMIT,
  SYNC_PREFETCH_PARALLELISM,
} from "./ticket-sync.ts";
import {
  readSourceHandle,
  readTicketRef,
  type TicketSource,
} from "./ticket-store.ts";
import type {
  TicketFactIndex,
  TicketIssueListPage,
  TicketReadFailure,
  TicketSourceHandle,
  TicketSourceReader,
} from "./ticket-source-reader.ts";
import { requireWorkTransaction } from "./work-transaction.ts";

/**
 * Probe, read, execute: the wrapper that keeps GitHub reads out of registry
 * transactions (`createResourceUpdateRunner` is the model).
 *
 * 1. A short transaction under the live authority check answers a completed
 *    `Idempotency-Key` replay from its stored response, refuses an unknown id
 *    (404), a stale policy revision or requirements digest (412) and a
 *    request the operation cannot take (409 or 422), loads the source handle
 *    and, for sync, selects the candidates. Then it commits.
 * 2. With no transaction open, the reads run (five at a time, inside the
 *    router's deadline).
 * 3. A second transaction under the same authority check runs the operation
 *    with the answers in a closure slot and `readsAllowed: false`: admission
 *    re-verifies the source authority, the provider marker and the actor
 *    under its locks, and any attempt to read inside it throws
 *    `TICKET_PREFETCH_REQUIRED`.
 *
 * A provider failure about one issue is an answer inside its `TicketPrefetch`,
 * never a throw: the handler decides what it means for that issue.
 */

/** Issues one preview reads and records. */
export const PREVIEW_ISSUE_LIMIT = 25;

export type TicketOperationDependencies = {
  reader: TicketSourceReader;
  factIndex: TicketFactIndex;
  /** Server budget policy; the fixed preset's availability reads it. */
  budget: BudgetRuntimeConfig | undefined;
};

/** What the reads step hands the operation's transaction. */
export type TicketOperationReads =
  | {
    kind: "preview";
    /** Issue numbers of the page, in list order, each with its prefetch. */
    issues: ReadonlyMap<number, TicketPrefetch>;
  }
  | { kind: "sync"; issues: ReadonlyMap<number, TicketPrefetch> }
  | { kind: "ticket"; prefetch: TicketPrefetch };

const readsSlot = Symbol("bakery.ticket.operation.reads");

/** The answers the runner read for this operation; a handler outside the runner has none. */
export function ticketReads<Kind extends TicketOperationReads["kind"]>(
  context: ActionContext,
  kind: Kind,
): Extract<TicketOperationReads, { kind: Kind }> {
  const reads = (context as { [readsSlot]?: TicketOperationReads })[readsSlot];
  if (reads?.kind !== kind) throw new StandardError({ code: "INTERNAL" });
  return reads as Extract<TicketOperationReads, { kind: Kind }>;
}

/** The four operations that read GitHub. */
const READING_ACTIONS = Object.freeze(
  new Set<string>([
    "ticketSources.preview",
    "ticketSources.sync",
    "ticketReadiness.create",
    "ticketRequests.create",
  ]),
);

export function readsProvider(actionName: string): boolean {
  return READING_ACTIONS.has(actionName);
}

type ReadPlan =
  | {
    kind: "preview";
    handle: TicketSourceHandle;
    policy: TicketSourcePolicy;
  }
  | {
    kind: "sync";
    handle: TicketSourceHandle;
    source: TicketSource;
    numbers: number[];
  }
  | {
    kind: "ticket";
    handle: TicketSourceHandle;
    policy: TicketSourcePolicy;
    number: number;
    /** The origin the answers are read for: readiness is judged as a poll would, a request as its caller. */
    origin: TicketRequestOrigin;
  };

function isEmptyObject(value: unknown): boolean {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.keys(value).length === 0;
}

export function preconditionFailed(reason: string): StandardError {
  return new StandardError({
    code: "PRECONDITION_FAILED",
    params: { reason },
  });
}

/** Everything the operation can refuse before any provider read, from one short transaction. */
async function probe(
  actionName: string,
  context: ActionContext,
  input: unknown,
  dependencies: TicketOperationDependencies,
): Promise<ReadPlan> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const fields = (input ?? {}) as Record<string, unknown>;
  if (actionName === "ticketSources.preview") {
    if (fields.filters !== undefined && !isEmptyObject(fields.filters)) {
      throw unprocessable(["filters"], "filters_unsupported");
    }
    const { source, handle } = await readSourceHandle(
      transaction,
      organizationId,
      id,
    );
    return { kind: "preview", handle, policy: source.policy };
  }
  if (actionName === "ticketSources.sync") {
    const selection = await selectSyncCandidates(
      transaction,
      dependencies,
      { organizationId, sourceId: id, limit: SYNC_OPERATION_LIMIT },
    );
    if (!selection.source.enabled) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "source_disabled" },
      });
    }
    const waiting = selection.source.syncCheckpoint.notBefore;
    return {
      kind: "sync",
      handle: selection.handle,
      source: selection.source,
      // A source waiting out a rate limit reads nothing; the step says so.
      numbers: waiting !== null && Date.parse(waiting) > Date.now()
        ? []
        : selection.candidates.map((candidate) => candidate.number),
    };
  }
  // Readiness and request operations name a ticket; its source holds the policy.
  const ref = await readTicketRef(transaction, organizationId, id);
  const { source, handle } = await readSourceHandle(
    transaction,
    organizationId,
    ref.sourceId,
  );
  if (fields.expectedSourcePolicyRevision !== source.policyRevision) {
    throw preconditionFailed("source_policy_changed");
  }
  if (typeof fields.requirementsDigest === "string") {
    const stored = await transaction.query<{ requirements_digest: string }>(
      `select requirements_digest from bakery.external_tickets
        where organization_id = $1 and id = $2`,
      [organizationId, id],
    );
    if (stored.rows[0]?.requirements_digest !== fields.requirementsDigest) {
      throw preconditionFailed("requirements_changed");
    }
  }
  if (ref.number === null) {
    throw unprocessable(["id"], "ticket_number_missing");
  }
  return {
    kind: "ticket",
    handle,
    policy: source.policy,
    number: ref.number,
    origin: actionName === "ticketReadiness.create" ? "poll" : "manual",
  };
}

/** The provider reads of one operation, with no transaction open. */
async function readProvider(
  dependencies: TicketOperationDependencies,
  plan: ReadPlan,
  signal: AbortSignal,
): Promise<TicketOperationReads> {
  const { reader } = dependencies;
  const prefetchAll = async (
    handle: TicketSourceHandle,
    numbers: readonly number[],
    sourcePolicy: TicketSourcePolicy,
  ) => {
    const answers = await mapPool(
      numbers,
      SYNC_PREFETCH_PARALLELISM,
      async (number) =>
        [
          number,
          await prefetchTicketReads(
            reader,
            handle,
            { number, policy: sourcePolicy, origin: "poll" },
            signal,
          ),
        ] as const,
    );
    return new Map<number, TicketPrefetch>(answers);
  };
  if (plan.kind === "sync") {
    return {
      kind: "sync",
      issues: await prefetchAll(plan.handle, plan.numbers, plan.source.policy),
    };
  }
  if (plan.kind === "preview") {
    const page: TicketIssueListPage = await reader.listIssues(
      plan.handle,
      { page: 1, since: null },
      signal,
    );
    if (page.kind === "unavailable") throw dependencyUnavailable(page);
    const numbers = page.numbers.slice(0, PREVIEW_ISSUE_LIMIT).map((item) =>
      item.number
    );
    return {
      kind: "preview",
      issues: await prefetchAll(plan.handle, numbers, plan.policy),
    };
  }
  return {
    kind: "ticket",
    prefetch: await prefetchTicketReads(
      reader,
      plan.handle,
      { number: plan.number, policy: plan.policy, origin: plan.origin },
      signal,
    ),
  };
}

/** The provider could not answer at all; the caller may retry after the wait it gave. */
export function dependencyUnavailable(
  failure: Pick<TicketReadFailure, "retryAfterSeconds">,
): StandardError {
  const seconds = failure.retryAfterSeconds;
  return new StandardError({
    code: "DEPENDENCY_UNAVAILABLE",
    params: seconds === null ? {} : {
      retryAfterSeconds: Math.min(3600, Math.max(1, seconds)),
    },
  });
}

export function createTicketOperationRunner(
  authority: ActionAuthorityRunner,
  dependencies: TicketOperationDependencies,
): ActionAuthorityRunner["run"] {
  return async (action, context, input, next) => {
    const metadata = createNormalizedCommandMetadata(
      action,
      context.request,
      context.params,
      input,
    );
    const probed = await authority.run(
      action,
      context,
      input,
      async (authorized) => {
        // The action's own guard runs before any read, as it does in `next`.
        await action.policy.authorize?.(authorized, input);
        const replay = await readCompletedCommandReplay({
          context: authorized,
          metadata,
          input,
        });
        if (replay) {
          return { replay: validateEncodedSuccessResponse(action, replay) };
        }
        return {
          plan: await probe(action.name, authorized, input, dependencies),
        };
      },
    ) as { replay: EncodedSuccessResponse } | { plan: ReadPlan };
    if ("replay" in probed) return probed.replay;
    context.signal.throwIfAborted();
    const reads = await readProvider(dependencies, probed.plan, context.signal);
    return await authority.run(
      action,
      context,
      input,
      (authorized) =>
        next(Object.assign({}, authorized, { [readsSlot]: reads })),
    );
  };
}
