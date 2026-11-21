import type { Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { BROKER_MAX_REQUEST_BYTES } from "../catalog/plugin-broker.ts";
import { sha256Hex } from "../../platform/canonical-json.ts";
import { assertActiveLease, lockAttempt } from "./events.ts";
import { jsonResponse } from "./http.ts";
import {
  assertAttemptMutationSession,
  assertCurrentWorkerSession,
  assertWorkerMutationSessionShape,
  type ExecutionRouteOptions,
  readAttemptId,
  workerTransaction,
} from "./shared.ts";

/**
 * `POST /v1/worker/attempts/{id}/plugin-broker` (#29, B14.02).
 *
 * A contained plugin job has no network, so it talks to its worker over stdio
 * and the worker relays each request here. This route is the only way those
 * requests reach the broker, and it decides who they are for.
 *
 * The caller is the worker host, authenticated by its session and by the
 * attempt's lease token and fence. The install and organization the request
 * acts for come from the job row the server wrote, never from the request, so
 * a worker host cannot point a job at another install. No broker token exists
 * on the wire or on the worker: the server builds the claims itself and calls
 * the broker as that attempt.
 */

const PLUGIN_JOB_ACTION = "plugin.job";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JobRow = { action: string; input: unknown };

export async function pluginBrokerRelayRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const broker = options.pluginBroker;
  if (broker === undefined) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const declared = context.req.header("content-length");
  if (
    declared !== undefined &&
    (!/^\d+$/.test(declared) || Number(declared) > BROKER_MAX_REQUEST_BYTES)
  ) throw new StandardError({ code: "BODY_TOO_LARGE" });
  const attemptId = readAttemptId(context);
  const headers = context.req.raw.headers;
  const leaseToken = headers.get("X-Worker-Lease-Token") ?? "";
  const fence = headers.get("X-Worker-Fence") ?? "";
  const sessionId = headers.get("X-Worker-Session-Id") ?? "";
  const generation = headers.get("X-Worker-Session-Generation") ?? "";
  if (
    leaseToken.length === 0 || leaseToken.length > 512 ||
    !/^(?:0|[1-9][0-9]*)$/.test(fence) || !UUID.test(sessionId) ||
    !/^(?:0|[1-9][0-9]*)$/.test(generation)
  ) throw new StandardError({ code: "MALFORMED_REQUEST" });
  // Read bounded: the declared length can lie, so the text is measured too.
  const body = await context.req.text();
  if (new TextEncoder().encode(body).byteLength > BROKER_MAX_REQUEST_BYTES) {
    throw new StandardError({ code: "BODY_TOO_LARGE" });
  }
  const tokenHash = await sha256Hex(leaseToken);

  const attempt = await workerTransaction(
    options.database,
    headers,
    async (transaction, identity) => {
      assertWorkerMutationSessionShape(identity.host, sessionId, generation);
      // "no key update": a relay call only reads the attempt, so it must not
      // queue behind a result post or a lease renewal.
      const row = await lockAttempt(
        transaction,
        identity,
        attemptId,
        "no key update",
      );
      // The session the worker names must be the one it holds now and the one
      // this attempt was leased to; the shape check above only reads the header.
      assertCurrentWorkerSession(identity.host, sessionId, generation);
      assertAttemptMutationSession(identity.host, row, sessionId, generation);
      assertActiveLease(row, identity, tokenHash, fence);
      const job = await transaction.query<JobRow>(
        `select action, input from bakery.jobs
          where organization_id = $1 and id = $2`,
        [row.organization_id, row.job_id],
      );
      const found = job.rows[0];
      if (found === undefined || found.action !== PLUGIN_JOB_ACTION) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      const installId = (found.input as { installId?: unknown } | null)
        ?.installId;
      if (typeof installId !== "string" || !UUID.test(installId)) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      return {
        organizationId: row.organization_id,
        installId,
        jobId: row.job_id,
        leaseExpiresAt: Date.parse(String(row.lease_expires_at)),
      };
    },
  );

  const outcome = await broker.callAs({
    claims: {
      organizationId: attempt.organizationId,
      installId: attempt.installId,
      jobId: attempt.jobId,
      // Stable for the attempt and fence, so sequence, rate and replay state
      // persist across its calls and a new fence starts clean.
      tokenId: `attempt:${attemptId}:${fence}`,
      issuedAt: 0,
      expiresAt: attempt.leaseExpiresAt,
    },
    body,
  });
  return jsonResponse(outcome, 200);
}
