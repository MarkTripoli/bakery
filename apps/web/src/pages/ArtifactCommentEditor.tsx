import { useEffect, useRef, useState } from "react";
import * as UI from "@bakery/ui";
import { type ArtifactCommentResponse, versionEtag } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function ArtifactCommentEditor({ comment, onUpdated }: {
  readonly comment: ArtifactCommentResponse;
  readonly onUpdated: () => void;
}) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<
    "conflict" | "failed" | "tooLong" | null
  >(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const save = async () => {
    if (!scope.organizationId || busy || comment.deletedAt) return;
    const body = draft.trim();
    const size = new TextEncoder().encode(body).byteLength;
    if (!size || size > 10_240) {
      setFailure("tooLong");
      return;
    }
    const payload = JSON.stringify({ body, version: comment.version });
    if (pending.current?.payload !== payload) {
      pending.current = { payload, id: crypto.randomUUID() };
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setFailure(null);
    const result = await api.updateArtifactComment({
      organizationId: scope.organizationId,
      id: comment.id,
      input: { body },
      ifMatch: versionEtag(comment.version),
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
    setEditing(false);
    setDraft("");
    onUpdated();
  };
  if (comment.deletedAt) return null;
  if (!editing) {
    return (
      <UI.Button
        variant="secondary"
        onClick={() => {
          setDraft(comment.body ?? "");
          setEditing(true);
        }}
      >
        {t("artifact.comments.edit")}
      </UI.Button>
    );
  }
  return (
    <UI.Stack gap="compact">
      <UI.Field
        htmlFor={`artifact-comment-edit-${comment.id}`}
        label={t("artifact.comments.editBody")}
      >
        <textarea
          id={`artifact-comment-edit-${comment.id}`}
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </UI.Field>
      {failure
        ? (
          <UI.InlineNotice tone="error">
            {t(`artifact.comments.${failure}`)}
          </UI.InlineNotice>
        )
        : null}
      {failure === "conflict"
        ? (
          <UI.Button variant="secondary" onClick={onUpdated}>
            {t("artifact.comments.refresh")}
          </UI.Button>
        )
        : null}
      <UI.Inline gap="compact">
        <UI.Button disabled={busy} onClick={() => void save()}>
          {t("artifact.comments.save")}
        </UI.Button>
        <UI.Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setDraft("");
            setFailure(null);
          }}
        >
          {t("core.actions.cancel")}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
}
