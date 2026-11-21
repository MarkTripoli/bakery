import { Hono, type MiddlewareHandler } from "hono";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  type CommandRunner,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  createApiRouter,
  parseIdempotencyKey,
  parseStrongIfMatch,
  StandardError,
} from "@bakery/contracts/http";
import {
  assertImplementedActionRegistry,
  DraftImplementedAction,
  draftImplementedActions,
} from "@bakery/contracts/implemented-actions";
import type { z } from "zod";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import { auditAgentSessionId } from "../auth/application/agent-power-grants.ts";
import type { ActionAttribution } from "../auth/application/action-attribution.ts";
import type {
  AuthorizedActionContext,
  OrganizationActor,
} from "../auth/application/authority.ts";
import { authorize } from "../auth/application/authorize.ts";
import type { CollaborationRegistry } from "./collaboration-socket.ts";
import {
  commitDraftSuggestion,
  commitSuggestionAcceptance,
  commitSuggestionRefusal,
  commitSuggestionRejection,
  type DraftSuggestionCreateInput,
  type DraftSuggestionRead,
  listDraftSuggestions,
  lockSuggestionAcceptance,
  prepareDraftSuggestion,
  prepareSuggestionDecision,
} from "./draft-suggestions.ts";
import {
  commitDraftCommentRoot,
  draftEpoch,
  type PreparedDraftCommentPage,
  type PreparedDraftCommentRoot,
  prepareDraftComment,
  prepareDraftCommentPage,
  resolvedDraftCommentPage,
  updateDraftComment,
} from "./draft-comments.ts";
import {
  type PreparedThreadProjection,
  prepareThreadProjection,
  type ResolvedThreadProjection,
} from "./draft-comment-projection.ts";
import {
  createDraftReference,
  readDraftReference,
} from "./draft-references.ts";
import {
  draftCheckpointPublished,
  type DraftPublicationRecord,
  freezeTextDraftCheckpoint,
  publishFrozenDraft,
  readDraftPublication,
} from "./draft-publication.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import type { PgDatabase } from "../../platform/database.ts";
import {
  createDraftIsolation,
  type DraftIsolation,
  DraftIsolationError,
  type IsolatedDraftSlice,
  workerRefusalParams,
} from "./draft-isolation.ts";
import {
  commitDraftEdit,
  commitDraftOpen,
  commitDraftRollover,
  type DraftEditInput,
  type DraftEditRefusalReason,
  DraftPreparationComplete,
  type DraftRead,
  type DraftReceipt,
  type PreparedDraftEdit,
  type PreparedDraftOpen,
  type PreparedDraftRollover,
  type PreparedDraftSlice,
  prepareDraftEdit,
  prepareDraftOpen,
  prepareDraftRollover,
  prepareDraftSlice,
  readDraft,
  readDraftCheckpoint,
  refusedDraftEdit,
  StaleDraftCandidateError,
} from "./draft-persistence.ts";
import {
  DRAFT_LIMITS,
  type DraftAnchorPosition,
  type DraftCandidate,
} from "./drafts.ts";
import type { OrganizationBlobStore } from "../catalog/storage-port.ts";

export type DraftResourceRouteOptions = {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  isolation?: DraftIsolation;
  /**
   * Secret the keyset cursors are signed with, so a cursor cannot be edited
   * into another listing's position.
   */
  cursorSecret: string;
  /** Collaboration rooms told about each committed publication and suggestion. */
  collaboration?: Pick<
    CollaborationRegistry,
    "notifyDraftPublished" | "notifyDraftSuggestion"
  >;
  /**
   * Where a published version's bytes go. Present, published versions name a
   * blob; absent, they store their bytes inline. Absent is the honest default
   * for a composition that has no store, and the read path serves both.
   */
  blobStore?: OrganizationBlobStore;
};

/** Publication committed by this request, pushed to editors after commit. */
const committedPublication: unique symbol = Symbol("committed-publication");
type PublicationHolder = {
  organizationId?: string;
  publication?: DraftPublicationRecord;
  replayed?: boolean;
};
type PublicationActionContext = ActionContext & {
  [committedPublication]?: PublicationHolder;
};

/**
 * Whether the authorized caller may publish: the same artifactVersion:write
 * check (role, custom role, grant and token scope) draftPublications.create
 * runs, so the UI can hide Publish instead of failing on press.
 */
function mayPublish(context: ActionContext): boolean {
  const actor = (context as Partial<AuthorizedActionContext>).authority;
  if (!actor || !("organizationId" in actor)) return false;
  try {
    authorize(actor as OrganizationActor, "artifactVersion:write", {
      action: DraftImplementedAction.PublicationCreate,
    });
    return true;
  } catch (error) {
    if (error instanceof StandardError) return false;
    throw error;
  }
}

function withCapabilities(context: ActionContext, draft: DraftRead) {
  return contractSchemas.Draft.parse({
    ...draft,
    canPublish: mayPublish(context),
  });
}

type DraftSliceInput = z.output<typeof contractSchemas.DraftSliceQuery>;

type DraftExecutionStage = {
  /** The organization preparation authorized: what the worker pool counts. */
  organizationId?: string;
  open?: PreparedDraftOpen;
  rollover?: PreparedDraftRollover;
  edit?: PreparedDraftEdit;
  slice?: PreparedDraftSlice;
  candidate?: DraftCandidate;
  sliceCandidate?: IsolatedDraftSlice;
  /** The accepted suggestion whose edit this stage is applying (#71). */
  decision?: { suggestionId: string; input: DraftEditInput };
  /**
   * Why an acceptance could not apply (#71). Set after the worker refused the
   * anchored edit, so the next pass records `no_longer_fits` instead of
   * failing the call: nothing was applied and the list must say so.
   */
  refusal?: DraftEditRefusalReason;
  /** A new draft comment root whose anchor the worker verifies (#28). */
  commentRoot?: PreparedDraftCommentRoot;
  commentPosition?: readonly [number, number];
  /** A draft comment page whose root anchors the worker resolves (#28). */
  commentPage?: PreparedDraftCommentPage;
  commentPositions?: DraftAnchorPosition[];
  /** Draft threads a publication projects, resolved at its cutoff (#28). */
  projection?: PreparedThreadProjection;
  projectionPositions?: DraftAnchorPosition[];
};

const draftExecutionStage: unique symbol = Symbol("draft-execution-stage");
type StagedActionContext = ActionContext & {
  [draftExecutionStage]?: DraftExecutionStage;
};

/** Suggestion change committed by this request, pushed to editors after commit. */
const committedSuggestion: unique symbol = Symbol("committed-suggestion");
type SuggestionHolder = {
  organizationId?: string;
  suggestion?: DraftSuggestionRead;
  replayed?: boolean;
};
type SuggestionActionContext = ActionContext & {
  [committedSuggestion]?: SuggestionHolder;
};

class DraftAdmission {
  readonly #active = new Map<string, number>();

  acquire(draftId: string): () => void {
    const count = this.#active.get(draftId) ?? 0;
    if (count >= DRAFT_LIMITS.queuedMutations) {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    this.#active.set(draftId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#active.get(draftId) ?? 1) - 1;
      if (remaining === 0) this.#active.delete(draftId);
      else this.#active.set(draftId, remaining);
    };
  }
}

/**
 * Remembers a committed suggestion change so the collaboration room is told
 * after the transaction commits. A replayed answer records nothing new and is
 * not announced again.
 */
function announceSuggestion(
  context: ActionContext,
  organizationId: string,
  suggestion: DraftSuggestionRead,
  replayed = false,
): void {
  const holder = (context as SuggestionActionContext)[committedSuggestion];
  if (!holder) return;
  holder.organizationId = organizationId;
  holder.suggestion = suggestion;
  holder.replayed = replayed;
}

function draftId(context: ActionContext): string {
  const id = context.params.id;
  if (!id) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return id;
}

function mapIsolationError(error: unknown): never {
  if (!(error instanceof DraftIsolationError)) throw error;
  switch (error.kind) {
    case "precondition":
      throw new StandardError({ code: "PRECONDITION_FAILED", cause: error });
    case "unprocessable":
    case "limit":
      throw new StandardError({ code: "UNPROCESSABLE", cause: error });
    case "timeout":
      throw new StandardError({ code: "DEPENDENCY_TIMEOUT", cause: error });
    case "unavailable":
      throw new StandardError({
        code: "DEPENDENCY_UNAVAILABLE",
        cause: error,
        ...workerRefusalParams(error),
      });
  }
}

/**
 * The threads a publication projects (#28). The first pass loads the named
 * roots and stops so the worker can resolve their anchors at the cutoff; the
 * second pass reloads them (a thread resolved meanwhile is refused) and
 * carries the resolved positions. A checkpoint already published is a replay
 * and projects nothing again.
 */
async function threadProjection(
  context: StagedActionContext,
  organizationId: string,
  id: string,
  checkpointId: string,
  rootIds: readonly string[],
): Promise<ResolvedThreadProjection | undefined> {
  if (rootIds.length === 0) return undefined;
  const { transaction } = requireWorkTransaction(context);
  if (
    await draftCheckpointPublished(
      transaction,
      organizationId,
      id,
      checkpointId,
    )
  ) return undefined;
  const stage = context[draftExecutionStage];
  if (!stage) throw new Error("DRAFT_STAGE_MISSING");
  const prepared = await prepareThreadProjection(
    transaction,
    organizationId,
    id,
    checkpointId,
    rootIds,
  );
  if (!stage.projectionPositions) {
    stage.projection = prepared;
    stage.organizationId = organizationId;
    throw new DraftPreparationComplete();
  }
  if (
    JSON.stringify(stage.projection?.anchors) !==
      JSON.stringify(prepared.anchors)
  ) throw new StandardError({ code: "PRECONDITION_FAILED" });
  return { ...prepared, positions: stage.projectionPositions };
}

function isStagedAction(name: string): boolean {
  return name === DraftImplementedAction.Open ||
    name === DraftImplementedAction.Rollover ||
    name === DraftImplementedAction.Edit ||
    name === DraftImplementedAction.Slice ||
    name === DraftImplementedAction.SuggestionCreate ||
    name === DraftImplementedAction.SuggestionAccept ||
    name === DraftImplementedAction.CommentCreate ||
    name === DraftImplementedAction.CommentList;
}

/**
 * The named refusal a strict anchor resolution failure means for a new draft
 * comment (#28): its quote no longer matches the text between the cursors, a
 * cursor offset would split a UTF-16 surrogate pair, or the cursors no longer
 * resolve to a non-empty range in the current draft.
 */
function refusedCommentAnchor(error: unknown): never {
  if (
    !(error instanceof DraftIsolationError) || error.kind !== "precondition"
  ) {
    throw error;
  }
  const reason = error.message === "COMMENT_QUOTE_MISMATCH"
    ? "comment_quote_mismatch"
    : error.message === "UTF16_SURROGATE_SPLIT"
    ? "comment_anchor_splits_character"
    : "comment_anchor_stale";
  throw new StandardError({
    code: "PRECONDITION_FAILED",
    params: { reason },
    cause: error,
  });
}

/**
 * The refusal a `precondition` worker failure means for a suggestion: its
 * anchored range no longer resolves to the text it claims to replace.
 */
function isolationRefusal(
  error: unknown,
): DraftEditRefusalReason | null {
  return error instanceof DraftIsolationError && error.kind === "precondition"
    ? "text_changed"
    : null;
}

/**
 * A suggestion is proposed by anyone with draft:write, but only a person
 * decides one (chapter 25, O50 and O52: an agent never accepts its own work).
 */
function assertPersonDecides(attribution: ActionAttribution): void {
  if (attribution.actorKind === "person") return;
  throw new StandardError({
    code: "AUTH_FORBIDDEN",
    params: { reason: "suggestion_decision_requires_person" },
  });
}

const directCommandRunner: CommandRunner = {
  run: async (request) => await request.invokeAndEncode(),
};

export function createDraftResourceRoutes(
  options: DraftResourceRouteOptions,
) {
  const isolation = options.isolation ?? createDraftIsolation();
  const postgresAuthority = new PostgresAuthorityRunner(options.database);
  const admission = new DraftAdmission();

  const runAction = async (
    action: Parameters<ActionAuthorityRunner["run"]>[0],
    context: Parameters<ActionAuthorityRunner["run"]>[1],
    input: Parameters<ActionAuthorityRunner["run"]>[2],
    next: Parameters<ActionAuthorityRunner["run"]>[3],
  ) => {
    if (action.name === DraftImplementedAction.PublicationCreate) {
      const holder: PublicationHolder = {};
      const stage: DraftExecutionStage = {};
      const publishOnce = () =>
        postgresAuthority.run(
          action,
          Object.assign({}, context, {
            [committedPublication]: holder,
            [draftExecutionStage]: stage,
          }),
          input,
          next,
        );
      let result;
      try {
        result = await publishOnce();
      } catch (error) {
        if (!(error instanceof DraftPreparationComplete)) throw error;
        // Projected threads: their anchors are resolved against the frozen
        // checkpoint in the isolated worker, then the publish runs again.
        const projection = stage.projection;
        if (!projection) {
          throw new Error("DRAFT_PROJECTION_PREPARATION_MISSING");
        }
        try {
          stage.projectionPositions = await isolation.anchors(
            projection.state,
            projection.anchors,
            false,
            context.signal,
            stage.organizationId,
          );
        } catch (failure) {
          mapIsolationError(failure);
        }
        result = await publishOnce();
      }
      // After commit only: a rolled-back publish is never announced.
      if (holder.publication && holder.organizationId && !holder.replayed) {
        options.collaboration?.notifyDraftPublished(
          holder.organizationId,
          contractSchemas.DraftPublication.parse(holder.publication),
        );
      }
      return result;
    }
    if (!isStagedAction(action.name)) {
      return await postgresAuthority.run(action, context, input, next);
    }
    const maximumAttempts = action.name === DraftImplementedAction.Slice
      ? 1
      : DRAFT_LIMITS.staleAttempts;
    let release: (() => void) | undefined;
    // An acceptance that could not apply its anchored edit: carried into the
    // next pass, which records it, instead of failing the call.
    let refusal: DraftEditRefusalReason | undefined;
    try {
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        const stage: DraftExecutionStage = {};
        if (refusal !== undefined) stage.refusal = refusal;
        try {
          return await postgresAuthority.run(
            action,
            Object.assign({}, context, { [draftExecutionStage]: stage }),
            input,
            next,
          );
        } catch (error) {
          if (!(error instanceof DraftPreparationComplete)) throw error;
        }
        try {
          if (stage.open) {
            stage.candidate = await isolation.initialize(
              stage.open.text,
              context.signal,
              stage.organizationId,
            );
          } else if (stage.rollover) {
            stage.candidate = await isolation.initialize(
              stage.rollover.text,
              context.signal,
              stage.organizationId,
            );
          } else if (stage.edit) {
            release ??= admission.acquire(stage.edit.draftId);
            if (
              action.name === DraftImplementedAction.SuggestionCreate
            ) {
              // A proposal is recorded only once its anchor resolves to the
              // text it claims to replace; nothing is applied.
              try {
                await isolation.verify(
                  stage.edit.currentState,
                  stage.edit.sourceState,
                  input as DraftEditInput,
                  context.signal,
                  stage.organizationId,
                );
              } catch (error) {
                const reason = isolationRefusal(error);
                if (reason) throw refusedDraftEdit(reason);
                throw error;
              }
            } else {
              try {
                stage.candidate = await isolation.edit(
                  stage.edit.currentState,
                  stage.edit.sourceState,
                  stage.decision?.input ?? input as DraftEditInput,
                  context.signal,
                  stage.organizationId,
                );
              } catch (error) {
                const reason = isolationRefusal(error);
                if (
                  reason &&
                  action.name === DraftImplementedAction.SuggestionAccept
                ) {
                  stage.refusal = reason;
                  refusal = reason;
                  continue;
                }
                if (reason && action.name === DraftImplementedAction.Edit) {
                  // A guarded edit names why it could not apply (#28).
                  throw new StandardError({
                    code: "PRECONDITION_FAILED",
                    params: {
                      reason: (error as DraftIsolationError).message ===
                          "CURRENT_TARGET_AMBIGUOUS"
                        ? "target_ambiguous"
                        : "text_changed",
                    },
                    cause: error,
                  });
                }
                throw error;
              }
            }
          } else if (stage.commentRoot) {
            const root = stage.commentRoot;
            let positions: DraftAnchorPosition[];
            try {
              positions = await isolation.anchors(
                root.state,
                [root.anchor],
                true,
                context.signal,
                stage.organizationId,
              );
            } catch (error) {
              refusedCommentAnchor(error);
            }
            const position = positions[0];
            if (!position) throw new Error("DRAFT_COMMENT_ANCHOR_MISSING");
            stage.commentPosition = position;
          } else if (stage.commentPage) {
            stage.commentPositions = await isolation.anchors(
              stage.commentPage.state,
              stage.commentPage.anchors,
              false,
              context.signal,
              stage.organizationId,
            );
          } else if (stage.slice) {
            const sliceInput = input as DraftSliceInput;
            stage.sliceCandidate = await isolation.slice(
              stage.slice.state,
              sliceInput.startUtf16,
              sliceInput.endUtf16,
              context.signal,
              stage.organizationId,
            );
          } else if (stage.refusal) {
            // Nothing to compute: the refused decision is recorded below.
          } else {
            throw new Error("DRAFT_PREPARATION_MISSING");
          }
        } catch (error) {
          mapIsolationError(error);
        }
        try {
          return await postgresAuthority.run(
            action,
            Object.assign({}, context, { [draftExecutionStage]: stage }),
            input,
            next,
          );
        } catch (error) {
          if (error instanceof StaleDraftCandidateError) {
            if (
              action.name === DraftImplementedAction.SuggestionAccept &&
              attempt + 1 < maximumAttempts
            ) {
              stage.refusal = "draft_moved_on";
              refusal = "draft_moved_on";
              continue;
            }
            if (attempt + 1 < maximumAttempts) continue;
            if (action.name === DraftImplementedAction.SuggestionAccept) {
              throw refusedDraftEdit("draft_moved_on");
            }
            throw new StandardError({ code: "PRECONDITION_FAILED" });
          }
          throw error;
        }
      }
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    } finally {
      release?.();
    }
  };

  const suggestionActions: ReadonlySet<string> = new Set([
    DraftImplementedAction.SuggestionCreate,
    DraftImplementedAction.SuggestionAccept,
    DraftImplementedAction.SuggestionReject,
  ]);

  const authority: ActionAuthorityRunner = {
    async run(action, context, input, next) {
      const holder: SuggestionHolder = {};
      const scoped = suggestionActions.has(action.name)
        ? Object.assign({}, context, { [committedSuggestion]: holder })
        : context;
      const result = await runAction(action, scoped, input, next);
      // After commit only: a rolled-back decision is never announced.
      if (holder.suggestion && holder.organizationId && !holder.replayed) {
        options.collaboration?.notifyDraftSuggestion(
          holder.organizationId,
          contractSchemas.DraftSuggestion.parse(holder.suggestion),
        );
      }
      return result;
    },
  };

  const readPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  const commandPolicy = { ...readPolicy, type: ActionKind.Command } as const;
  const registry = new ActionRegistry(authority, directCommandRunner);
  registry
    .register({
      name: DraftImplementedAction.Open,
      method: HttpMethod.Post,
      path: "/v1/artifacts/:id/drafts",
      input: contractSchemas.IdPath,
      output: contractSchemas.Draft,
      policy: commandPolicy,
      naturalIdempotency: true,
      handler: async (context) => {
        const { transaction, organizationId } = requireWorkTransaction(context);
        const stage = (context as StagedActionContext)[draftExecutionStage];
        if (!stage) throw new Error("DRAFT_STAGE_MISSING");
        if (!stage.candidate) {
          const prepared = await prepareDraftOpen(
            transaction,
            organizationId,
            draftId(context),
          );
          if (!("kind" in prepared)) {
            return withCapabilities(context, prepared);
          }
          stage.open = prepared;
          stage.organizationId = organizationId;
          throw new DraftPreparationComplete();
        }
        if (!stage.open) throw new Error("DRAFT_OPEN_PREPARATION_MISSING");
        return withCapabilities(
          context,
          await commitDraftOpen(
            transaction,
            organizationId,
            stage.open,
            stage.candidate,
          ),
        );
      },
    })
    .register({
      name: DraftImplementedAction.Rollover,
      method: HttpMethod.Post,
      path: "/v1/drafts/:id/rollover",
      input: contractSchemas.DraftRollover,
      output: contractSchemas.Draft,
      policy: commandPolicy,
      naturalIdempotency: true,
      naturalIdempotencyInputField: "checkpointId",
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        // Closing an epoch decides what becomes of every unsaved edit, so a
        // person does it; an agent proposes changes and never reconciles them.
        if (attributeAction(context, principalId).actorKind !== "person") {
          throw new StandardError({
            code: "AUTH_FORBIDDEN",
            params: { reason: "rollover_requires_person" },
          });
        }
        const stage = (context as StagedActionContext)[draftExecutionStage];
        if (!stage) throw new Error("DRAFT_STAGE_MISSING");
        if (!stage.candidate) {
          const prepared = await prepareDraftRollover(
            transaction,
            organizationId,
            draftId(context),
            input,
          );
          if (!("kind" in prepared)) {
            return withCapabilities(context, prepared);
          }
          stage.rollover = prepared;
          stage.organizationId = organizationId;
          throw new DraftPreparationComplete();
        }
        if (!stage.rollover) {
          throw new Error("DRAFT_ROLLOVER_PREPARATION_MISSING");
        }
        return withCapabilities(
          context,
          await commitDraftRollover(
            transaction,
            organizationId,
            stage.rollover,
            stage.candidate,
          ),
        );
      },
    })
    .register({
      name: DraftImplementedAction.Get,
      method: HttpMethod.Get,
      path: "/v1/drafts/:id",
      input: contractSchemas.IdPath,
      output: contractSchemas.Draft,
      policy: readPolicy,
      handler: async (context) => {
        const { transaction, organizationId } = requireWorkTransaction(context);
        return withCapabilities(
          context,
          await readDraft(transaction, organizationId, draftId(context)),
        );
      },
    })
    .register({
      name: DraftImplementedAction.CheckpointGet,
      method: HttpMethod.Get,
      path: "/v1/drafts/:id/checkpoints/:checkpointId",
      input: contractSchemas.DraftCheckpointPath,
      output: contractSchemas.DraftCheckpoint,
      policy: readPolicy,
      handler: async (context, input) => {
        const { transaction, organizationId } = requireWorkTransaction(context);
        return contractSchemas.DraftCheckpoint.parse(
          await readDraftCheckpoint(
            transaction,
            organizationId,
            draftId(context),
            input.checkpointId,
          ),
        );
      },
    })
    .register({
      name: DraftImplementedAction.Slice,
      method: HttpMethod.Get,
      path: "/v1/drafts/:id/slice",
      input: contractSchemas.DraftSliceQuery,
      output: contractSchemas.DraftSlice,
      policy: readPolicy,
      handler: async (context, input) => {
        const { transaction, organizationId } = requireWorkTransaction(context);
        const stage = (context as StagedActionContext)[draftExecutionStage];
        if (!stage) throw new Error("DRAFT_STAGE_MISSING");
        if (!stage.sliceCandidate) {
          stage.organizationId = organizationId;
          stage.slice = await prepareDraftSlice(
            transaction,
            organizationId,
            draftId(context),
            input.checkpointId,
          );
          throw new DraftPreparationComplete();
        }
        if (!stage.slice) throw new Error("DRAFT_SLICE_PREPARATION_MISSING");
        const current = await prepareDraftSlice(
          transaction,
          organizationId,
          draftId(context),
          input.checkpointId,
        );
        if (
          current.epoch !== stage.slice.epoch ||
          current.serverSequence !== stage.slice.serverSequence
        ) throw new StandardError({ code: "PRECONDITION_FAILED" });
        return contractSchemas.DraftSlice.parse({
          draftId: current.draftId,
          epoch: current.epoch,
          checkpointId: current.checkpointId,
          serverSequence: current.serverSequence,
          startUtf16: input.startUtf16,
          endUtf16: input.endUtf16,
          ...stage.sliceCandidate,
        });
      },
    })
    .register({
      name: DraftImplementedAction.Edit,
      method: HttpMethod.Post,
      path: "/v1/drafts/:id/edits",
      input: contractSchemas.DraftEdit,
      output: contractSchemas.DraftMutationReceipt,
      policy: commandPolicy,
      naturalIdempotency: true,
      naturalIdempotencyInputField: "mutationId",
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        // A shared draft is changed by a person directly and by an agent as a
        // suggestion (#71, chapter 25 O50): an unaccepted agent edit must never
        // reach a published version, so the direct edit path refuses it.
        if (
          attributeAction(context, principalId).actorKind !== "person"
        ) {
          throw new StandardError({
            code: "AUTH_FORBIDDEN",
            params: { reason: "agent_edit_requires_suggestion" },
          });
        }
        const stage = (context as StagedActionContext)[draftExecutionStage];
        if (!stage) throw new Error("DRAFT_STAGE_MISSING");
        if (!stage.candidate) {
          const prepared = await prepareDraftEdit(
            transaction,
            organizationId,
            principalId,
            draftId(context),
            input,
          );
          if (!("kind" in prepared)) {
            return contractSchemas.DraftMutationReceipt.parse(prepared);
          }
          stage.edit = prepared;
          stage.organizationId = organizationId;
          throw new DraftPreparationComplete();
        }
        if (!stage.edit) throw new Error("DRAFT_EDIT_PREPARATION_MISSING");
        return contractSchemas.DraftMutationReceipt.parse(
          await commitDraftEdit(
            transaction,
            organizationId,
            principalId,
            input,
            stage.edit,
            stage.candidate,
          ),
        );
      },
    })
    .register({
      name: DraftImplementedAction.PublicationCreate,
      method: HttpMethod.Post,
      path: "/v1/drafts/:id/publications",
      input: contractSchemas.DraftPublicationCreate,
      output: contractSchemas.DraftPublication,
      policy: commandPolicy,
      naturalIdempotency: true,
      naturalIdempotencyInputField: "checkpointId",
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        const id = draftId(context);
        const supplied = context.request.headers.get("idempotency-key");
        const projection = await threadProjection(
          context as StagedActionContext,
          organizationId,
          id,
          input.checkpointId,
          input.projectThreads ?? [],
        );
        const frozen = await freezeTextDraftCheckpoint(
          transaction,
          organizationId,
          id,
          input.checkpointId,
          input.textDigest,
        );
        const { publication, replayed } = await publishFrozenDraft(
          transaction,
          {
            organizationId,
            frozen,
            attribution: attributeAction(context, principalId),
            idempotencyKey: supplied === null
              ? null
              : parseIdempotencyKey(supplied),
            requestId: context.requestId,
            traceId: context.traceId,
            operation: DraftImplementedAction.PublicationCreate,
            blobStore: options.blobStore,
            ...(projection ? { projection } : {}),
          },
        );
        const holder = (context as PublicationActionContext)[
          committedPublication
        ];
        if (holder) {
          holder.organizationId = organizationId;
          holder.publication = publication;
          holder.replayed = replayed;
        }
        return contractSchemas.DraftPublication.parse(publication);
      },
    })
    .register({
      name: DraftImplementedAction.PublicationGet,
      method: HttpMethod.Get,
      path: "/v1/drafts/:id/publications/:checkpointId",
      input: contractSchemas.DraftCheckpointPath,
      output: contractSchemas.DraftPublication,
      policy: readPolicy,
      handler: async (context, input) => {
        const { transaction, organizationId } = requireWorkTransaction(context);
        return contractSchemas.DraftPublication.parse(
          await readDraftPublication(
            transaction,
            organizationId,
            draftId(context),
            input.checkpointId,
          ),
        );
      },
    })
    .register({
      name: DraftImplementedAction.SuggestionCreate,
      method: HttpMethod.Post,
      path: "/v1/drafts/:id/suggestions",
      input: contractSchemas.DraftSuggestionCreate,
      output: contractSchemas.DraftSuggestion,
      policy: commandPolicy,
      naturalIdempotency: true,
      naturalIdempotencyInputField: "mutationId",
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        const stage = (context as StagedActionContext)[draftExecutionStage];
        if (!stage) throw new Error("DRAFT_STAGE_MISSING");
        if (!stage.edit) {
          const prepared = await prepareDraftSuggestion(
            transaction,
            organizationId,
            principalId,
            draftId(context),
            input as DraftSuggestionCreateInput,
            {
              attribution: attributeAction(context, principalId),
              requestId: context.requestId,
              traceId: context.traceId,
            },
          );
          if (!("kind" in prepared)) {
            announceSuggestion(context, organizationId, prepared, true);
            return contractSchemas.DraftSuggestion.parse(prepared);
          }
          stage.edit = prepared;
          stage.organizationId = organizationId;
          throw new DraftPreparationComplete();
        }
        const { suggestion } = await commitDraftSuggestion(
          transaction,
          organizationId,
          {
            draftId: draftId(context),
            attribution: attributeAction(context, principalId),
            requestId: context.requestId,
            traceId: context.traceId,
            create: input as DraftSuggestionCreateInput,
          },
          stage.edit,
        );
        announceSuggestion(context, organizationId, suggestion);
        return contractSchemas.DraftSuggestion.parse(suggestion);
      },
    })
    .register({
      name: DraftImplementedAction.SuggestionList,
      method: HttpMethod.Get,
      path: "/v1/drafts/:id/suggestions",
      input: contractSchemas.DraftSuggestionQuery,
      output: contractSchemas["Page<DraftSuggestion>"],
      policy: readPolicy,
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        return contractSchemas["Page<DraftSuggestion>"].parse(
          await listDraftSuggestions(
            transaction,
            organizationId,
            principalId,
            options.cursorSecret,
            draftId(context),
            input,
          ),
        );
      },
    })
    .register({
      name: DraftImplementedAction.SuggestionAccept,
      method: HttpMethod.Post,
      path: "/v1/drafts/:id/suggestions/:suggestionId/accept",
      input: contractSchemas.DraftSuggestionPath,
      output: contractSchemas.DraftSuggestion,
      policy: commandPolicy,
      naturalIdempotency: true,
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        const attribution = attributeAction(context, principalId);
        assertPersonDecides(attribution);
        const stage = (context as StagedActionContext)[draftExecutionStage];
        if (!stage) throw new Error("DRAFT_STAGE_MISSING");
        if (stage.refusal) {
          const { suggestion } = await commitSuggestionRefusal(
            transaction,
            organizationId,
            {
              draftId: draftId(context),
              suggestionId: input.suggestionId,
              principalId,
              requestId: context.requestId,
              traceId: context.traceId,
              reason: stage.refusal,
            },
          );
          announceSuggestion(context, organizationId, suggestion);
          return contractSchemas.DraftSuggestion.parse(suggestion);
        }
        if (stage.edit && stage.decision && stage.candidate) {
          // The suggestion is settled only if the edit is about to apply: the
          // lock is taken before the edit, so an accept and a reject cannot
          // both pass the waiting check (#71 review).
          await lockSuggestionAcceptance(
            transaction,
            organizationId,
            draftId(context),
            input.suggestionId,
          );
          const receipt = await commitDraftEdit(
            transaction,
            organizationId,
            principalId,
            stage.decision.input,
            stage.edit,
            stage.candidate,
          );
          const { suggestion } = await commitSuggestionAcceptance(
            transaction,
            organizationId,
            {
              draftId: draftId(context),
              suggestionId: input.suggestionId,
              principalId,
              requestId: context.requestId,
              traceId: context.traceId,
              appliedServerSequence: receipt.serverSequence,
            },
          );
          announceSuggestion(context, organizationId, suggestion);
          return contractSchemas.DraftSuggestion.parse(suggestion);
        }
        const prepared = await prepareSuggestionDecision(
          transaction,
          organizationId,
          draftId(context),
          input.suggestionId,
          "accept",
        );
        if (prepared.kind === "settled") {
          announceSuggestion(
            context,
            organizationId,
            prepared.suggestion,
            true,
          );
          return contractSchemas.DraftSuggestion.parse(prepared.suggestion);
        }
        if (prepared.kind === "refused") {
          const { suggestion } = await commitSuggestionRefusal(
            transaction,
            organizationId,
            {
              draftId: draftId(context),
              suggestionId: input.suggestionId,
              principalId,
              requestId: context.requestId,
              traceId: context.traceId,
              reason: prepared.reason,
            },
          );
          announceSuggestion(context, organizationId, suggestion);
          return contractSchemas.DraftSuggestion.parse(suggestion);
        }
        if (prepared.kind === "reject") {
          throw new Error("SUGGESTION_DECISION_UNEXPECTED");
        }
        stage.edit = prepared.edit;
        stage.decision = {
          suggestionId: input.suggestionId,
          input: prepared.input,
        };
        stage.organizationId = organizationId;
        throw new DraftPreparationComplete();
      },
    })
    .register({
      name: DraftImplementedAction.SuggestionReject,
      method: HttpMethod.Post,
      path: "/v1/drafts/:id/suggestions/:suggestionId/reject",
      input: contractSchemas.DraftSuggestionPath,
      output: contractSchemas.DraftSuggestion,
      policy: commandPolicy,
      naturalIdempotency: true,
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        assertPersonDecides(attributeAction(context, principalId));
        const prepared = await prepareSuggestionDecision(
          transaction,
          organizationId,
          draftId(context),
          input.suggestionId,
          "reject",
        );
        if (prepared.kind === "settled") {
          announceSuggestion(
            context,
            organizationId,
            prepared.suggestion,
            true,
          );
          return contractSchemas.DraftSuggestion.parse(prepared.suggestion);
        }
        if (prepared.kind !== "reject") {
          throw new Error("SUGGESTION_DECISION_UNEXPECTED");
        }
        const { suggestion } = await commitSuggestionRejection(
          transaction,
          organizationId,
          {
            draftId: draftId(context),
            suggestionId: input.suggestionId,
            principalId,
            requestId: context.requestId,
            traceId: context.traceId,
          },
        );
        announceSuggestion(context, organizationId, suggestion);
        return contractSchemas.DraftSuggestion.parse(suggestion);
      },
    })
    .register({
      name: DraftImplementedAction.CommentCreate,
      method: HttpMethod.Post,
      path: "/v1/drafts/:id/comments",
      input: contractSchemas.DraftCommentCreate,
      output: contractSchemas.DraftComment,
      policy: commandPolicy,
      naturalIdempotency: true,
      naturalIdempotencyInputField: "mutationId",
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        const stage = (context as StagedActionContext)[draftExecutionStage];
        if (!stage) throw new Error("DRAFT_STAGE_MISSING");
        const command = {
          draftId: draftId(context),
          attribution: attributeAction(context, principalId),
          requestId: context.requestId,
          traceId: context.traceId,
          agentSessionId: await auditAgentSessionId(
            transaction,
            context,
            organizationId,
          ),
          create: input,
        };
        if (stage.commentRoot && stage.commentPosition) {
          return contractSchemas.DraftComment.parse(
            await commitDraftCommentRoot(
              transaction,
              organizationId,
              command,
              stage.commentRoot,
              stage.commentPosition,
            ),
          );
        }
        const prepared = await prepareDraftComment(
          transaction,
          organizationId,
          command,
        );
        if (!("requestDigest" in prepared)) {
          return contractSchemas.DraftComment.parse(prepared);
        }
        stage.commentRoot = prepared;
        stage.organizationId = organizationId;
        throw new DraftPreparationComplete();
      },
    })
    .register({
      name: DraftImplementedAction.CommentList,
      method: HttpMethod.Get,
      path: "/v1/drafts/:id/comments",
      input: contractSchemas.DraftCommentQuery,
      output: contractSchemas["Page<DraftComment>"],
      policy: readPolicy,
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        const stage = (context as StagedActionContext)[draftExecutionStage];
        if (!stage) throw new Error("DRAFT_STAGE_MISSING");
        const id = draftId(context);
        if (stage.commentPage && stage.commentPositions) {
          return contractSchemas["Page<DraftComment>"].parse(
            resolvedDraftCommentPage(
              stage.commentPage,
              stage.commentPositions,
              await draftEpoch(transaction, organizationId, id),
            ),
          );
        }
        const prepared = await prepareDraftCommentPage(
          transaction,
          organizationId,
          principalId,
          options.cursorSecret,
          id,
          input,
        );
        if ("items" in prepared) {
          return contractSchemas["Page<DraftComment>"].parse(prepared);
        }
        stage.commentPage = prepared;
        stage.organizationId = organizationId;
        throw new DraftPreparationComplete();
      },
    })
    .register({
      name: DraftImplementedAction.CommentUpdate,
      method: HttpMethod.Patch,
      path: "/v1/drafts/:id/comments/:commentId",
      input: contractSchemas.DraftCommentUpdate,
      output: contractSchemas.DraftComment,
      policy: commandPolicy,
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        const commentId = context.params.commentId;
        if (!commentId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
        return contractSchemas.DraftComment.parse(
          await updateDraftComment(transaction, organizationId, {
            draftId: draftId(context),
            commentId,
            principalId,
            expectedVersion: parseStrongIfMatch(
              context.request.headers.get("if-match"),
            ),
            requestId: context.requestId,
            traceId: context.traceId,
            agentSessionId: await auditAgentSessionId(
              transaction,
              context,
              organizationId,
            ),
            update: input,
          }),
        );
      },
    })
    .register({
      name: DraftImplementedAction.ReferenceCreate,
      method: HttpMethod.Post,
      path: "/v1/drafts/:id/references",
      input: contractSchemas.DraftReferenceCreate,
      output: contractSchemas.DraftReference,
      policy: commandPolicy,
      naturalIdempotency: true,
      naturalIdempotencyInputField: "mutationId",
      handler: async (context, input) => {
        const { transaction, organizationId, principalId } =
          requireWorkTransaction(context);
        // Send to agent (#28): records the frozen reference only; turn and
        // workflow admission are not touched here.
        return contractSchemas.DraftReference.parse(
          await createDraftReference(transaction, organizationId, {
            draftId: draftId(context),
            attribution: attributeAction(context, principalId),
            requestId: context.requestId,
            traceId: context.traceId,
            create: input,
          }),
        );
      },
    })
    .register({
      name: DraftImplementedAction.ReferenceGet,
      method: HttpMethod.Get,
      path: "/v1/draft-references/:id",
      input: contractSchemas.IdPath,
      output: contractSchemas.DraftReference,
      policy: readPolicy,
      handler: async (context, input) => {
        const { transaction, organizationId } = requireWorkTransaction(context);
        return contractSchemas.DraftReference.parse(
          await readDraftReference(transaction, organizationId, input.id),
        );
      },
    });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, draftImplementedActions);

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/artifacts/*", options.browserSession);
  app.use("/v1/drafts", options.browserSession);
  app.use("/v1/drafts/*", options.browserSession);
  app.use("/v1/draft-references/*", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
      maxBodyBytes: 196_608,
      deadlineMs: 10_000,
    }),
  );
  return app;
}

export type { DraftRead, DraftReceipt };
