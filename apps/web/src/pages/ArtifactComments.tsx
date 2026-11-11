import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { contractSchemas } from "@bakery/contracts/contracts";
import {
  type ArtifactCommentResponse,
  type ArtifactResponse,
  type ArtifactVersionResponse,
  versionEtag,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  artifactCommentsAcrossVersionsQueryOptions,
  taskQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  type ArtifactCommentComposerModel,
  ArtifactCommentComposerView,
} from "./ArtifactDiscussionView.tsx";
import { ArtifactCommentThread } from "./ArtifactCommentThread.tsx";
import { ArtifactAgentRequest } from "./ArtifactAgentRequest.tsx";
import {
  type ArtifactAnchor,
  ArtifactCommentAnchor,
} from "./ArtifactCommentAnchor.tsx";

export function ArtifactComments({ artifact, version, commentId }: {
  readonly artifact: ArtifactResponse;
  readonly version: ArtifactVersionResponse;
  readonly commentId?: string;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [body, setBody] = useState("");
  const [anchor, setAnchor] = useState<ArtifactAnchor | null>(null);
  const [invalidAnchor, setInvalidAnchor] = useState(false);
  const [anchorGeneration, setAnchorGeneration] = useState(0);
  const onAnchorChange = useCallback(
    (value: ArtifactAnchor | null, invalid: boolean) => {
      setAnchor(value);
      setInvalidAnchor(invalid);
    },
    [],
  );
  const [reply, setReply] = useState<ArtifactCommentResponse | null>(null);
  const [selected, setSelected] = useState<readonly ArtifactCommentResponse[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<
    "conflict" | "failed" | "tooLong" | null
  >(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const options = artifactCommentsAcrossVersionsQueryOptions(
    api,
    scope,
    artifact.id,
    { viewVersionId: version.id },
  );
  const comments = useInfiniteQuery({
    queryKey: [...options.queryKey, "pages"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      if (!scope.organizationId) throw new Error("ORGANIZATION_REQUIRED");
      const result = await api.listArtifactCommentsAcrossVersions({
        organizationId: scope.organizationId,
        artifactId: artifact.id,
        viewVersionId: version.id,
        cursor: pageParam,
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: scope.organizationId !== null,
    retry: false,
  });
  const task = useQuery({
    ...taskQueryOptions(api, scope, artifact.taskId),
    enabled: scope.organizationId !== null,
  });
  const roots = comments.isError
    ? []
    : comments.data?.pages.flatMap((page) => page.items) ?? [];
  const focusedComment = useRef<string | null>(null);
  const foundComment = roots.some((root) => root.id === commentId);
  const missingComment = commentId && comments.isSuccess && !foundComment &&
    !comments.hasNextPage && !comments.isFetching;
  useEffect(() => {
    if (comments.isError) {
      setSelected([]);
      setReply(null);
    }
  }, [comments.isError]);
  useEffect(() => {
    if (!commentId || comments.isError || comments.isPending) return;
    if (!foundComment) {
      if (comments.hasNextPage && !comments.isFetching) {
        void comments.fetchNextPage();
      }
      return;
    }
    if (focusedComment.current === commentId) return;
    const element = document.getElementById(`comment-${commentId}`);
    if (element) {
      element.focus();
      element.scrollIntoView({ block: "nearest" });
      focusedComment.current = commentId;
    }
  }, [
    commentId,
    foundComment,
    comments.isError,
    comments.isPending,
    comments.hasNextPage,
    comments.isFetching,
    comments.fetchNextPage,
  ]);
  const submit = async () => {
    if (!scope.organizationId || busy || (!reply && invalidAnchor)) return;
    const bytes = new TextEncoder().encode(body.trim()).length;
    if (bytes < 1 || bytes > 10_240) {
      setFailure("tooLong");
      return;
    }
    const input = contractSchemas.ArtifactCommentCreate.safeParse({
      body: body.trim(),
      ...(reply ? { rootId: reply.id } : anchor ? { anchor } : {}),
    });
    if (!input.success) {
      setFailure("failed");
      return;
    }
    setBusy(true);
    setFailure(null);
    const payload = JSON.stringify({
      body: body.trim(),
      versionId: reply?.artifactVersionId ?? version.id,
      rootId: reply?.id,
      anchor: reply ? undefined : anchor,
    });
    if (pending.current?.payload !== payload) {
      pending.current = { payload, id: crypto.randomUUID() };
    }
    const abort = new AbortController();
    controller.current = abort;
    const result = await api.createArtifactComment({
      organizationId: scope.organizationId,
      versionId: reply?.artifactVersionId ?? version.id,
      input: input.data,
      idempotencyKey: pending.current.id,
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    setBusy(false);
    if (!result.ok) {
      setFailure(
        result.error.kind === "problem" && result.error.problem.status === 412
          ? "conflict"
          : "failed",
      );
      return;
    }
    pending.current = null;
    setBody("");
    setReply(null);
    setAnchor(null);
    setInvalidAnchor(false);
    setAnchorGeneration((generation) => generation + 1);
    setSelected([]);
    await comments.refetch();
  };
  const resolve = async (root: ArtifactCommentResponse) => {
    if (!scope.organizationId || busy) return;
    setBusy(true);
    setFailure(null);
    const abort = new AbortController();
    controller.current = abort;
    const result = await api.updateArtifactComment({
      organizationId: scope.organizationId,
      id: root.id,
      input: { resolved: root.status !== "resolved" },
      ifMatch: versionEtag(root.version),
      idempotencyKey: crypto.randomUUID(),
      signal: abort.signal,
    });
    if (abort.signal.aborted) return;
    setBusy(false);
    if (!result.ok) {
      setFailure(
        result.error.kind === "problem" && result.error.problem.status === 412
          ? "conflict"
          : "failed",
      );
      return;
    }
    setSelected([]);
    await comments.refetch();
  };
  const composer: ArtifactCommentComposerModel = {
    id: "artifact-comment-body",
    label: t("artifact.comments.body"),
    value: body,
    onChange: setBody,
    onSubmit: () => void submit(),
    submitLabel: t(
      reply ? "artifact.comments.sendReply" : "artifact.comments.post",
    ),
    disabled: busy || comments.isError || (!reply && invalidAnchor),
    mode: reply
      ? {
        kind: "reply",
        onCancel: () => setReply(null),
      }
      : {
        kind: "comment",
        anchor: (
          <ArtifactCommentAnchor
            key={`${version.id}:${anchorGeneration}`}
            version={version}
            disabled={busy}
            onChange={onAnchorChange}
          />
        ),
      },
    agentAction: (
      <ArtifactAgentRequest
        conversationId={task.data?.conversationId ?? null}
        selected={selected}
        onReload={() => {
          setSelected([]);
          void comments.refetch();
        }}
      />
    ),
  };
  const lastReplyId = useRef<string | null>(null);
  useEffect(() => {
    if (reply) document.getElementById("artifact-comment-body")?.focus();
    // Leaving reply mode unmounts the focused field; return focus to its thread.
    else if (lastReplyId.current) {
      document.getElementById(`comment-${lastReplyId.current}`)?.focus();
    }
    lastReplyId.current = reply?.id ?? null;
  }, [reply?.id]);
  return (
    <UI.CommentRail title={t("artifact.comments.title")}>
      {missingComment
        ? (
          <UI.InlineNotice tone="error">
            {t("artifact.comments.missing")}
          </UI.InlineNotice>
        )
        : null}
      {comments.isError
        ? (
          <UI.InlineNotice tone="error">
            {t("artifact.comments.error")}
          </UI.InlineNotice>
        )
        : null}
      {comments.isPending
        ? <UI.Skeleton shape="text" />
        : roots.length === 0 && !comments.isError
        ? <UI.Text>{t("artifact.comments.empty")}</UI.Text>
        : null}
      {roots.map((root) => (
        <ArtifactCommentThread
          key={root.id}
          root={root}
          artifact={artifact}
          viewVersionId={version.id}
          selected={selected.some((item) => item.id === root.id)}
          busy={busy}
          composer={reply?.id === root.id ? composer : undefined}
          onSelect={(checked) =>
            setSelected((items) =>
              checked
                ? [...items.filter((item) => item.id !== root.id), root]
                : items.filter((item) => item.id !== root.id)
            )}
          onReply={() => {
            if (reply?.id === root.id) {
              setReply(null);
              return;
            }
            setReply(root);
            document.getElementById("artifact-comment-body")?.focus();
          }}
          onResolve={() => void resolve(root)}
          onUpdated={() => {
            setSelected([]);
            void comments.refetch();
          }}
        />
      ))}
      {comments.hasNextPage
        ? (
          <UI.Button
            variant="secondary"
            onClick={() => void comments.fetchNextPage()}
            disabled={comments.isFetchingNextPage}
          >
            {t("artifact.comments.more")}
          </UI.Button>
        )
        : null}
      {failure
        ? (
          <UI.InlineNotice tone="error">
            {t(`artifact.comments.${failure}`)}
          </UI.InlineNotice>
        )
        : null}
      {comments.isError || failure === "conflict"
        ? (
          <UI.Button
            variant="secondary"
            onClick={() => {
              setSelected([]);
              void comments.refetch();
            }}
          >
            {t("artifact.comments.refresh")}
          </UI.Button>
        )
        : null}
      {!reply ? <ArtifactCommentComposerView {...composer} /> : null}
    </UI.CommentRail>
  );
}
