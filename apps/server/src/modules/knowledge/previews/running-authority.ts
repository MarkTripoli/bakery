import {
  type ActionAuthorityRunner,
  type ActionContext,
  ActionKind,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { PreviewImplementedAction } from "@bakery/contracts/implemented-actions";
import type { PgDatabase } from "../../../platform/database.ts";

/**
 * The `previews.access` policy, as the preview host re-asks it. The handler is
 * never called: the host runs the authority with its own function, so what the
 * grantor may do is decided by the same live organization authority (role,
 * custom role, membership) that issued the grant, not by a copy of it.
 */
export const runningPreviewAccessActionDefinition = {
  name: PreviewImplementedAction.PreviewsAccess,
  method: HttpMethod.Post,
  path: "/v1/previews/:id/access",
  input: contractSchemas.PreviewAccess,
  output: contractSchemas.PreviewAccessResult,
  policy: {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  },
  handler: () => {
    throw new StandardError({ code: "INTERNAL" });
  },
} as const;

/** True while the grantor may still open previews of this organization. */
export type RunningPreviewReauthorizer = (
  organizationId: string,
  principalId: string,
  signal: AbortSignal,
) => Promise<boolean>;

const REFUSALS = new Set([
  "AUTH_FORBIDDEN",
  "RESOURCE_NOT_FOUND",
  "SCOPE_REQUIRED",
  "INSUFFICIENT_SCOPE",
]);

/**
 * Re-asks the live authority as the grantor, on every exchange and every
 * proxied request. No cookie or header of the person is read: only the
 * grantor's organization is named, as the artifact preview host does.
 */
export function createRunningPreviewReauthorizer(
  database: PgDatabase,
  authority: ActionAuthorityRunner,
  action: Parameters<ActionAuthorityRunner["run"]>[0],
): RunningPreviewReauthorizer {
  return async (organizationId, principalId, signal) => {
    const subject = await database.query<{
      id: string;
      principal_type: string;
      display_name: string;
    }>(
      `select id, principal_type, display_name from bakery.principals
        where id = $1 and disabled_at is null`,
      [principalId],
    );
    const principal = subject.rows[0];
    if (!principal) return false;
    const synthetic: ActionContext = {
      request: new Request("http://running-preview.invalid/", {
        headers: { "Bakery-Organization-Id": organizationId },
      }),
      params: {},
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      signal,
      principal: {
        principalId: principal.id,
        principalType: principal.principal_type,
        displayName: principal.display_name,
      },
    };
    try {
      await authority.run(action, synthetic, {}, () => Promise.resolve(true));
      return true;
    } catch (error) {
      if (error instanceof StandardError && REFUSALS.has(error.code)) {
        return false;
      }
      throw error;
    }
  };
}
