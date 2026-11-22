import type { Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { sha256Hex } from "../../platform/canonical-json.ts";
import { assertActiveLease, lockAttempt } from "./events.ts";
import {
  assertAttemptMutationSession,
  assertCurrentWorkerSession,
  assertWorkerMutationSessionShape,
  type ExecutionRouteOptions,
  readAttemptId,
  workerTransaction,
} from "./shared.ts";

/**
 * Who a worker is speaking for when it calls a plugin-job route (#29, B14.02).
 *
 * Both plugin-job routes, the broker relay and the file fetch, authorize the
 * same way: the worker host's session, the attempt's lease token and fence, and
 * the attempt's job being a `plugin.job`. The install and organization come
 * from the job row the server wrote, never from the request.
 */

export const PLUGIN_JOB_ACTION = "plugin.job";
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JobRow = { action: string; input: unknown };

export type PluginAttempt = Readonly<{
  attemptId: string;
  fence: string;
  organizationId: string;
  installId: string;
  /** The `entry` the job was admitted with: a path inside the install's bundle. */
  entry: string | null;
  /**
   * The plugin version the job was admitted with, when it named one: the bundle
   * the job runs is that version's, not whatever the install points at later.
   * Null for a job that named none, which runs the install's current version.
   */
  versionId: string | null;
  jobId: string;
  leaseExpiresAt: number;
}>;

export async function authorizePluginAttempt(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<PluginAttempt> {
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
  const tokenHash = await sha256Hex(leaseToken);

  return await workerTransaction(
    options.database,
    headers,
    async (transaction, identity) => {
      assertWorkerMutationSessionShape(identity.host, sessionId, generation);
      // "no key update": these calls only read the attempt, so they must not
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
      const input = found.input as
        | { installId?: unknown; entry?: unknown; versionId?: unknown }
        | null;
      const installId = input?.installId;
      if (typeof installId !== "string" || !UUID.test(installId)) {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      // A version the job names must be a well-formed id; one that is not is a
      // job nobody could have admitted, never a request to use the install's.
      const versionId = input?.versionId;
      if (
        versionId !== undefined && versionId !== null &&
        (typeof versionId !== "string" || !UUID.test(versionId))
      ) throw new StandardError({ code: "STATE_CONFLICT" });
      return {
        attemptId,
        fence,
        organizationId: row.organization_id,
        installId,
        entry: typeof input?.entry === "string" ? input.entry : null,
        versionId: typeof versionId === "string" ? versionId : null,
        jobId: row.job_id,
        leaseExpiresAt: Date.parse(String(row.lease_expires_at)),
      };
    },
  );
}
