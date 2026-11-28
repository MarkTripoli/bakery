import { z } from "zod";
import { type AttemptProof, attemptProofOf } from "./client.ts";
import type { ExecutionOutcome, WorkerExecutor } from "./executor.ts";
import type { JobAssignment } from "./types.ts";

export const ModelKeySchema = z.object({
  provider: z.enum(["anthropic", "openai", "openrouter"]).describe(
    "The model provider the key belongs to.",
  ),
  apiKey: z.string().min(1).max(4096).describe(
    "The metered model API key the coding agent pays with.",
  ),
}).strict().describe(
  "The model API key the server hands to the worker holding the attempt's lease.",
);
export type ModelKey = z.infer<typeof ModelKeySchema>;

export type ReadModelKey = (
  attemptId: string,
  proof: AttemptProof,
) => Promise<ModelKey>;

export type AttemptModelKeys = Readonly<{
  read: ReadModelKey;
  forget: (attemptId: string) => void;
}>;

export function readOncePerAttempt(read: ReadModelKey): AttemptModelKeys {
  const remembered = new Map<string, Promise<ModelKey>>();
  return {
    read: (attemptId, proof) => {
      const key = `${attemptId}:${proof.fence}`;
      const known = remembered.get(key);
      if (known !== undefined) return known;
      const pending = read(attemptId, proof);
      remembered.set(key, pending);
      pending.catch(() => remembered.delete(key));
      return pending;
    },
    forget: (attemptId) => {
      for (const key of [...remembered.keys()]) {
        if (key.startsWith(`${attemptId}:`)) remembered.delete(key);
      }
    },
  };
}

export function forgetModelKeyWhenAttemptEnds(
  executor: WorkerExecutor,
  keys: AttemptModelKeys,
): WorkerExecutor {
  return {
    ...executor,
    attemptEnded(attemptId) {
      executor.attemptEnded?.(attemptId);
      keys.forget(attemptId);
    },
  };
}

export type MeteredModelKey = Readonly<{
  environment: Readonly<Record<string, string>>;
  secrets: readonly string[];
}>;

export type ModelKeyVariables = Readonly<
  Partial<Record<ModelKey["provider"], string>>
>;

export class ModelKeyUnavailable extends Error {
  override readonly name = "ModelKeyUnavailable";
}

export function paysWithApiKey(assignment: JobAssignment): boolean {
  return assignment.billing?.billingRoute === "api";
}

export async function meteredModelKey(
  assignment: JobAssignment,
  read: ReadModelKey | undefined,
  variables: ModelKeyVariables,
): Promise<MeteredModelKey | null> {
  if (!paysWithApiKey(assignment)) return null;
  const proof = attemptProofOf(assignment);
  if (read === undefined || proof === null) throw new ModelKeyUnavailable();
  let key: ModelKey;
  try {
    key = await read(assignment.attemptId, proof);
  } catch (error) {
    throw new ModelKeyUnavailable(undefined, { cause: error });
  }
  const variable = variables[key.provider];
  if (variable === undefined) throw new ModelKeyUnavailable();
  return { environment: { [variable]: key.apiKey }, secrets: [key.apiKey] };
}

export type HarnessCredentials =
  | Readonly<{
    ok: true;
    secrets: readonly string[];
    environment: Readonly<Record<string, string>>;
  }>
  | Readonly<{ ok: false; outcome: ExecutionOutcome }>;

export async function harnessCredentials(input: {
  assignment: JobAssignment;
  readModelKey: ReadModelKey | undefined;
  variables: ModelKeyVariables;
  prepareNative: () => Promise<void>;
  nativeSecrets: () => Promise<readonly string[]>;
  unavailable: () => ExecutionOutcome;
  nativeUnavailableMessage: string;
  nativeFailed: () => ExecutionOutcome;
}): Promise<HarnessCredentials> {
  const unavailable = (): HarnessCredentials => ({
    ok: false,
    outcome: input.unavailable(),
  });
  let metered: MeteredModelKey | null;
  try {
    metered = await meteredModelKey(
      input.assignment,
      input.readModelKey,
      input.variables,
    );
  } catch {
    return unavailable();
  }
  if (metered !== null) {
    return {
      ok: true,
      secrets: metered.secrets,
      environment: metered.environment,
    };
  }
  try {
    await input.prepareNative();
  } catch (error) {
    if (
      error instanceof Error && error.message === input.nativeUnavailableMessage
    ) return unavailable();
    return { ok: false, outcome: input.nativeFailed() };
  }
  try {
    return { ok: true, secrets: await input.nativeSecrets(), environment: {} };
  } catch {
    return unavailable();
  }
}
