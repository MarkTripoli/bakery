import {
  SealedCredentialOperationSchema,
  SecretIdentityToolResultSchema,
} from "../../../packages/contracts/src/secret-identity.ts";
import type { WorkerApiClient } from "./client.ts";
import type { ExecutionOutcome } from "./executor.ts";
import type { JobAssignment } from "./types.ts";

export type PreparedSecretAuthority = {
  workerSessionId: string;
  workerSessionGeneration: string;
};

export class PreparedSecretInvocationError extends Error {
  override readonly name = "PreparedSecretInvocationError";

  constructor(cause: unknown) {
    super("PREPARED_SECRET_INVOCATION_UNPUBLISHED", { cause });
  }
}

export type PreparedSecretInvoker = {
  invoke(
    assignment: JobAssignment,
    authority: PreparedSecretAuthority,
    signal: AbortSignal,
  ): Promise<ExecutionOutcome>;
};

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (
      entry === null || typeof entry === "string" ||
      typeof entry === "boolean"
    ) return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry).sort().flatMap((key) => {
          const child = (entry as Record<string, unknown>)[key];
          return child === undefined ? [] : [[key, normalize(child)]];
        }),
      );
    }
    throw new Error("PREPARED_SECRET_INPUT_INVALID");
  };
  return JSON.stringify(normalize(value));
}

async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value)),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPreparedSecretInvoker(
  client: WorkerApiClient,
): PreparedSecretInvoker {
  return Object.freeze({
    async invoke(assignment, authority, signal) {
      try {
        if (assignment.action !== "secret.identity.read") {
          throw new Error("PREPARED_SECRET_ACTION_INVALID");
        }
        const operation = SealedCredentialOperationSchema.parse(
          assignment.sealedCredentialOperation,
        );
        if (
          operation.jobId !== assignment.jobId ||
          operation.attemptId !== assignment.attemptId ||
          operation.inputDigest !== await digest(assignment.input)
        ) throw new Error("PREPARED_SECRET_BINDING_INVALID");
        const response = await client.invokePreparedSecretTool(
          assignment.attemptId,
          operation,
          {
            leaseToken: assignment.leaseToken,
            fence: String(assignment.fence),
            workerSessionId: authority.workerSessionId,
            workerSessionGeneration: authority.workerSessionGeneration,
          },
          signal,
        );
        return {
          status: "completed",
          result: SecretIdentityToolResultSchema.parse(response.value),
        };
      } catch (error) {
        if (error instanceof PreparedSecretInvocationError) throw error;
        throw new PreparedSecretInvocationError(error);
      }
    },
  });
}
