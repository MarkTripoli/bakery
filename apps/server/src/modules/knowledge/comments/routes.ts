import {
  ActionKind,
  type ActionRegistry,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { createComment, updateComment } from "./store.ts";
import { commentQueries } from "./queries.ts";

export function registerCommentActions(
  registry: ActionRegistry,
  secret: string,
): void {
  const list = commentQueries(secret);
  const read = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;
  const write = { ...read, type: ActionKind.Command } as const;
  registry.register({
    name: "artifactComments.create",
    method: HttpMethod.Post,
    path: "/v1/artifact-versions/:id/comments",
    input: contractSchemas.ArtifactCommentCreate,
    output: contractSchemas.ArtifactComment,
    policy: write,
    handler: createComment,
  });
  registry.register({
    name: "artifactComments.update",
    method: HttpMethod.Patch,
    path: "/v1/artifact-comments/:id",
    input: contractSchemas.ArtifactCommentUpdate,
    output: contractSchemas.ArtifactComment,
    policy: write,
    handler: updateComment,
  });
  registry.register({
    name: "artifactComments.list",
    method: HttpMethod.Get,
    path: "/v1/artifact-versions/:id/comments",
    input: contractSchemas.CommentQuery,
    output: contractSchemas["Page<ArtifactComment>"],
    policy: read,
    handler: (context, input) => list(context, input, false),
  });
  registry.register({
    name: "artifactComments.listAcrossVersions",
    method: HttpMethod.Get,
    path: "/v1/artifacts/:id/comments",
    input: contractSchemas.CommentQuery,
    output: contractSchemas["Page<ArtifactComment>"],
    policy: read,
    handler: (context, input) => list(context, input, true),
  });
}
