import { useEffect, useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { DraftPublicationResponse } from "../api/client.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  lookForPublication,
  publishCheckpoint,
  type PublishDeps,
} from "../collaboration/publish-flow.ts";
import { invalidateArtifactQueries } from "./artifact-live.ts";

type Previewed = Readonly<{
  checkpointId: string;
  textDigest: string;
  /** Agent suggestions still waiting (they stay in the draft); null when the list could not be read. */
  waiting: number | null;
}>;

type Dialog =
  | Readonly<{ step: "closed" }>
  | Readonly<{ step: "reading" }>
  | Readonly<{ step: "read-failed" }>
  | Readonly<{ step: "ready"; previewed: Previewed; moved: boolean }>
  | Readonly<{ step: "publishing"; previewed: Previewed }>;

type Result =
  | null
  | Readonly<{ kind: "published"; publication: DraftPublicationResponse }>
  | Readonly<{ kind: "unknown"; checkpointId: string; looking: boolean }>
  | Readonly<{ kind: "not-published" }>
  | Readonly<{ kind: "forbidden" }>;

/**
 * Publishing a draft: the header's Publish, the dialog that says exactly what
 * will be in the version, and what became of it. A lost answer is never
 * published again: "Check again" looks the checkpoint up (#71, design D).
 * Returns the pieces so the editor places them: the control for its header,
 * the notices above the text, the dialog.
 */
export function usePublish(
  {
    artifactId,
    canPublish,
    draftId,
    focusEditor,
    nextVersion,
    onPublished,
    onViewVersion,
    revoked,
    saved,
    taskId,
  }: {
    readonly artifactId: string;
    readonly canPublish: boolean;
    readonly draftId: string;
    readonly focusEditor: () => void;
    /** The number this publication will have. */
    readonly nextVersion: number;
    /** Told the version this person published, so it is not announced twice. */
    readonly onPublished: (versionNumber: number) => void;
    /** Leaves the editor for the version page. */
    readonly onViewVersion: () => void;
    readonly revoked: boolean;
    /** Everything this person typed has been acknowledged. */
    readonly saved: boolean;
    readonly taskId: string;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate: t } = useI18n();
  const hintId = useId();
  const [dialog, setDialog] = useState<Dialog>({ step: "closed" });
  const [result, setResult] = useState<Result>(null);
  const organizationId = scope.organizationId;

  const deps = useMemo<PublishDeps | null>(
    () =>
      organizationId === null ? null : {
        readDraft: () => api.getDraft({ organizationId, draftId }),
        publish: (input) =>
          api.publishDraft({ organizationId, draftId, input }),
        lookup: (checkpointId) =>
          api.getDraftPublication({ organizationId, draftId, checkpointId }),
      },
    [api, draftId, organizationId],
  );

  /** The draft as it stands now and how many suggestions wait. */
  const read = async (): Promise<Previewed | null> => {
    if (organizationId === null || deps === null) return null;
    const [draft, suggestions] = await Promise.all([
      deps.readDraft(),
      api.listDraftSuggestions({
        organizationId,
        draftId,
        state: "waiting",
        limit: 100,
      }),
    ]);
    // Publishing does not wait on the suggestions: if they cannot be read the
    // dialog just leaves their line out rather than saying there are none.
    if (!draft.ok) return null;
    return {
      checkpointId: draft.data.checkpointId,
      textDigest: draft.data.textDigest,
      waiting: suggestions.ok ? suggestions.data.items.length : null,
    };
  };

  const open = () => {
    setResult(null);
    setDialog({ step: "reading" });
    void read().then((previewed) =>
      setDialog(
        previewed
          ? { step: "ready", previewed, moved: false }
          : { step: "read-failed" },
      )
    );
  };

  const finish = (publication: DraftPublicationResponse) => {
    setDialog({ step: "closed" });
    setResult({ kind: "published", publication });
    onPublished(publication.versionNumber);
    void invalidateArtifactQueries(queryClient, scope);
    focusEditor();
  };

  const confirm = async () => {
    if (deps === null || dialog.step !== "ready") return;
    const previewed = dialog.previewed;
    setDialog({ step: "publishing", previewed });
    const outcome = await publishCheckpoint(deps, previewed);
    switch (outcome.kind) {
      case "published":
        return finish(outcome.publication);
      case "moved": {
        // Nothing was published: show the text as it is now, to be pressed again.
        const fresh = await read();
        return setDialog(
          fresh
            ? { step: "ready", previewed: fresh, moved: true }
            : { step: "read-failed" },
        );
      }
      case "forbidden":
        setDialog({ step: "closed" });
        return setResult({ kind: "forbidden" });
      case "refused":
        setDialog({ step: "closed" });
        return setResult({ kind: "not-published" });
      case "unknown":
        setDialog({ step: "closed" });
        return setResult({
          kind: "unknown",
          checkpointId: outcome.checkpointId,
          looking: false,
        });
    }
  };

  const checkAgain = async () => {
    if (deps === null || result?.kind !== "unknown") return;
    const { checkpointId } = result;
    setResult({ kind: "unknown", checkpointId, looking: true });
    const found = await lookForPublication(deps, checkpointId);
    if (found.kind === "found") return finish(found.publication);
    setResult(
      found.kind === "absent"
        ? { kind: "not-published" }
        : { kind: "unknown", checkpointId, looking: false },
    );
  };

  // Access removed while the dialog is open: it closes; nothing is published.
  useEffect(() => {
    if (revoked) {
      setDialog((current) =>
        current.step === "publishing" ? current : { step: "closed" }
      );
    }
  }, [revoked]);

  const control = !canPublish
    ? (
      <UI.Text data-testid="artifact-publish-denied" variant="hint">
        {t("artifact.edit.publish.noRight")}
      </UI.Text>
    )
    : (
      <UI.Stack gap="compact">
        <UI.Inline gap="compact">
          <UI.Button
            aria-describedby={saved ? undefined : hintId}
            data-testid="artifact-publish"
            disabled={!saved || revoked || organizationId === null}
            onClick={open}
            variant="primary"
          >
            {t("artifact.edit.publish.action")}
          </UI.Button>
        </UI.Inline>
        {!saved && (
          <UI.Text id={hintId} variant="hint">
            {t("artifact.edit.publish.needsSave")}
          </UI.Text>
        )}
      </UI.Stack>
    );

  const busy = dialog.step === "publishing";
  const previewed = dialog.step === "ready" || dialog.step === "publishing"
    ? dialog.previewed
    : null;
  const title = t("artifact.edit.publish.title", { version: nextVersion });

  const notices = (
    <>
      {result?.kind === "published" && (
        <UI.AlertBanner
          action={
            <RouterLink
              onClick={onViewVersion}
              params={{ taskId, artifactId }}
              search={{ version: result.publication.artifactVersionId }}
              to="/tasks/$taskId/artifacts/$artifactId"
            >
              {t("artifact.edit.publish.view", {
                version: result.publication.versionNumber,
              })}
            </RouterLink>
          }
          onDismiss={() => setResult(null)}
          tone="success"
        >
          {t("artifact.edit.publish.done", {
            version: result.publication.versionNumber,
          })}
        </UI.AlertBanner>
      )}
      {result?.kind === "unknown" && (
        <UI.AlertBanner
          action={
            <UI.Button
              disabled={result.looking}
              onClick={() => void checkAgain()}
              variant="outline"
            >
              {t("artifact.edit.publish.checkAgain")}
            </UI.Button>
          }
          tone="error"
        >
          {t("artifact.edit.publish.unknown", { version: nextVersion })}
        </UI.AlertBanner>
      )}
      {result?.kind === "not-published" && (
        <UI.AlertBanner onDismiss={() => setResult(null)} tone="warning">
          {t("artifact.edit.publish.notPublished", { version: nextVersion })}
        </UI.AlertBanner>
      )}
      {result?.kind === "forbidden" && (
        <UI.AlertBanner onDismiss={() => setResult(null)} tone="error">
          {t("artifact.edit.publish.noRight")}
        </UI.AlertBanner>
      )}
    </>
  );

  const dialogNode = (
    <>
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            disabled={busy}
            onClick={() => setDialog({ step: "closed" })}
            variant="outline"
          >
            {t("artifact.edit.publish.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            disabled={dialog.step === "reading" ||
              dialog.step === "read-failed" ||
              busy}
            onClick={() => void confirm()}
            variant="primary"
          >
            {busy
              ? t("artifact.edit.publish.publishing")
              : t("artifact.edit.publish.confirm", { version: nextVersion })}
          </UI.Button>
        }
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onOpenChange={(next) => {
          if (!next && !busy) setDialog({ step: "closed" });
        }}
        open={dialog.step !== "closed"}
        state={busy ? "confirming" : "open"}
        title={title}
        variant="security"
      >
        <UI.Stack gap="standard">
          {dialog.step === "reading" && (
            <UI.Stack
              aria-busy="true"
              aria-label={t("artifact.edit.publish.reading")}
              gap="compact"
            >
              <UI.Skeleton shape="text" />
              <UI.Skeleton shape="text" />
            </UI.Stack>
          )}
          {dialog.step === "read-failed" && (
            <UI.InlineNotice
              action={
                <UI.Button onClick={open} variant="outline">
                  {t("artifact.edit.retry")}
                </UI.Button>
              }
              tone="error"
            >
              {t("artifact.edit.publish.readFailed")}
            </UI.InlineNotice>
          )}
          {previewed !== null && (
            <>
              <UI.Text>
                {t("artifact.edit.publish.body", { version: nextVersion })}
              </UI.Text>
              {previewed.waiting !== null && previewed.waiting > 0 && (
                <UI.InlineNotice tone="warning">
                  {t(
                    previewed.waiting === 1
                      ? "artifact.edit.publish.waitingOne"
                      : "artifact.edit.publish.waiting",
                    { count: previewed.waiting, version: nextVersion },
                  )}
                </UI.InlineNotice>
              )}
              {nextVersion > 1 && (
                <UI.Text variant="hint">
                  {t("artifact.edit.publish.kept", {
                    version: nextVersion - 1,
                  })}
                </UI.Text>
              )}
              {dialog.step === "ready" && dialog.moved && (
                <UI.InlineNotice tone="warning">
                  {t("artifact.edit.publish.moved")}
                </UI.InlineNotice>
              )}
            </>
          )}
        </UI.Stack>
      </UI.AlertDialog>
    </>
  );

  return { control, dialog: dialogNode, notices };
}
