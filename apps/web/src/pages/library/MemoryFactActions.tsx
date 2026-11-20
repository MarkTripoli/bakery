import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { MemoryEntryResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  artifactVersionsQueryOptions,
  memorySourcesQueryOptions,
} from "../../api/query.ts";
import { useConnectivity } from "../../app/connectivity.ts";
import { focusAfterPaint } from "../../app/focus.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  correctionMissing,
  memoryActions,
  type MemoryRefusal,
  memoryRefusal,
} from "./memory-state.ts";

type Notice = { readonly text: string; readonly undo?: () => void };
type Failure = { readonly refusal: MemoryRefusal; readonly savedOnly: boolean };

/**
 * What an administrator can do with one fact (design-ux, #72, slice 2):
 * Approve a suggestion, Correct a wording (with the reason and the source that
 * says so), Don't use / Stop using, and Use again. The server may refuse any of
 * them; each refusal has its own sentence and nothing is claimed as done until
 * the server says so.
 */
export function MemoryFactActions(
  { canManage, entry, phone }: {
    readonly canManage: boolean;
    readonly entry: MemoryEntryResponse;
    readonly phone: boolean;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const queryClient = useQueryClient();
  const offline = useConnectivity() === "offline";
  const organizationId = scope.organizationId as string;
  const actions = memoryActions(entry);
  // The fact as last read, so a change made later (Undo) sends its current version.
  const latest = useRef(entry);
  latest.current = entry;

  const [correcting, setCorrecting] = useState<"correct" | "approve" | null>(
    null,
  );
  const [draft, setDraft] = useState({ content: "", reason: "", source: "" });
  const [tried, setTried] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Wordings this page made itself, so only someone else's correction is announced.
  const mine = useRef(new Set<string>());
  const seenRevision = useRef(entry.currentRevisionId);
  const [changedByOther, setChangedByOther] = useState(false);
  useEffect(() => {
    if (entry.currentRevisionId === seenRevision.current) return;
    seenRevision.current = entry.currentRevisionId;
    if (
      entry.currentRevisionId !== null &&
      !mine.current.has(entry.currentRevisionId)
    ) setChangedByOther(true);
  }, [entry.currentRevisionId]);
  // One key per intent: a retry of the same change reuses it, a new change does not.
  const intent = useRef<string | null>(null);
  const key = () => (intent.current ??= crypto.randomUUID());
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });

  const sources = useQuery({
    ...memorySourcesQueryOptions(api, scope, entry.repositoryId),
    enabled: correcting !== null && Boolean(scope.organizationId),
  });

  // The version number of the chosen document's current version, so the person
  // sees which exact version Bakery will link.
  const chosenArtifact = (sources.data ?? []).find((artifact) =>
    artifact.currentVersionId !== null &&
    artifact.currentVersionId === draft.source
  );
  const chosenVersions = useQuery({
    ...artifactVersionsQueryOptions(api, scope, chosenArtifact?.id ?? "", {
      limit: 100,
    }),
    enabled: chosenArtifact !== undefined && Boolean(scope.organizationId),
  });
  const chosenRevision = chosenVersions.data?.items.find((version) =>
    version.id === draft.source
  )?.revision;

  const fail = (error: unknown, savedOnly = false) => {
    const refusal = memoryRefusal(error);
    if (refusal !== "offline") intent.current = null;
    setFailure({ refusal, savedOnly });
  };

  const change = async (status: "active" | "retired", done: Notice) => {
    setBusy(true);
    setFailure(null);
    // Starting a change ends the "corrected while open" notice.
    setChangedByOther(false);
    try {
      const result = await api.updateMemory({
        organizationId,
        id: latest.current.id,
        status,
        version: latest.current.version,
        idempotencyKey: key(),
      });
      if (!result.ok) throw result.error;
      intent.current = null;
      setNotice(done);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const useAgain = (text: string) =>
    change("active", { text: translate(text as never) });
  const stop = (text: string) =>
    change("retired", {
      text: translate(text as never),
      undo: () => {
        setNotice(null);
        void useAgain("library.memory.toast.usedAgain");
      },
    });

  const openCorrect = (mode: "correct" | "approve") => {
    opener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    intent.current = null;
    setFailure(null);
    setNotice(null);
    setChangedByOther(false);
    setTried(false);
    setDraft({
      content: latest.current.currentRevision?.body ?? "",
      reason: "",
      source: "",
    });
    setCorrecting(mode);
  };
  const closeCorrect = () => {
    setCorrecting(null);
    setTried(false);
    focusAfterPaint(() => opener.current);
  };
  const edit = (patch: Partial<typeof draft>) => {
    intent.current = null;
    setDraft({ ...draft, ...patch });
  };

  const submitCorrection = async () => {
    setTried(true);
    const missing = correctionMissing({
      content: draft.content,
      reason: draft.reason,
      sourceArtifactVersionId: draft.source,
    });
    if (missing.content || missing.reason || missing.source) return;
    const approve = correcting === "approve";
    let saved = false;
    setBusy(true);
    setFailure(null);
    try {
      const made = await api.createMemoryRevision({
        organizationId,
        id: latest.current.id,
        input: {
          content: draft.content.trim(),
          reason: draft.reason.trim(),
          sourceArtifactVersionId: draft.source,
        },
        idempotencyKey: key(),
      });
      if (!made.ok) throw made.error;
      mine.current.add(made.data.id);
      saved = true;
      intent.current = null;
      if (approve) {
        // The correction changed the fact, so its version is read again.
        const fresh = await api.getMemory({
          organizationId,
          id: latest.current.id,
        });
        if (!fresh.ok) throw fresh.error;
        const approved = await api.updateMemory({
          organizationId,
          id: latest.current.id,
          status: "active",
          version: fresh.data.version,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!approved.ok) throw approved.error;
      }
      setNotice({
        text: translate(
          (approve
            ? "library.memory.toast.correctedApproved"
            : "library.memory.toast.corrected") as never,
        ),
      });
      closeCorrect();
    } catch (error) {
      fail(error, saved);
      // The wording is saved: the form has done its work, the notice says what is left.
      if (saved) setCorrecting(null);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (!canManage) {
    return (
      <UI.Text variant="muted" data-testid="memory-admin-only">
        {translate("library.memory.action.adminOnly" as never)}
      </UI.Text>
    );
  }

  const blocked = busy || offline;
  const missing = correctionMissing({
    content: draft.content,
    reason: draft.reason,
    sourceArtifactVersionId: draft.source,
  });
  const documents = [...(sources.data ?? [])]
    .filter((artifact) => artifact.currentVersionId !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const showMissing = (flag: boolean) => tried && flag;
  const Row = phone ? UI.Stack : UI.Inline;

  const failureNotice = failure === null ? null : (
    <UI.InlineNotice
      tone={failure.refusal === "stale" ? "warning" : "error"}
      data-testid="memory-failure"
    >
      <UI.Stack gap="tight">
        {failure.savedOnly
          ? (
            <UI.Text>
              {translate("library.memory.correct.savedNotApproved" as never)}
            </UI.Text>
          )
          : null}
        <UI.Text>
          {translate(`library.memory.refusal.${failure.refusal}` as never)}
        </UI.Text>
      </UI.Stack>
    </UI.InlineNotice>
  );

  return (
    <UI.Stack gap="standard" data-testid="memory-actions">
      {notice === null ? null : (
        <UI.Toast
          tone="success"
          data-testid="memory-toast"
          action={notice.undo === undefined
            ? undefined
            : (
              <UI.Button variant="secondary" onClick={notice.undo}>
                {translate("library.memory.toast.undo" as never)}
              </UI.Button>
            )}
          onDismiss={() => setNotice(null)}
        >
          {notice.text}
        </UI.Toast>
      )}
      {failureNotice}
      {changedByOther
        ? (
          <UI.InlineNotice
            tone={correcting === null ? "information" : "warning"}
            data-testid="memory-changed-by-other"
          >
            {translate(
              (correcting === null
                ? "library.memory.live.corrected"
                : "library.memory.refusal.stale") as never,
            )}
          </UI.InlineNotice>
        )
        : null}
      {actions.approve && correcting === null
        ? (
          <UI.Text variant="muted">
            {translate("library.memory.fact.suggestedHint" as never)}
          </UI.Text>
        )
        : null}
      {correcting === null
        ? (
          <Row gap="compact">
            {actions.approve
              ? (
                <UI.Button
                  variant="primary"
                  disabled={blocked}
                  onClick={() =>
                    void change("active", {
                      text: translate("library.memory.toast.approved" as never),
                    })}
                >
                  {translate("library.memory.action.approve" as never)}
                </UI.Button>
              )
              : null}
            {actions.correctThenApprove
              ? (
                <UI.Button
                  variant="secondary"
                  disabled={blocked}
                  onClick={() => openCorrect("approve")}
                >
                  {translate(
                    "library.memory.action.correctThenApprove" as never,
                  )}
                </UI.Button>
              )
              : null}
            {actions.correct
              ? (
                <UI.Button
                  variant="secondary"
                  disabled={blocked}
                  onClick={() => openCorrect("correct")}
                >
                  {translate("library.memory.action.correct" as never)}
                </UI.Button>
              )
              : null}
            {actions.dontUse
              ? (
                <UI.Button
                  variant="destructive-outline"
                  disabled={blocked}
                  onClick={() => void stop("library.memory.toast.notUsed")}
                >
                  {translate("library.memory.action.dontUse" as never)}
                </UI.Button>
              )
              : null}
            {actions.stopUsing
              ? (
                <UI.Button
                  variant="destructive-outline"
                  disabled={blocked}
                  onClick={() => setConfirmStop(true)}
                >
                  {translate("library.memory.action.stopUsing" as never)}
                </UI.Button>
              )
              : null}
            {actions.useAgain
              ? (
                <UI.Button
                  variant="primary"
                  disabled={blocked}
                  onClick={() =>
                    void useAgain("library.memory.toast.usedAgain")}
                >
                  {translate("library.memory.action.useAgain" as never)}
                </UI.Button>
              )
              : null}
          </Row>
        )
        : (
          <UI.Stack
            gap="standard"
            role="group"
            aria-label={translate("library.memory.correct.title" as never)}
            data-testid="memory-correct"
          >
            <UI.Heading level="section">
              {translate("library.memory.correct.title" as never)}
            </UI.Heading>
            <UI.Field
              label={translate("library.memory.correct.content" as never)}
              htmlFor="memory-correct-content"
              required
              variant="textarea"
              error={showMissing(missing.content)
                ? translate("library.memory.correct.errorContent" as never)
                : undefined}
            >
              <textarea
                id="memory-correct-content"
                value={draft.content}
                onChange={(event) => edit({ content: event.target.value })}
                aria-invalid={showMissing(missing.content) || undefined}
              />
            </UI.Field>
            <UI.Field
              label={translate("library.memory.correct.reason" as never)}
              hint={translate("library.memory.correct.reasonHint" as never)}
              htmlFor="memory-correct-reason"
              required
              variant="textarea"
              error={showMissing(missing.reason)
                ? translate("library.memory.correct.errorReason" as never)
                : undefined}
            >
              <textarea
                id="memory-correct-reason"
                value={draft.reason}
                onChange={(event) => edit({ reason: event.target.value })}
                aria-invalid={showMissing(missing.reason) || undefined}
              />
            </UI.Field>
            <UI.Stack gap="tight">
              <UI.Combobox
                label={`${
                  translate("library.memory.correct.source" as never)
                } *`}
                value={draft.source}
                state={sources.isPending ? "loading" : undefined}
                disabled={sources.isPending || sources.isError}
                required
                onChange={(event) => edit({ source: event.target.value })}
                aria-invalid={showMissing(missing.source) || undefined}
                options={[
                  {
                    value: "",
                    label: translate(
                      "library.memory.correct.sourceChoose" as never,
                    ),
                  },
                  ...documents.map((artifact) => ({
                    value: artifact.currentVersionId as string,
                    label: artifact.name,
                  })),
                ]}
              />
              <UI.Text variant="caption">
                {sources.isPending
                  ? translate("library.memory.correct.sourceLoading" as never)
                  : sources.isError
                  ? translate("library.memory.correct.sourceError" as never)
                  : documents.length === 0
                  ? translate("library.memory.correct.sourceNone" as never)
                  : chosenArtifact !== undefined && chosenRevision !== undefined
                  ? translate("library.memory.correct.sourceVersion" as never, {
                    name: chosenArtifact.name,
                    version: chosenRevision,
                  })
                  : translate("library.memory.correct.sourceHint" as never)}
              </UI.Text>
              {showMissing(missing.source)
                ? (
                  <UI.Text variant="caption" role="alert">
                    {translate("library.memory.correct.errorSource" as never)}
                  </UI.Text>
                )
                : null}
            </UI.Stack>
            <UI.Text variant="muted">
              {translate("library.memory.correct.note" as never)}
            </UI.Text>
            <Row gap="compact">
              <UI.Button
                variant="primary"
                disabled={blocked}
                onClick={() => void submitCorrection()}
              >
                {translate(
                  (correcting === "approve"
                    ? "library.memory.correct.saveApprove"
                    : "library.memory.correct.save") as never,
                )}
              </UI.Button>
              <UI.Button
                variant="secondary"
                disabled={busy}
                onClick={closeCorrect}
              >
                {translate("library.memory.correct.cancel" as never)}
              </UI.Button>
            </Row>
          </UI.Stack>
        )}
      {offline
        ? (
          <UI.Text variant="muted" role="status">
            {translate("library.memory.action.offline" as never)}
          </UI.Text>
        )
        : null}
      {confirmStop
        ? (
          <UI.AlertDialog
            open
            onOpenChange={(next) => !next && !busy && setConfirmStop(false)}
            state={busy ? "confirming" : "open"}
            title={translate("library.memory.stop.title" as never)}
            cancelAction={
              <UI.Button
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirmStop(false)}
              >
                {translate("library.memory.stop.cancel" as never)}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="destructive"
                disabled={blocked}
                onClick={() => {
                  setConfirmStop(false);
                  void stop("library.memory.toast.stopped");
                }}
              >
                {translate("library.memory.stop.confirm" as never)}
              </UI.Button>
            }
          >
            <UI.Text>{translate("library.memory.stop.body" as never)}</UI.Text>
          </UI.AlertDialog>
        )
        : null}
    </UI.Stack>
  );
}
