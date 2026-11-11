import { z } from "zod";
import type { BudgetRuntimeConfig } from "@bakery/config";
import type { PgDatabase } from "@bakery/persistence";
import {
  createWorkerCoordinatorExecutor,
  DEFAULT_COORDINATOR_CLAIM_TIMEOUT_MS,
  DEFAULT_COORDINATOR_TURN_TIMEOUT_MS,
} from "./coordinator-worker.ts";

/** Env var naming the test-only scripted coordinator directory. */
export const SCRIPTED_COORDINATOR_DIR_ENV = "BAKERY_SCRIPTED_COORDINATOR_DIR";

export {
  CoordinatorEffectSchema,
  CoordinatorNoopEffectSchema,
  CoordinatorPlanRevisionEffectSchema,
  CoordinatorQuestionEffectSchema,
  CoordinatorReplyEffectSchema,
} from "@bakery/contracts/coordinator-turn";
export type { CoordinatorEffect } from "@bakery/contracts/coordinator-turn";
import {
  type CoordinatorEffect,
  CoordinatorEffectSchema,
} from "@bakery/contracts/coordinator-turn";

export const CoordinatorFailureSchema = z.object({
  code: z.string().min(1).max(100).describe("Stable machine failure code."),
  detail: z.string().min(1).max(2000).describe(
    "Redacted human-readable failure detail.",
  ),
}).strict().describe("Explicit executor failure; no effects are applied.");

export const CoordinatorScriptSchema = z.object({
  effects: z.array(CoordinatorEffectSchema).max(20).default([]).describe(
    "Effects the scripted executor returns for a matching turn.",
  ),
  failure: CoordinatorFailureSchema.optional().describe(
    "When present the scripted turn fails with this failure instead.",
  ),
}).strict().describe("Test-only scripted coordinator turn outcome.");

export type CoordinatorTurnInput = Readonly<{
  turnId: string;
  organizationId: string;
  conversationId: string;
  triggerMessageId: string;
  /** Highest message sequence the executor may see. */
  contextThroughSequence: string;
  /** Messages with sequence <= cutoff, ascending. */
  messages: ReadonlyArray<
    Readonly<{
      id: string;
      sequence: string;
      authorId: string | null;
      messageType: string;
      intent: string;
      body: string;
    }>
  >;
  scope: Readonly<{
    applicationId: string | null;
    repositoryId: string | null;
    taskId: string | null;
  }>;
  agentVersion: Readonly<{
    id: string;
    agentId: string;
    revision: number;
    config: unknown;
  }>;
  openQuestions: readonly unknown[];
  currentPlanRevision: unknown | null;
}>;

export type CoordinatorTurnResult =
  | Readonly<{ status: "completed"; effects: readonly CoordinatorEffect[] }>
  | Readonly<{ status: "failed"; code: string; detail: string }>;

/** Provider-neutral seam; Bakery applies returned effects, never the executor. */
export interface CoordinatorTurnExecutor {
  /** Which executor this is; lets wiring tests assert the selection. */
  readonly kind?: "worker" | "unavailable" | "scripted";
  execute(
    input: CoordinatorTurnInput,
    signal: AbortSignal,
  ): Promise<CoordinatorTurnResult>;
}

/** Explicit no-harness executor: every turn fails `coordinator_unavailable`. */
export function createUnavailableCoordinatorExecutor(): CoordinatorTurnExecutor {
  return {
    kind: "unavailable",
    execute: () =>
      Promise.resolve({
        status: "failed",
        code: "coordinator_unavailable",
        detail: "No coordinator agent harness is configured",
      }),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Test-only executor. Script lookup: `<triggerMessageId>.json`,
 * `<conversationId>.json`, then `default.json`. A `<turnId>.hold` file blocks
 * execution until `<turnId>.release` exists or the turn is canceled.
 */
export function createScriptedCoordinatorExecutor(
  directory: string,
): CoordinatorTurnExecutor {
  return {
    kind: "scripted",
    async execute(input, signal) {
      while (
        await exists(`${directory}/${input.turnId}.hold`) &&
        !await exists(`${directory}/${input.turnId}.release`)
      ) {
        if (signal.aborted) {
          return {
            status: "failed",
            code: "coordinator_aborted",
            detail: "Scripted coordinator turn aborted",
          };
        }
        await sleep(50, signal);
      }
      for (
        const name of [
          input.triggerMessageId,
          input.conversationId,
          "default",
        ]
      ) {
        const path = `${directory}/${name}.json`;
        if (!await exists(path)) continue;
        const parsed = CoordinatorScriptSchema.safeParse(
          JSON.parse(await Deno.readTextFile(path)),
        );
        if (!parsed.success) {
          return {
            status: "failed",
            code: "coordinator_script_invalid",
            detail: "Scripted coordinator file is invalid",
          };
        }
        return parsed.data.failure
          ? { status: "failed", ...parsed.data.failure }
          : { status: "completed", effects: parsed.data.effects };
      }
      return {
        status: "failed",
        code: "coordinator_script_missing",
        detail: "No scripted coordinator outcome matches this turn",
      };
    },
  };
}

/** Env var selecting the production executor: `worker` or `unavailable`. */
export const COORDINATOR_EXECUTOR_ENV = "BAKERY_COORDINATOR_EXECUTOR";
export const COORDINATOR_CLAIM_TIMEOUT_ENV =
  "BAKERY_COORDINATOR_CLAIM_TIMEOUT_MS";
export const COORDINATOR_TURN_TIMEOUT_ENV =
  "BAKERY_COORDINATOR_TURN_TIMEOUT_MS";

function readTimeout(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

/** Dependencies the production worker executor needs. */
export type CoordinatorExecutorDeps = Readonly<{
  database?: PgDatabase;
  budget?: BudgetRuntimeConfig;
}>;

/**
 * Executor selection.
 * - `BAKERY_SCRIPTED_COORDINATOR_DIR`: scripted executor, `BAKERY_ENV=test` only.
 * - `BAKERY_COORDINATOR_EXECUTOR` is `worker`, `unavailable` or unset.
 * - Unset: `worker` outside `BAKERY_ENV=test` when a database is given, else
 *   `unavailable`, so test stacks without a script never wait on a claim.
 */
export function readCoordinatorExecutor(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  deps: CoordinatorExecutorDeps = {},
): CoordinatorTurnExecutor {
  const selected = env[COORDINATOR_EXECUTOR_ENV]?.trim() || undefined;
  if (
    selected !== undefined && selected !== "worker" &&
    selected !== "unavailable"
  ) {
    throw new Error(`${COORDINATOR_EXECUTOR_ENV}_INVALID`);
  }
  const directory = env[SCRIPTED_COORDINATOR_DIR_ENV]?.trim();
  if (directory) {
    if (env.BAKERY_ENV !== "test") {
      throw new Error(`${SCRIPTED_COORDINATOR_DIR_ENV}_TEST_ONLY`);
    }
    if (!directory.startsWith("/")) {
      throw new Error(`${SCRIPTED_COORDINATOR_DIR_ENV}_ABSOLUTE_PATH_REQUIRED`);
    }
    if (selected === "worker") {
      throw new Error(`${COORDINATOR_EXECUTOR_ENV}_CONFLICTS_WITH_SCRIPT`);
    }
    return createScriptedCoordinatorExecutor(directory);
  }
  const mode = selected ??
    (env.BAKERY_ENV !== "test" && deps.database ? "worker" : "unavailable");
  if (mode === "unavailable") return createUnavailableCoordinatorExecutor();
  if (!deps.database) {
    throw new Error(`${COORDINATOR_EXECUTOR_ENV}_WORKER_REQUIRES_DATABASE`);
  }
  const claimTimeoutMs = readTimeout(
    env,
    COORDINATOR_CLAIM_TIMEOUT_ENV,
    DEFAULT_COORDINATOR_CLAIM_TIMEOUT_MS,
  );
  const turnTimeoutMs = readTimeout(
    env,
    COORDINATOR_TURN_TIMEOUT_ENV,
    DEFAULT_COORDINATOR_TURN_TIMEOUT_MS,
  );
  if (claimTimeoutMs >= turnTimeoutMs) {
    throw new Error("BAKERY_COORDINATOR_TIMEOUTS_INVALID");
  }
  return createWorkerCoordinatorExecutor({
    database: deps.database,
    budget: deps.budget,
    claimTimeoutMs,
    turnTimeoutMs,
  });
}
