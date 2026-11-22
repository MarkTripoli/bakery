import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { appendAudit } from "@bakery/persistence/event-audit";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import {
  PREVIEW_ORIGIN_NOT_CONFIGURED,
  RUNNING_PREVIEW_EXCHANGE_PATH,
  runningPreviewOrigin,
} from "./shared.ts";
import {
  insertAccessGrant,
  listPreviews,
  readAccessGrantOwner,
  readPreview,
  readRouteKey,
  revokeAccessGrant,
  stopPreview,
} from "./running-store.ts";

export type RunningPreviewDependencies = {
  /** Validated preview origin, absent when unconfigured. */
  readonly previewOrigin?: string;
  /** Signs list cursors. */
  readonly secret: string;
};

/** The default length of a signed-in preview session. */
export const DEFAULT_PREVIEW_SESSION_SECONDS = 3600;

export function runningPreviewAvailability(
  dependencies: RunningPreviewDependencies,
): { available: boolean } {
  return { available: dependencies.previewOrigin !== undefined };
}

export async function listRunningPreviews(
  context: ActionContext,
  input: { runId?: string; status?: string; cursor?: string; limit?: number },
  dependencies: RunningPreviewDependencies,
) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  return await listPreviews(
    transaction,
    { organizationId, principalId },
    input,
    dependencies.secret,
  );
}

/**
 * Issues a one-use grant. It is exchangeable for 30 seconds whatever session
 * length was asked for; that length only decides how long the session lasts
 * once the grant is exchanged. Only a preview that is running now is opened.
 */
export async function createRunningPreviewAccess(
  context: ActionContext,
  input: { sessionSeconds?: number },
  dependencies: RunningPreviewDependencies,
) {
  const origin = dependencies.previewOrigin;
  if (origin === undefined) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: PREVIEW_ORIGIN_NOT_CONFIGURED },
    });
  }
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const previewId = context.params.id;
  const preview = await readPreview(transaction, organizationId, previewId);
  if (!preview) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (preview.status !== "ready") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "preview_not_running", status: preview.status },
    });
  }
  const routeKey = await readRouteKey(transaction, organizationId, previewId);
  if (routeKey === null) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  const previewOrigin = runningPreviewOrigin(origin, routeKey);
  const sessionSeconds = input.sessionSeconds ??
    DEFAULT_PREVIEW_SESSION_SECONDS;
  const grant = await insertAccessGrant(transaction, {
    organizationId,
    previewId,
    principalId,
    sessionSeconds,
  });
  // The audit record names the grant id only: never the secret.
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "previews.access",
    resourceType: "preview",
    resourceId: previewId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { grantId: grant.grantId, sessionSeconds },
  });
  return {
    grantId: grant.grantId,
    grant: grant.secret,
    // The grant is posted to the preview's own origin and nowhere else.
    exchangeUrl: `${previewOrigin}${RUNNING_PREVIEW_EXCHANGE_PATH}`,
    previewUrl: `${previewOrigin}/`,
    expiresAt: grant.expiresAt,
    sessionSeconds,
  };
}

/** Stops a preview for everyone and ends every open session of it. */
export async function stopRunningPreview(context: ActionContext) {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const outcome = await stopPreview(
    transaction,
    organizationId,
    principalId,
    context.params.id,
    context.traceId,
  );
  if (outcome.kind === "missing") {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (outcome.kind === "stopped") {
    await appendAudit(transaction, {
      organizationId,
      principalId,
      operation: "previews.stop",
      resourceType: "preview",
      resourceId: context.params.id,
      requestId: context.requestId,
      traceId: context.traceId,
      details: {},
    });
  }
  return outcome.preview;
}

/**
 * Ends one person's access to a preview. Only the person the grant was issued
 * to may; anyone else gets the same answer as for a grant that does not exist.
 */
export async function revokeRunningPreviewAccess(
  context: ActionContext,
): Promise<null> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const grantId = context.params.id;
  const owner = await readAccessGrantOwner(
    transaction,
    organizationId,
    grantId,
  );
  if (!owner || owner.principalId !== principalId) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (owner.revoked) return null;
  await revokeAccessGrant(transaction, organizationId, grantId);
  await appendAudit(transaction, {
    organizationId,
    principalId,
    operation: "previews.revokeAccess",
    resourceType: "preview_grant",
    resourceId: grantId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { previewId: owner.previewId },
  });
  return null;
}
