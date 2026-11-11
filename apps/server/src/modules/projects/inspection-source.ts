import { REPOSITORY_INSPECTION_LIMITS as LIMITS } from "@bakery/config";
import type { Context } from "hono";
import { RepositoryInspectionSourceChunkSchema } from "@bakery/contracts/repository-inspection";
import { StandardError } from "@bakery/contracts/http";
import { assertActiveLease, lockAttempt } from "../execution/events.ts";
import { jsonResponse } from "../execution/http.ts";
import {
  assertAttemptMutationSession,
  type ExecutionRouteOptions,
  readAttemptId,
  sha256Hex,
  workerTransaction,
} from "../execution/shared.ts";
import { inspectionReceipt, loadInspection } from "./inspection-publication.ts";

function integer(
  value: string | undefined,
  maximum: number,
  minimum: number,
): number {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  return parsed;
}

export async function repositoryInspectionSourceRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const url = new URL(context.req.url);
  if (
    [...url.searchParams.keys()].some((key) =>
      key !== "offset" && key !== "maxBytes"
    ) ||
    url.searchParams.getAll("offset").length !== 1 ||
    url.searchParams.getAll("maxBytes").length !== 1
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const offset = integer(context.req.query("offset"), LIMITS.envelopeBytes, 0);
  const maximum = integer(context.req.query("maxBytes"), LIMITS.chunkBytes, 1);
  const token = context.req.header("X-Worker-Lease-Token");
  const fence = context.req.header("X-Worker-Fence");
  const sessionId = context.req.header("X-Worker-Session-Id");
  const generation = context.req.header("X-Worker-Session-Generation");
  if (
    !token || token.length > 512 || !fence || !generation || !sessionId ||
    !/^[1-9][0-9]{0,19}$/.test(fence) || !/^[1-9][0-9]{0,19}$/.test(generation)
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const tokenHash = await sha256Hex(token);
  const chunk = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const attempt = await lockAttempt(transaction, identity, attemptId);
      assertAttemptMutationSession(
        identity.host,
        attempt,
        sessionId,
        generation,
      );
      assertActiveLease(attempt, identity, tokenHash, fence);
      const job = await transaction.query<
        { status: string; cancel_requested_at: Date | null }
      >(
        `select status, cancel_requested_at from bakery.jobs
        where organization_id = $1 and id = $2 and action = 'repository.inspect' for update`,
        [attempt.organization_id, attempt.job_id],
      );
      if (!job.rows[0]) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (
        job.rows[0].cancel_requested_at !== null ||
        !["leased", "running"].includes(job.rows[0].status)
      ) {
        throw new StandardError({ code: "CANCEL_REQUESTED" });
      }
      const { row, input } = await loadInspection(transaction, attempt);
      const receipt = await inspectionReceipt(transaction, attempt, input);
      const bytes = new TextEncoder().encode(row.source_envelope);
      if (
        bytes.length !== input.source.envelopeBytes ||
        await sha256Hex(row.source_envelope) !== input.source.envelopeDigest ||
        offset >= bytes.length ||
        (row.source_attempt_id !== null && row.source_attempt_id !== attempt.id)
      ) {
        throw new StandardError({ code: "VALIDATION_FAILED" });
      }
      const end = Math.min(offset + maximum, bytes.length);
      if (
        offset > row.source_next_offset ||
        (offset < row.source_next_offset && end > row.source_next_offset)
      ) {
        throw new StandardError({ code: "EXPECTED_SEQUENCE" });
      }
      const slice = bytes.subarray(offset, end);
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", slice),
      );
      const chunkDigest = [...digest].map((byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      let binary = "";
      for (const byte of slice) binary += String.fromCharCode(byte);
      if (offset === row.source_next_offset) {
        await transaction.query(
          `update bakery.repository_onboardings set source_attempt_id = $3, source_next_offset = $4
          where organization_id = $1 and id = $2`,
          [attempt.organization_id, row.id, attempt.id, end],
        );
      }
      return RepositoryInspectionSourceChunkSchema.parse({
        receipt,
        offset,
        totalBytes: bytes.length,
        chunkDigest,
        bytesBase64: btoa(binary),
        done: end === bytes.length,
      });
    },
  );
  const response = jsonResponse(chunk, 200);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
