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
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import {
  assertImplementedActionRegistry,
  DraftImplementedAction,
  draftImplementedActions,
} from "@bakery/contracts/implemented-actions";
import type { z } from "zod";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import type { PgDatabase } from "../../platform/database.ts";
import {
  createDraftIsolation,
  type DraftIsolation,
  DraftIsolationError,
  type IsolatedDraftSlice,
} from "./draft-isolation.ts";
import {
  commitDraftEdit,
  commitDraftOpen,
  type DraftEditInput,
  DraftPreparationComplete,
  type DraftRead,
  type DraftReceipt,
  type PreparedDraftEdit,
  type PreparedDraftOpen,
  type PreparedDraftSlice,
  prepareDraftEdit,
  prepareDraftOpen,
  prepareDraftSlice,
  readDraft,
  readDraftCheckpoint,
  StaleDraftCandidateError,
} from "./draft-persistence.ts";
import { DRAFT_LIMITS, type DraftCandidate } from "./drafts.ts";

export type DraftResourceRouteOptions = {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  isolation?: DraftIsolation;
};

type DraftSliceInput = z.output<typeof contractSchemas.DraftSliceQuery>;

type DraftExecutionStage = {
  open?: PreparedDraftOpen;
  edit?: PreparedDraftEdit;
  slice?: PreparedDraftSlice;
  candidate?: DraftCandidate;
  sliceCandidate?: IsolatedDraftSlice;
};

const draftExecutionStage: unique symbol = Symbol("draft-execution-stage");
type StagedActionContext = ActionContext & {
  [draftExecutionStage]?: DraftExecutionStage;
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
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE", cause: error });
  }
}

function isStagedAction(name: string): boolean {
  return name === DraftImplementedAction.Open ||
    name === DraftImplementedAction.Edit ||
    name === DraftImplementedAction.Slice;
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

  const authority: ActionAuthorityRunner = {
    async run(action, context, input, next) {
      if (!isStagedAction(action.name)) {
        return await postgresAuthority.run(action, context, input, next);
      }
      const maximumAttempts = action.name === DraftImplementedAction.Edit ||
          action.name === DraftImplementedAction.Open
        ? DRAFT_LIMITS.staleAttempts
        : 1;
      let release: (() => void) | undefined;
      try {
        for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
          const stage: DraftExecutionStage = {};
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
              );
            } else if (stage.edit) {
              release ??= admission.acquire(stage.edit.draftId);
              stage.candidate = await isolation.edit(
                stage.edit.currentState,
                stage.edit.sourceState,
                input as DraftEditInput,
                context.signal,
              );
            } else if (stage.slice) {
              const sliceInput = input as DraftSliceInput;
              stage.sliceCandidate = await isolation.slice(
                stage.slice.state,
                sliceInput.startUtf16,
                sliceInput.endUtf16,
                context.signal,
              );
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
            if (
              error instanceof StaleDraftCandidateError &&
              attempt + 1 < maximumAttempts
            ) continue;
            if (error instanceof StaleDraftCandidateError) {
              throw new StandardError({ code: "PRECONDITION_FAILED" });
            }
            throw error;
          }
        }
        throw new StandardError({ code: "PRECONDITION_FAILED" });
      } finally {
        release?.();
      }
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
            return contractSchemas.Draft.parse(prepared);
          }
          stage.open = prepared;
          throw new DraftPreparationComplete();
        }
        if (!stage.open) throw new Error("DRAFT_OPEN_PREPARATION_MISSING");
        return contractSchemas.Draft.parse(
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
      name: DraftImplementedAction.Get,
      method: HttpMethod.Get,
      path: "/v1/drafts/:id",
      input: contractSchemas.IdPath,
      output: contractSchemas.Draft,
      policy: readPolicy,
      handler: async (context) => {
        const { transaction, organizationId } = requireWorkTransaction(context);
        return contractSchemas.Draft.parse(
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
    });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, draftImplementedActions);

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/artifacts/*", options.browserSession);
  app.use("/v1/drafts", options.browserSession);
  app.use("/v1/drafts/*", options.browserSession);
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
