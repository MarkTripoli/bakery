import type {
  ActionContext,
  ActionRegistry,
} from "@bakery/contracts/action-registry";
import { AuthImplementedAction } from "@bakery/contracts/implemented-actions";
import { getTraceId } from "@bakery/contracts/http";
import { callerTraceparent, type McpCallTrace } from "./trace.ts";
import type { McpGrant } from "./guard.ts";
import { McpTool } from "./scopes.ts";

/** Header the authority runner reads to scope an action to one organization. */
const ORGANIZATION_HEADER = "Bakery-Organization-Id";
const TOOL_DEADLINE_MS = 15_000;

/** Operation each tool runs; both go through the same registry the HTTP routes use. */
const TOOL_ACTION: Readonly<Record<McpTool, string>> = Object.freeze({
  [McpTool.Whoami]: AuthImplementedAction.IdentityGet,
  [McpTool.OrganizationGet]: AuthImplementedAction.OrganizationsGet,
});

export type McpToolRunner = {
  run(tool: McpTool, grant: McpGrant, trace?: McpCallTrace): Promise<unknown>;
};

/**
 * Runs a tool as the grant's person, bound to the grant's one organization.
 * The registry and its authority runner decide what the person may do, so a
 * scope can only narrow that, never widen it.
 */
export function createMcpToolRunner(options: {
  publicOrigin: string;
  registry: ActionRegistry;
  /** The authenticated subject the registry expects, loaded live for the provider user. */
  loadSubject(providerUserId: string): Promise<unknown>;
}): McpToolRunner {
  const origin = new URL(options.publicOrigin).origin;
  return {
    async run(tool, grant, trace) {
      const principal = await options.loadSubject(grant.providerUserId);
      const isOrganization = tool === McpTool.OrganizationGet;
      const path = isOrganization
        ? `/v1/organizations/${grant.organizationId}`
        : "/v1/me";
      // The call continues its caller's trace: the registry reads the trace id
      // from this request, so a tool call joins the run it belongs to.
      const traceparent = callerTraceparent(trace);
      const request = new Request(`${origin}${path}`, {
        headers: {
          [ORGANIZATION_HEADER]: grant.organizationId,
          ...(traceparent === undefined ? {} : { traceparent }),
        },
      });
      const context: ActionContext = {
        request,
        params: isOrganization ? { id: grant.organizationId } : {},
        requestId: crypto.randomUUID(),
        traceId: getTraceId(request),
        signal: AbortSignal.timeout(TOOL_DEADLINE_MS),
        principal,
      };
      return await options.registry.execute(
        TOOL_ACTION[tool],
        context,
        isOrganization ? { id: grant.organizationId } : {},
      );
    },
  };
}
