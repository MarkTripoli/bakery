import type { Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { BROKER_MAX_REQUEST_BYTES } from "../catalog/plugin-broker.ts";
import { jsonResponse, readBoundedText } from "./http.ts";
import { type ExecutionRouteOptions } from "./shared.ts";
import { authorizePluginAttempt } from "./plugin-attempt.ts";

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
  const attempt = await authorizePluginAttempt(context, options);
  // Streamed with a cap, so a chunked body with no declared length is cut off
  // at the limit instead of being buffered whole and measured afterwards.
  const body = await readBoundedText(context, BROKER_MAX_REQUEST_BYTES);

  const outcome = await broker.callAs({
    claims: {
      organizationId: attempt.organizationId,
      installId: attempt.installId,
      versionId: attempt.versionId,
      jobId: attempt.jobId,
      // Stable for the attempt and fence, so sequence, rate and replay state
      // persist across its calls and a new fence starts clean.
      tokenId: `attempt:${attempt.attemptId}:${attempt.fence}`,
      issuedAt: 0,
      expiresAt: attempt.leaseExpiresAt,
    },
    body,
  });
  // The catalogued contract is flat, with explicit nulls, so a client needs no
  // custom union: exactly one of `result` and `denial` is non-null.
  return jsonResponse(
    outcome.ok
      ? {
        ok: true,
        result: outcome.result ?? null,
        replayed: outcome.replayed,
        denial: null,
      }
      : { ok: false, result: null, replayed: null, denial: outcome.denial },
    200,
  );
}
