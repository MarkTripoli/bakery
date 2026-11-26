import type { BudgetRuntimeConfig } from "@bakery/config";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  type EncodedSuccessResponse,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import {
  createNormalizedCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import {
  ACTOR_ROLE_RANK_ACT,
  TICKET_PREVIEW_ISSUE_LIMIT,
} from "@bakery/contracts/ticket-admission";
import {
  parsePreviewFilters,
  storedTicketSourcePolicy,
} from "./ticket-policy.ts";
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
  TicketActorRole,
  TicketFactIndex,
  TicketIssueListPage,
  TicketLabelPage,
  TicketReadFailure,
  TicketSourceHandle,
  TicketSourceReader,
} from "./ticket-source-reader.ts";
import { ticketRef } from "./ticket-source-reader.ts";
import { sourceWorkflowResolver } from "./ticket-workflow.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import {
  type CursorBinding,
  decodeSequenceCursor,
  encodeSequenceCursor,
} from "../../platform/cursor.ts";

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

/** Issues one preview reads and judges. */
export const PREVIEW_ISSUE_LIMIT = TICKET_PREVIEW_ISSUE_LIMIT;

export type TicketOperationDependencies = {
  reader: TicketSourceReader;
  factIndex: TicketFactIndex;
  /** Server budget policy; the fixed preset's availability reads it. */
  budget: BudgetRuntimeConfig | undefined;
};

/** What the runner itself needs besides the reads: the list cursor key. */
export type TicketRunnerDependencies = TicketOperationDependencies & {
  /** Signs the provider-page cursor of `ticketSources.labels`. */
  cursorSecret: string;
};

/** What the reads step hands the operation's transaction. */
export type TicketOperationReads =
  | {
    kind: "preview";
    /** Issue numbers of the page, in list order, each with its prefetch. */
    issues: ReadonlyMap<number, TicketPrefetch>;
  }
  | { kind: "sync"; issues: ReadonlyMap<number, TicketPrefetch> }
  | { kind: "ticket"; prefetch: TicketPrefetch }
  /** One username looked up on the source's repository (#69). */
  | { kind: "person"; login: string; role: TicketActorRole }
  /** One page of the source's provider labels (#69). */
  | { kind: "labels"; page: number; offset: number; answer: TicketLabelPage };

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

/** The operations that read GitHub. */
const READING_ACTIONS = Object.freeze(
  new Set<string>([
    "ticketSources.preview",
    "ticketSources.lookupPerson",
    "ticketSources.labels",
    "ticketSources.sync",
    "ticketReadiness.create",
    "ticketRequests.create",
  ]),
);

export function readsProvider(actionName: string): boolean {
  return READING_ACTIONS.has(actionName);
}

type ReadPlan =
  | { kind: "person"; handle: TicketSourceHandle; login: string }
  | { kind: "labels"; handle: TicketSourceHandle; page: number; offset: number }
  | {
    kind: "preview";
    handle: TicketSourceHandle;
    /** The draft policy when the input carries one, else the saved one; the prefetch reads for it. */
    policy: TicketSourcePolicy;
    /** Issue numbers to read instead of the provider's first page; null reads the page. */
    numbers: number[] | null;
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

/**
 * A provider login as the source's provider accepts it: letters, digits and
 * single hyphens, never at either end. The schema bounds its length (1-39);
 * anything else is refused before the provider is asked.
 */
const PROVIDER_LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/;

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
  dependencies: TicketRunnerDependencies,
): Promise<ReadPlan> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const fields = (input ?? {}) as Record<string, unknown>;
  if (actionName === "ticketSources.lookupPerson") {
    const login = String(fields.login);
    if (!PROVIDER_LOGIN.test(login)) {
      throw unprocessable(["login"], "login_invalid");
    }
    const { handle } = await readSourceHandle(transaction, organizationId, id);
    return { kind: "person", handle, login };
  }
  if (actionName === "ticketSources.labels") {
    const { handle } = await readSourceHandle(transaction, organizationId, id);
    const position = await decodeSequenceCursor(
      dependencies.cursorSecret,
      fields.cursor as string | undefined,
      labelsCursorBinding(context, id),
    );
    const at = position === null
      ? LABEL_CURSOR_PAGE
      : Number(position.sequence);
    return {
      kind: "labels",
      handle,
      page: Math.floor(at / LABEL_CURSOR_PAGE),
      offset: at % LABEL_CURSOR_PAGE,
    };
  }
  if (actionName === "ticketSources.preview") {
    // A refused filter or draft reads nothing. The handler parses both again
    // in its own transaction and checks the draft's delegation there.
    const filters = parsePreviewFilters(fields.filters);
    const { source, handle } = await readSourceHandle(
      transaction,
      organizationId,
      id,
    );
    const policy = fields.policy === undefined || fields.policy === null
      ? source.policy
      : await storedTicketSourcePolicy(
        fields.policy,
        source.policy,
        new Date(),
        sourceWorkflowResolver(transaction, organizationId, principalId),
      );
    return {
      kind: "preview",
      handle,
      policy,
      numbers: filters.numbers === undefined
        ? null
        : [...new Set(filters.numbers)],
    };
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
            {
              ref: ticketRef(number),
              policy: sourcePolicy,
              origin: "poll",
            },
            signal,
          ),
        ] as const,
    );
    return new Map<number, TicketPrefetch>(answers);
  };
  if (plan.kind === "person") {
    const role = await reader.readActorRole(plan.handle, plan.login, signal);
    if (role.kind === "unavailable") throw dependencyUnavailable(role);
    return { kind: "person", login: plan.login, role };
  }
  if (plan.kind === "labels") {
    const answer = await reader.readLabels(
      plan.handle,
      { page: plan.page },
      signal,
    );
    if (answer.kind === "unavailable") throw dependencyUnavailable(answer);
    return { kind: "labels", page: plan.page, offset: plan.offset, answer };
  }
  if (plan.kind === "sync") {
    return {
      kind: "sync",
      issues: await prefetchAll(plan.handle, plan.numbers, plan.source.policy),
    };
  }
  if (plan.kind === "preview") {
    let numbers = plan.numbers;
    if (numbers === null) {
      const page: TicketIssueListPage = await reader.listIssues(
        plan.handle,
        { page: 1, since: null },
        signal,
      );
      if (page.kind === "unavailable") throw dependencyUnavailable(page);
      numbers = page.numbers.slice(0, PREVIEW_ISSUE_LIMIT).map((item) =>
        item.number
      );
    }
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
      {
        ref: ticketRef(plan.number),
        policy: plan.policy,
        origin: plan.origin,
      },
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
  dependencies: TicketRunnerDependencies,
): ActionAuthorityRunner["run"] {
  return async (action, context, input, next) => {
    // A read (the person lookup) has no command receipt to replay.
    const metadata = action.policy.type === ActionKind.Command
      ? createNormalizedCommandMetadata(
        action,
        context.request,
        context.params,
        input,
      )
      : null;
    const probed = await authority.run(
      action,
      context,
      input,
      async (authorized) => {
        // The action's own guard runs before any read, as it does in `next`.
        await action.policy.authorize?.(authorized, input);
        const replay = metadata === null
          ? undefined
          : await readCompletedCommandReplay({
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

/**
 * `ticketSources.lookupPerson` (#69): Admin. A username on the source's
 * repository, read by the runner before this transaction: the provider's
 * numeric user id the trigger list stores, and whether the person may trigger
 * (write or admin). A username the provider does not know is 404.
 */
export function lookupTicketSourcePerson(context: ActionContext): {
  login: string;
  externalUserId: string;
  permission: "admin" | "write" | "read" | "none";
  canTrigger: boolean;
} {
  const { login, role } = ticketReads(context, "person");
  if (role.kind !== "present") {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return {
    login,
    externalUserId: role.userId,
    permission: role.permission,
    canTrigger: role.rank >= ACTOR_ROLE_RANK_ACT,
  };
}

/**
 * A labels cursor position is `page * LABEL_CURSOR_PAGE + offset`: the
 * provider page and how far into it the last answer reached, so a limit
 * smaller than the provider's page loses nothing. A provider page holds at
 * most 100 labels.
 */
const LABEL_CURSOR_PAGE = 1000;

/** The labels cursor names a provider page and is bound to the caller and the source. */
function labelsCursorBinding(
  context: ActionContext,
  sourceId: string,
): CursorBinding {
  const { organizationId, principalId } = requireWorkTransaction(context);
  return {
    action: "ticketSources.labels",
    principalId,
    organizationId,
    ordering: "providerPage:asc",
    filters: JSON.stringify({ sourceId }),
    schemaVersion: 1,
  };
}

/**
 * `ticketSources.labels` (#69): one page of the labels the source's provider
 * holds now, read by the runner before this transaction. The cursor names the
 * provider's next page. A provider without labels is 422 `labels_unsupported`;
 * an outage was already 503 in the read step.
 */
export function createTicketSourceLabelsHandler(secret: string) {
  return async (context: ActionContext, input: { limit?: number }) => {
    const { page, offset, answer } = ticketReads(context, "labels");
    if (answer.kind !== "present") {
      throw unprocessable(["id"], "labels_unsupported");
    }
    const end = offset + (input.limit ?? 100);
    // A page cut short by the limit continues inside the same provider page.
    const next = end < answer.labels.length
      ? page * LABEL_CURSOR_PAGE + end
      : answer.hasNext
      ? (page + 1) * LABEL_CURSOR_PAGE
      : null;
    return {
      items: answer.labels.slice(offset, end),
      nextCursor: next === null ? null : await encodeSequenceCursor(
        secret,
        labelsCursorBinding(context, context.params.id as string),
        { sequence: String(next) },
      ),
    };
  };
}
