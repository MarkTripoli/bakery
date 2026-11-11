import { ActionKind, HttpMethod } from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";

/**
 * The one `artifactVersions.content` action definition. The application
 * registry and the preview host registry both register it, so the content
 * policy cannot diverge between the two. The handler is never called: each
 * caller runs the authority with its own read function.
 */
export const artifactContentActionDefinition = {
  name: "artifactVersions.content",
  method: HttpMethod.Get,
  path: "/v1/artifact-versions/:id/content",
  input: contractSchemas.ContentRangeQuery,
  output: contractSchemas.BinaryArtifact,
  policy: {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  },
  handler: () => {
    throw new StandardError({ code: "INTERNAL" });
  },
} as const;
