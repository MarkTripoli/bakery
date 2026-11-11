import { useEffect, useRef, useState } from "react";
import {
  ArtifactAgentControlView,
  ArtifactAgentDialogView,
} from "./ArtifactDiscussionView.tsx";
import type { ArtifactCommentResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function ArtifactAgentRequest({ conversationId, selected, onReload }: {
  readonly conversationId: string | null;
  readonly selected: readonly ArtifactCommentResponse[];
  readonly onReload: () => void;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<"conflict" | "failed" | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const submit = async () => {
    if (
      !conversationId || !scope.organizationId || busy || !body.trim() ||
      selected.length === 0
    ) return;
    const commentRefs = selected.map((root) => ({
      commentId: root.id,
      expectedVersion: root.version,
    }));
    const payload = JSON.stringify({ body: body.trim(), commentRefs });
    if (pending.current?.payload !== payload) {
      pending.current = { payload, id: crypto.randomUUID() };
    }
    const id = pending.current.id;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setFailure(null);
    const result = await api.createMessage({
      organizationId: scope.organizationId,
      conversationId,
      input: {
        body: body.trim(),
        clientMessageId: id,
        intent: "agent_request",
        commentRefs,
      },
      idempotencyKey: id,
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
    setSent(true);
    setOpen(false);
    setBody("");
  };
  return (
    <ArtifactAgentControlView
      label={t("artifact.agent.open")}
      disabled={!conversationId || selected.length === 0}
      onOpen={() => {
        setOpen(true);
        setSent(false);
      }}
      unavailable={!conversationId
        ? t("artifact.agent.unavailable")
        : undefined}
      sent={sent ? t("artifact.agent.sent") : undefined}
      dialog={
        <ArtifactAgentDialogView
          title={t("artifact.agent.title")}
          cancel={{
            label: t("core.actions.cancel"),
            onClick: () => setOpen(false),
          }}
          open={open}
          onOpenChange={setOpen}
          dismissLabel={t("artifact.agent.close")}
          description={t("artifact.agent.description")}
          context={selected.map((root) =>
            root.deletedAt ? t("artifact.comments.deleted") : root.body
          ).join("\n")}
          submit={{
            label: t("artifact.agent.submit"),
            onClick: () => void submit(),
            disabled: busy || !body.trim(),
          }}
          message={{
            id: "artifact-agent-body",
            label: t("artifact.agent.body"),
            value: body,
            onChange: setBody,
          }}
          failure={failure ? t(`artifact.comments.${failure}`) : undefined}
          reload={failure === "conflict"
            ? {
              label: t("artifact.comments.refresh"),
              onClick: () => {
                setOpen(false);
                setFailure(null);
                pending.current = null;
                onReload();
              },
            }
            : undefined}
        />
      }
    />
  );
}
