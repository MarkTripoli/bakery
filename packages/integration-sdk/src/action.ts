import { z } from "zod";
import type { ActionContext, ReconciliationContext } from "./context.ts";
import {
  IntegrationActivationError,
  IntegrationContractError,
} from "./errors.ts";
import { findSchemaDescriptionDefects } from "./descriptions.ts";
import { isStrictObject } from "./request.ts";

export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

export type ActionEffect = "read" | "native-idempotent" | "reconcile";
export type PermissionLevel = "read" | "write";
export type ExactRef = { id: string; version: number };

export type ReconcileResult<O> =
  | { status: "confirmed"; result: O }
  | { status: "uncertain" };

export type ActionDefinition<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodType = z.ZodType,
> = {
  id: string;
  version: number;
  input: I;
  output: O;
  effect: ActionEffect;
  resourceKind: string;
  requests: readonly ExactRef[];
  reconcileRequests?: readonly ExactRef[];
  providerPermissions: Readonly<Record<string, PermissionLevel>>;
  resourceProjection?: readonly string[];
  maxOutputBytes?: number;
  execute(ctx: ActionContext, input: z.infer<I>): Promise<z.infer<O>>;
  reconcile?(
    ctx: ReconciliationContext<z.infer<I>>,
  ): Promise<ReconcileResult<z.infer<O>>>;
};

export type DefinedAction<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodType = z.ZodType,
> = Readonly<ActionDefinition<I, O>> & {
  readonly maxOutputBytes: number;
  invoke(ctx: ActionContext, raw: unknown): Promise<z.infer<O>>;
  invokeReconcile(
    ctx: ReconciliationContext<z.infer<I>>,
  ): Promise<ReconcileResult<z.infer<O>>>;
};

const definedActions = new WeakSet<object>();

/** True only for values produced by this module's `defineAction`. */
export function isDefinedAction(value: unknown): value is DefinedAction {
  return typeof value === "object" && value !== null &&
    definedActions.has(value);
}

const encoder = new TextEncoder();

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        ),
      );
    }
    return v;
  });
}

/** Parsing strips unknown keys; a lossy parse means the handler leaked undeclared data. */
function assertLossless(
  raw: unknown,
  parsed: unknown,
  kind: "output" | "reconcile-result",
) {
  if (canonical(raw) !== canonical(parsed)) {
    throw new IntegrationContractError(
      kind,
      `${kind} carries fields outside the declared schema`,
    );
  }
}

/**
 * Defines one versioned action. Audits input/output descriptions and the
 * strict-object input root; manifest-dependent parity is checked at activation.
 */
export function defineAction<I extends z.ZodObject, O extends z.ZodType>(
  source: ActionDefinition<I, O>,
): DefinedAction<I, O> {
  // Snapshot the audited members: later mutation of `source` must not change behavior.
  const definition: ActionDefinition<I, O> = Object.freeze({
    ...source,
    input: source.input,
    output: source.output,
    execute: source.execute,
    ...(source.reconcile ? { reconcile: source.reconcile } : {}),
  });
  const defects = [
    ...(isStrictObject(definition.input) ? [] : [{
      code: "input-not-strict",
      path: `${definition.id}@${definition.version}.input`,
      message: "action input root must be z.strictObject",
    }]),
    ...findSchemaDescriptionDefects(
      definition.input,
      `${definition.id}@${definition.version}.input`,
    ).map((d) => ({
      code: `description-${d.kind}`,
      path: d.path,
      message: "schema node lacks a meaningful description",
    })),
    ...findSchemaDescriptionDefects(
      definition.output,
      `${definition.id}@${definition.version}.output`,
    ).map((d) => ({
      code: `description-${d.kind}`,
      path: d.path,
      message: "schema node lacks a meaningful description",
    })),
  ];
  if (defects.length) throw new IntegrationActivationError(defects);

  const max = definition.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const reconcileUnion = definition.reconcile
    ? z.discriminatedUnion("status", [
      z.strictObject({
        status: z.literal("confirmed").describe(
          "Discriminator for a confirmed recovery outcome.",
        ),
        result: definition.output,
      }).describe(
        "Recovery found the effect applied; carries the action output.",
      ),
      z.strictObject({
        status: z.literal("uncertain").describe(
          "Discriminator for an unproven recovery outcome.",
        ),
      }).describe(
        "Recovery could not prove the effect applied or absent.",
      ),
    ]).describe("Strict recovery result: confirmed with output, or uncertain.")
    : undefined;

  const defined: DefinedAction<I, O> = Object.freeze({
    ...definition,
    maxOutputBytes: max,
    async invoke(ctx: ActionContext, raw: unknown) {
      const parsedInput = definition.input.safeParse(raw);
      if (!parsedInput.success) {
        throw new IntegrationContractError(
          "input",
          `invalid input for ${definition.id}@${definition.version}`,
        );
      }
      const out = await definition.execute(ctx, parsedInput.data);
      const parsedOut = definition.output.safeParse(out);
      if (!parsedOut.success) {
        throw new IntegrationContractError(
          "output",
          `invalid output for ${definition.id}@${definition.version}`,
        );
      }
      assertLossless(out, parsedOut.data, "output");
      if (encoder.encode(canonical(parsedOut.data)).length > max) {
        throw new IntegrationContractError(
          "output-size",
          `output exceeds ${max} bytes`,
        );
      }
      return parsedOut.data as z.infer<O>;
    },
    async invokeReconcile(ctx: ReconciliationContext<z.infer<I>>) {
      if (!definition.reconcile || !reconcileUnion) {
        throw new IntegrationContractError(
          "reconcile-result",
          `${definition.id}@${definition.version} has no reconcile handler`,
        );
      }
      const raw = await definition.reconcile(ctx);
      const parsed = reconcileUnion.safeParse(raw);
      if (!parsed.success) {
        throw new IntegrationContractError(
          "reconcile-result",
          "reconcile result is not {status:'confirmed',result}|{status:'uncertain'}",
        );
      }
      assertLossless(raw, parsed.data, "reconcile-result");
      return parsed.data as ReconcileResult<z.infer<O>>;
    },
  });
  definedActions.add(defined);
  return defined;
}
