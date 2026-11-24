import type { Context } from "hono";
import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import { jsonResponse } from "./http.ts";
import { claimAttempt, reassertAttempt } from "./attempt-claim.ts";
import {
  type ExecutionRouteOptions,
  readAttemptId,
  workerTransaction,
} from "./shared.ts";

/**
 * The lease proof a worker presents on a read, taken from headers rather than
 * a body: a GET carries no payload, and the proof must describe the attempt
 * that is asking, not something the caller can fold into a document.
 */
const WorkerReadProof = z.object({
  leaseToken: z.string().min(1).describe(
    "Lease token the worker was issued when it claimed this attempt; the route hashes it and compares to the stored hash.",
  ),
  fence: z.string().min(1).describe(
    "Attempt fence the worker holds; it must equal the job's current fence or the read is refused as superseded.",
  ),
  workerSessionId: z.string().min(1).describe(
    "Worker session that claimed the attempt; a different session is refused as fenced.",
  ),
  workerSessionGeneration: z.string().min(1).describe(
    "Generation of that worker session; a recycled session carrying an older generation is refused as fenced.",
  ),
}).describe(
  "Lease proof a worker presents as headers on the read of its attempt's pinned input context.",
);

function readProof(headers: Headers): z.infer<typeof WorkerReadProof> {
  const parsed = WorkerReadProof.safeParse({
    leaseToken: headers.get("X-Worker-Lease-Token") ?? undefined,
    fence: headers.get("X-Worker-Fence") ?? undefined,
    workerSessionId: headers.get("X-Worker-Session-Id") ?? undefined,
    workerSessionGeneration: headers.get("X-Worker-Session-Generation") ??
      undefined,
  });
  if (!parsed.success) {
    throw new StandardError({ code: "MALFORMED_REQUEST", cause: parsed.error });
  }
  return parsed.data;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type PinnedInputRow = {
  artifact_version_id: string;
  artifact_id: string;
  pinned_sha256: string;
  pinned_size_bytes: number;
  content: Uint8Array | null;
  sha256: string;
  size_bytes: number;
  media_type: string;
};

/**
 * Serves the exact bytes each declared input was pinned to at admission.
 *
 * The read is fenced by the same proof the write paths use, re-asserted after
 * the bytes are gathered: a read has no write to roll back, so the only safe
 * moment to decide the caller still holds the lease is the one just before the
 * answer is produced. A snapshot taken before the fence moved is not returned.
 */
let afterGatherForTest: (() => Promise<void> | void) | null = null;

/**
 * One-shot fixture seam between gathering the bytes and the re-assert.
 *
 * The window a read can go stale in exists only inside one transaction, and
 * that transaction holds the attempt and job rows, so no other connection can
 * move the fence underneath it. What a test CAN move is time: `lease_expired`
 * is compared against clock_timestamp() whenever the row is read, so a test can
 * shorten the lease, park the route here, and wait past the deadline. The first
 * assert then passes and only a re-assert after gathering can catch the lapse.
 * Deleting the re-assert turns that test red.
 */
export function setInputReadAfterGatherForTest(
  observe: (() => Promise<void> | void) | null,
): void {
  afterGatherForTest = observe;
}

export async function inputReadRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const proof = readProof(context.req.raw.headers);
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const claimed = await claimAttempt({
        transaction,
        identity,
        attemptId,
        proof,
      });

      const run = await transaction.query<{
        run_id: string;
        facts: unknown;
      }>(
        `select step.run_id,
                step.dispatch -> 'facts' as facts
           from bakery.jobs job
           join bakery.run_steps step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
          where job.organization_id = $1 and job.id = $2`,
        [identity.host.organization_id, claimed.jobId],
      );
      const runId = run.rows[0]?.run_id;
      if (!runId) throw new StandardError({ code: "INTERNAL" });

      // Scoped by this attempt's run, not by "the version exists": another
      // run's pins are not this run's context even in the same organization.
      const rows = await transaction.query<PinnedInputRow>(
        `select p.artifact_version_id, p.artifact_id,
                p.sha256 as pinned_sha256, p.size_bytes as pinned_size_bytes,
                v.content, v.sha256, v.size_bytes, v.media_type
           from bakery.run_input_pins p
           join bakery.artifact_versions v
             on v.organization_id = p.organization_id
            and v.id = p.artifact_version_id
          where p.organization_id = $1 and p.run_id = $2
          order by p.created_at asc, p.id asc`,
        [identity.host.organization_id, runId],
      );

      const items = [];
      for (const row of rows.rows) {
        if (row.content === null) {
          throw new StandardError({ code: "ARTIFACT_CONTENT_EXPIRED" });
        }
        const bytes = row.content instanceof Uint8Array
          ? row.content
          : new Uint8Array(row.content);
        const digest = await sha256Bytes(bytes);
        // Fail closed: the bytes must be the version that was pinned, at the
        // digest it had then. A mismatch is corruption, never a warning.
        if (
          digest !== row.pinned_sha256 || digits(row.size_bytes) !==
            digits(row.pinned_size_bytes)
        ) {
          throw new StandardError({ code: "PRECONDITION_FAILED" });
        }
        items.push({
          artifactVersionId: row.artifact_version_id,
          artifactId: row.artifact_id,
          digest,
          sizeBytes: row.size_bytes,
          mediaType: row.media_type,
          contentBase64: toBase64(bytes),
        });
      }

      const afterGather = afterGatherForTest;
      if (afterGather) {
        afterGatherForTest = null;
        await afterGather();
      }

      // Re-assert under the same lock, after gathering: the read only answers
      // while the lease it was asked under still holds.
      await reassertAttempt(claimed);

      const facts = readRecordedFacts(run.rows[0]?.facts);
      return { attemptId, runId, inputs: items, facts };
    },
  );
  return jsonResponse(result, 200);
}

function readRecordedFacts(
  recorded: unknown,
):
  | { facts: Array<{ wording: string; recordedAt: string }>; omitted: number }
  | null {
  if (recorded === null || typeof recorded !== "object") return null;
  const entries = (recorded as { facts?: unknown }).facts;
  const omitted = (recorded as { omitted?: unknown }).omitted;
  if (!Array.isArray(entries) || typeof omitted !== "number") return null;
  const facts: Array<{ wording: string; recordedAt: string }> = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const wording = (entry as { wording?: unknown }).wording;
    const recordedAt = (entry as { recordedAt?: unknown }).recordedAt;
    if (typeof wording !== "string" || typeof recordedAt !== "string") {
      continue;
    }
    facts.push({ wording, recordedAt });
  }
  return { facts, omitted };
}

function digits(value: number | string): string {
  return String(Number(value));
}
