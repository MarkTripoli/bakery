import { handleRequestsOnTarget } from "../../work/run-requests.ts";
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
import { loadVersion } from "./rows.ts";
import { searchMentionCandidates } from "../../conversation/mentions.ts";
import { requireWorkTransaction } from "../../work/work-transaction.ts";
import type { OrganizationBlobStore } from "../../catalog/storage-port.ts";

export function registerCommentActions(
  registry: ActionRegistry,
  secret: string,
  /**
   * Where a blob-backed version's bytes come from. Absent, a version with no
   * inline content reads as having none, which is what every caller saw before
   * versions could name a blob.
   */
  blobStore?: OrganizationBlobStore,
): void {
  const list = commentQueries(secret, blobStore);
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
    handler: async (context, input) => {
      const comment = await createComment(context, input, blobStore);
      // The request that asked for this review is handled (#456 2b).
      const { transaction, organizationId, principalId } =
        requireWorkTransaction(context);
      await handleRequestsOnTarget(
        transaction,
        organizationId,
        principalId,
        "review",
        context.params.id,
      );
      return comment;
    },
  });
  registry.register({
    name: "artifactComments.update",
    method: HttpMethod.Patch,
    path: "/v1/artifact-comments/:id",
    input: contractSchemas.ArtifactCommentUpdate,
    output: contractSchemas.ArtifactComment,
    policy: write,
    handler: (context, input) => updateComment(context, input, blobStore),
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
    name: "artifactComments.mentionCandidates",
    method: HttpMethod.Get,
    path: "/v1/artifact-versions/:id/mention-candidates",
    input: contractSchemas.MentionCandidateQuery,
    output: contractSchemas["Page<MentionCandidate>"],
    policy: read,
    handler: async (context, input) => {
      const work = requireWorkTransaction(context);
      // Resolves the version inside the caller's organization or 404s.
      const version = await loadVersion(work, context.params.id);
      return await searchMentionCandidates(context, work.transaction, {
        action: "artifactComments.mentionCandidates",
        secret,
        scope: {
          kind: "comment_thread",
          conversationId: version.conversation_id,
          artifactId: version.artifact_id,
        },
        scopeId: version.id,
        query: input,
      });
    },
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
