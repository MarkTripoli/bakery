import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import {
  type ArtifactCommentComposerModel,
  ArtifactDiscussionView,
} from "./ArtifactDiscussionView.tsx";
import type {
  ArtifactCommentResponse,
  ArtifactResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  artifactCommentsQueryOptions,
  effectiveAccessQueryOptions,
  userProfileQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ArtifactAnchorDescription } from "./ArtifactCommentAnchor.tsx";
import { ArtifactCommentEditor } from "./ArtifactCommentEditor.tsx";

export function ArtifactCommentThread(
  {
    root,
    artifact,
    viewVersionId,
    selected,
    busy,
    onSelect,
    onReply,
    onResolve,
    onUpdated,
    composer,
  }: {
    readonly composer?: ArtifactCommentComposerModel;
    readonly root: ArtifactCommentResponse;
    readonly artifact: ArtifactResponse;
    readonly viewVersionId: string;
    readonly selected: boolean;
    readonly busy: boolean;
    readonly onSelect: (value: boolean) => void;
    readonly onReply: () => void;
    readonly onResolve: () => void;
    readonly onUpdated: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const profile = useQuery(userProfileQueryOptions(api, scope));
  const access = useQuery({
    ...effectiveAccessQueryOptions(api, scope),
    enabled: scope.organizationId !== null,
  });
  const canEdit = (comment: ArtifactCommentResponse) =>
    !comment.deletedAt &&
    ((!profile.isError && profile.data?.principalId === comment.authorId) ||
      (!access.isError && access.data?.role === "admin"));
  const options = artifactCommentsQueryOptions(
    api,
    scope,
    root.artifactVersionId,
    { rootId: root.id, viewVersionId },
  );
  const replies = useInfiniteQuery({
    queryKey: [...options.queryKey, "pages"],
    initialPageParam: undefined as string | undefined,
    enabled: expanded && scope.organizationId !== null,
    retry: false,
    queryFn: async ({ pageParam, signal }) => {
      if (!scope.organizationId) throw new Error("ORGANIZATION_REQUIRED");
      const result = await api.listArtifactComments({
        organizationId: scope.organizationId,
        versionId: root.artifactVersionId,
        rootId: root.id,
        viewVersionId,
        cursor: pageParam,
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  useEffect(() => {
    if (expanded) void replies.refetch();
  }, [expanded, root.version, replies.refetch]);
  return (
    <UI.Stack gap="compact" id={`comment-${root.id}`} tabIndex={-1}>
      <ArtifactDiscussionView
        composer={composer}
        title={t("artifact.comments.discussion")}
        author={root.authorId}
        initials={root.authorId.slice(0, 2).toUpperCase()}
        timestamp={root.createdAt}
        body={root.deletedAt ? t("artifact.comments.deleted") : root.body}
        location={root.artifactVersionId !== viewVersionId
          ? t("artifact.comments.fromRevision")
          : ""}
        state={root.deletedAt
          ? "deleted"
          : root.placement?.status === "outdated"
          ? "outdated"
          : root.status === "resolved"
          ? "resolved"
          : "open"}
        notice={root.placement?.status === "outdated"
          ? t("artifact.comments.outdated")
          : t(
            root.status === "resolved"
              ? "artifact.comments.resolved"
              : "artifact.comments.open",
          )}
        replies={expanded && !replies.isError
          ? (replies.data?.pages.flatMap((page) => page.items) ?? []).map((
            item,
          ) => ({
            id: item.id,
            author: item.authorId,
            body: (
              <>
                <UI.Text>
                  {item.deletedAt ? t("artifact.comments.deleted") : item.body}
                </UI.Text>
                {canEdit(item)
                  ? (
                    <ArtifactCommentEditor
                      comment={item}
                      onUpdated={() => {
                        onUpdated();
                        void replies.refetch();
                      }}
                    />
                  )
                  : null}
              </>
            ),
          }))
          : []}
        replyAction={{
          label: t("artifact.comments.reply"),
          onClick: onReply,
          disabled: busy,
          pressed: composer !== undefined,
        }}
        resolveAction={root.deletedAt ? undefined : {
          label: t(
            root.status === "resolved"
              ? "artifact.comments.reopen"
              : "artifact.comments.resolve",
          ),
          onClick: onResolve,
          disabled: busy,
        }}
      />
      {!root.deletedAt && root.anchor
        ? <ArtifactAnchorDescription anchor={root.anchor} />
        : null}
      {canEdit(root)
        ? <ArtifactCommentEditor comment={root} onUpdated={onUpdated} />
        : null}
      {root.placement?.status === "outdated"
        ? <UI.Text>{t("artifact.comments.outdated")}</UI.Text>
        : null}
      <UI.Link
        href={`/tasks/${artifact.taskId}/artifacts/${artifact.id}?version=${
          encodeURIComponent(root.artifactVersionId)
        }&comment=${encodeURIComponent(root.id)}`}
      >
        {t("artifact.comments.original")}
      </UI.Link>
      <UI.Inline gap="compact">
        <UI.Button variant="secondary" onClick={() => setExpanded(!expanded)}>
          {t("artifact.comments.replies")}
        </UI.Button>
      </UI.Inline>
      {!root.deletedAt
        ? (
          <UI.Checkbox
            checked={selected}
            onChange={(event) => onSelect(event.currentTarget.checked)}
          >
            {t("artifact.comments.select")}
          </UI.Checkbox>
        )
        : null}
      {expanded
        ? (
          <UI.Stack gap="compact">
            {replies.isError
              ? (
                <UI.InlineNotice tone="error">
                  {t("artifact.comments.error")}
                </UI.InlineNotice>
              )
              : null}
            {replies.hasNextPage
              ? (
                <UI.Button onClick={() => void replies.fetchNextPage()}>
                  {t("artifact.comments.more")}
                </UI.Button>
              )
              : null}
          </UI.Stack>
        )
        : null}
    </UI.Stack>
  );
}
