import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { EditorView } from "@codemirror/view";
import { createPortal } from "react-dom";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { DraftResponse } from "../api/client.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  loroExtensions,
  remoteCaretLayer,
  setRemoteCarets,
  showSuggestedRange,
  sizeLimit,
  suggestionTint,
} from "../collaboration/editor-binding.ts";
import { peopleOf } from "../collaboration/people.ts";
import { encodeCursorAt, remoteCarets } from "../collaboration/carets.ts";
import { useSession } from "../app/session-context.tsx";
import { usePublish } from "./ArtifactPublish.tsx";
import {
  SuggestionsConfirm,
  SuggestionsPanel,
  useSuggestions,
} from "./ArtifactSuggestions.tsx";
import {
  CollaborationSession,
  DOCUMENT_LIMIT_BYTES,
  type RefusedPiece,
  type SocketLike,
} from "../collaboration/session.ts";

type Opened =
  | { readonly status: "loading" }
  | { readonly status: "forbidden" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly draft: DraftResponse };

const PRESENCE_COLORS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Opens an artifact's shared draft and edits it in place: the editor with
 * everyone's changes, who is here, where this person's own changes stand, and
 * what became of text the server did not keep (#71).
 */
export function ArtifactEditor(
  { artifactId, onViewVersion, publishedVersion, suggestionsHost, taskId }: {
    readonly artifactId: string;
    /** The side column's element for the suggestions; null on a phone (a sheet then). */
    readonly suggestionsHost: HTMLElement | null;
    /** Leaves the editor for the version page (after "View version"). */
    readonly onViewVersion: () => void;
    /** The version number last published, or null when nothing is. */
    readonly publishedVersion: number | null;
    readonly taskId: string;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<Opened>({ status: "loading" });
  useEffect(() => {
    const organizationId = scope.organizationId;
    if (organizationId === null) return;
    const abort = new AbortController();
    setOpened({ status: "loading" });
    void api.openArtifactDraft({
      organizationId,
      artifactId,
      signal: abort.signal,
    }).then((result) => {
      if (abort.signal.aborted) return;
      if (result.ok) setOpened({ status: "ready", draft: result.data });
      else if (
        result.error.kind === "problem" &&
        (result.error.problem.status === 403 ||
          result.error.problem.status === 404)
      ) setOpened({ status: "forbidden" });
      else setOpened({ status: "error" });
    });
    return () => abort.abort();
  }, [api, scope.organizationId, artifactId, attempt]);

  if (opened.status === "loading") {
    return (
      <UI.Stack
        aria-busy="true"
        aria-label={t("artifact.edit.loading")}
        gap="standard"
      >
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="surface" />
      </UI.Stack>
    );
  }
  if (opened.status === "forbidden") {
    return (
      <UI.InlineNotice tone="error">
        {t("artifact.edit.forbidden")}
      </UI.InlineNotice>
    );
  }
  if (opened.status === "error") {
    return (
      <UI.ErrorState
        action={
          <UI.Button onClick={() => setAttempt((n) => n + 1)} variant="outline">
            {t("artifact.edit.retry")}
          </UI.Button>
        }
        description={t("artifact.edit.error.body")}
        title={t("artifact.edit.error.title")}
      />
    );
  }
  return (
    <OpenDraft
      artifactId={artifactId}
      canPublish={opened.draft.canPublish}
      draftId={opened.draft.id}
      onViewVersion={onViewVersion}
      publishedVersion={publishedVersion}
      suggestionsHost={suggestionsHost}
      taskId={taskId}
    />
  );
}

function OpenDraft(
  {
    artifactId,
    canPublish,
    draftId,
    onViewVersion,
    publishedVersion,
    suggestionsHost,
    taskId,
  }: {
    readonly artifactId: string;
    readonly canPublish: boolean;
    readonly draftId: string;
    readonly onViewVersion: () => void;
    readonly publishedVersion: number | null;
    readonly suggestionsHost: HTMLElement | null;
    readonly taskId: string;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const [session, setSession] = useState<CollaborationSession | null>(null);
  useEffect(() => {
    const organizationId = scope.organizationId;
    if (organizationId === null) return;
    const created = new CollaborationSession({
      draftId,
      createSocket: () =>
        new WebSocket(
          api.collaborationSocketUrl(organizationId),
        ) as unknown as SocketLike,
      storage: browserStorage(),
    });
    created.start();
    setSession(created);
    return () => {
      created.destroy();
      setSession(null);
    };
  }, [api, scope.organizationId, draftId]);
  return session
    ? (
      <DraftEditor
        artifactId={artifactId}
        canPublish={canPublish}
        draftId={draftId}
        onViewVersion={onViewVersion}
        publishedVersion={publishedVersion}
        session={session}
        suggestionsHost={suggestionsHost}
        taskId={taskId}
      />
    )
    : null;
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function DraftEditor(
  {
    artifactId,
    canPublish,
    draftId,
    onViewVersion,
    publishedVersion,
    session,
    suggestionsHost,
    taskId,
  }: {
    readonly suggestionsHost: HTMLElement | null;
    readonly artifactId: string;
    readonly canPublish: boolean;
    readonly draftId: string;
    readonly onViewVersion: () => void;
    readonly publishedVersion: number | null;
    readonly session: CollaborationSession;
    readonly taskId: string;
  },
) {
  const { translate: t, locale } = useI18n();
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [discarding, setDiscarding] = useState<RefusedPiece | null>(null);
  const [typedAt, setTypedAt] = useState(0);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Text this device kept from an earlier visit is told about once, on arrival.
  const [restored] = useState(() =>
    session.getSnapshot().refused[0]?.typedAt ?? null
  );
  const [restoredShown, setRestoredShown] = useState(restored !== null);

  const time = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }),
    [locale],
  );
  const clock = (milliseconds: number) => time.format(new Date(milliseconds));

  // This person's own presence: typing, and where the caret and selection are.
  const cursorRef = useRef<{ anchor: string; head: string } | null>(null);
  const typingNow = useRef(false);
  const announceRef = useRef(() => {});
  announceRef.current = () =>
    session.setPresence({
      activity: "active",
      typing: typingNow.current,
      cursor: cursorRef.current,
    });
  const selfPrincipalId = useSession().identity?.principalId ?? null;
  // The editor binds to the session's document and starts again whenever the
  // session rebuilds it from the server's text.
  const extensions = useMemo(
    () => [
      ...loroExtensions(session.document),
      sizeLimit(),
      suggestionTint(),
      remoteCaretLayer(),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          // Where this person's caret and selection are, for everyone else.
          const main = update.state.selection.main;
          const anchor = encodeCursorAt(session.document, main.anchor);
          const head = encodeCursorAt(session.document, main.head);
          cursorRef.current = anchor && head ? { anchor, head } : null;
          if (!update.docChanged) announceRef.current();
        }
        if (!update.docChanged) return;
        setTypedAt(Date.now());
      }),
    ],
    // documentVersion is the rebuild signal; the document object changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, snapshot.documentVersion],
  );

  // Others see "is typing" while this person's changes keep coming.
  useEffect(() => {
    if (typedAt === 0) return;
    typingNow.current = true;
    announceRef.current();
    if (typing.current !== null) clearTimeout(typing.current);
    typing.current = setTimeout(() => {
      typingNow.current = false;
      announceRef.current();
    }, 2000);
    return () => {
      if (typing.current !== null) clearTimeout(typing.current);
    };
  }, [session, typedAt]);

  // Closing the tab with text not yet sent or kept asks first (the browser's own warning).
  useEffect(() => {
    if (snapshot.pendingCount === 0 && snapshot.refused.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener("beforeunload", warn);
    return () => globalThis.removeEventListener("beforeunload", warn);
  }, [snapshot.pendingCount, snapshot.refused.length]);

  const people = useMemo(() => peopleOf(snapshot.participants), [
    snapshot.participants,
  ]);
  const colours = useRef(new Map<string, (typeof PRESENCE_COLORS)[number]>());
  const presence = people.map((person) => {
    if (!colours.current.has(person.principalId)) {
      colours.current.set(
        person.principalId,
        PRESENCE_COLORS[colours.current.size % PRESENCE_COLORS.length],
      );
    }
    return {
      id: person.principalId,
      name: person.displayName,
      kind: person.principalType === "human"
        ? "person" as const
        : "agent" as const,
      color: colours.current.get(person.principalId),
    };
  });
  // Other people's carets, in the colours their avatars have.
  useEffect(() => {
    const view = editorView.current;
    if (!view) return;
    view.dispatch({
      effects: setRemoteCarets.of(
        remoteCarets(session.document, snapshot.participants, selfPrincipalId)
          .map((caret) => ({
            name: caret.name,
            colour: colours.current.get(caret.principalId) ?? 1,
            anchor: caret.anchor,
            head: caret.head,
          })),
      ),
    });
  }, [
    session,
    snapshot.participants,
    snapshot.documentVersion,
    typedAt,
    selfPrincipalId,
  ]);
  const status = people
    .filter((person) => person.status !== "away" || people.length > 0)
    .map((person) =>
      t(`artifact.edit.presence.${person.status}`, { name: person.displayName })
    )
    .join(" · ");
  const pieces = snapshot.refused;
  // Access removed: nothing will reconnect or save, so the save state is gone too.
  const ended = snapshot.connection === "ended";
  const bytesUsed = useSizeNote(session, snapshot.documentVersion, typedAt);
  // Versions this person published themselves are not announced a second time.
  const [ownVersion, setOwnVersion] = useState<number | null>(null);
  // The line and the next number follow a version this person just published,
  // before the page's own list has been read again.
  const latestVersion = Math.max(publishedVersion ?? 0, ownVersion ?? 0) ||
    null;
  // The editor's own view, for returning focus to the text after publishing.
  const editorView = useRef<EditorView | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const chosenRange = useRef<{ from: number; to: number } | null>(null);
  const suggestions = useSuggestions({
    document: session.document,
    documentTick: snapshot.documentVersion + typedAt,
    draftId,
    onSelectRange: (range) => {
      chosenRange.current = range;
      if (editorView.current) showSuggestedRange(editorView.current, range);
    },
  });
  const reshowChosen = () => {
    if (editorView.current && chosenRange.current) {
      showSuggestedRange(editorView.current, chosenRange.current);
    }
  };
  const publish = usePublish({
    artifactId,
    canPublish,
    draftId,
    focusEditor: () => editorView.current?.focus(),
    nextVersion: (latestVersion ?? 0) + 1,
    onPublished: setOwnVersion,
    onViewVersion,
    revoked: ended,
    saved: snapshot.saveState === "saved" && pieces.length === 0 && !ended,
    taskId,
  });

  const copy = (piece: RefusedPiece) =>
    void globalThis.navigator?.clipboard?.writeText(piece.text);
  const sheet = (
    <UI.Sheet
      dismissLabel={t("artifact.edit.sheet.close")}
      onOpenChange={setSheetOpen}
      open={sheetOpen && pieces.length > 0}
      title={t("artifact.edit.sheet.title")}
      variant="side"
    >
      <UI.Stack gap="standard">
        <UI.Text>{t("artifact.edit.sheet.intro")}</UI.Text>
        <Pieces
          clock={clock}
          copy={copy}
          onDiscard={setDiscarding}
          pieces={pieces}
          t={t}
        />
      </UI.Stack>
    </UI.Sheet>
  );

  return (
    <UI.Stack gap="standard">
      <UI.Stack gap="compact">
        <UI.Inline gap="compact" variant="between">
          <UI.Inline gap="compact">
            <UI.Badge>{t("artifact.edit.draft.badge")}</UI.Badge>
            <UI.HelpTip label={t("artifact.edit.draft.helpLabel")}>
              {t("artifact.edit.draft.help")}
            </UI.HelpTip>
          </UI.Inline>
          {publish.control}
        </UI.Inline>
        <UI.Text variant="hint">
          {latestVersion === null
            ? t("artifact.edit.draft.lineNone")
            : t("artifact.edit.draft.line", { version: latestVersion })}
        </UI.Text>
      </UI.Stack>
      <UI.PresenceRow
        aria-label={t("artifact.edit.presence.label")}
        overflowLabel={t("artifact.edit.presence.more", {
          count: Math.max(presence.length - 5, 0),
        })}
        people={presence}
        saveLabel={ended
          ? undefined
          : t(`artifact.edit.save.${snapshot.saveState}`)}
        saveState={ended ? undefined : snapshot.saveState}
        status={status}
      />
      {publish.notices}
      {snapshot.banner?.kind === "published" &&
        snapshot.banner.versionNumber !== ownVersion && (
        <UI.AlertBanner
          onDismiss={() => session.dismissBanner()}
          tone="information"
        >
          {snapshot.banner.name
            ? t("artifact.edit.banner.published", {
              name: snapshot.banner.name,
              version: snapshot.banner.versionNumber,
            })
            : t("artifact.edit.banner.publishedUnnamed", {
              version: snapshot.banner.versionNumber,
            })}
        </UI.AlertBanner>
      )}
      {snapshot.banner?.kind === "replaced" && (
        <UI.AlertBanner
          onDismiss={() => session.dismissBanner()}
          tone="information"
        >
          {t("artifact.edit.banner.replaced")}
        </UI.AlertBanner>
      )}
      {snapshot.banner?.kind === "revoked" && (
        <UI.AlertBanner tone="error">
          {t(
            pieces.length > 0
              ? "artifact.edit.banner.revokedUnsaved"
              : "artifact.edit.banner.revoked",
          )}
        </UI.AlertBanner>
      )}
      {restoredShown && restored !== null && pieces.length > 0 &&
        snapshot.banner?.kind !== "revoked" && (
        <UI.AlertBanner
          action={
            <UI.Button
              onClick={() => {
                setRestoredShown(false);
                setSheetOpen(true);
              }}
              variant="outline"
            >
              {t("artifact.edit.restored.review")}
            </UI.Button>
          }
          onDismiss={() => setRestoredShown(false)}
          tone="information"
        >
          {t("artifact.edit.restored.body", { time: clock(restored) })}
        </UI.AlertBanner>
      )}
      {pieces.length > 0 && snapshot.banner?.kind !== "revoked" && (
        <UI.InlineNotice
          action={
            <UI.Button onClick={() => setSheetOpen(true)} variant="outline">
              {t("artifact.edit.refused.show")}
            </UI.Button>
          }
          tone="error"
        >
          {pieces.length > 1
            ? t("artifact.edit.refused.many", { count: pieces.length })
            : pieces[0].cause === "stale"
            ? t("artifact.edit.refused.stale")
            : t("artifact.edit.refused.one")}
        </UI.InlineNotice>
      )}
      {suggestionsHost === null &&
        suggestions.listed.length + (suggestions.phase === "failed" ? 1 : 0) >
          0 &&
        (
          <UI.Button
            data-testid="suggestions-open"
            onClick={() => setSuggestionsOpen(true)}
            variant="outline"
          >
            {suggestions.phase === "failed" && suggestions.listed.length === 0
              ? t("artifact.edit.suggestions.titleNoCount")
              : t("artifact.edit.suggestions.title", {
                count: suggestions.listed.length,
              })}
          </UI.Button>
        )}
      {suggestionsHost !== null &&
        createPortal(<SuggestionsPanel state={suggestions} />, suggestionsHost)}
      <SuggestionsConfirm state={suggestions} />
      {suggestionsHost === null && suggestionsOpen && (
        <UI.Sheet
          dismissLabel={t("artifact.edit.suggestions.sheetClose")}
          onOpenChange={setSuggestionsOpen}
          open
          title={suggestions.phase === "failed" &&
              suggestions.listed.length === 0
            ? t("artifact.edit.suggestions.titleNoCount")
            : t("artifact.edit.suggestions.title", {
              count: suggestions.listed.length,
            })}
          variant="side"
        >
          <SuggestionsPanel
            hideTitle
            afterChoose={() => {
              setSuggestionsOpen(false);
              // Once the sheet is gone, show the text the card points at.
              globalThis.requestAnimationFrame(() => reshowChosen());
            }}
            state={suggestions}
          />
        </UI.Sheet>
      )}
      {bytesUsed >= DOCUMENT_LIMIT_BYTES && (
        <UI.InlineNotice tone="warning">
          {t("artifact.edit.limit")}
        </UI.InlineNotice>
      )}
      <UI.DocumentEditor
        aria-label={t("artifact.edit.label")}
        data-testid="artifact-editor"
        extensions={extensions}
        key={snapshot.documentVersion}
        placeholder={t("artifact.edit.placeholder")}
        readOnly={snapshot.readOnly}
        onViewChange={(view) => {
          editorView.current = view;
        }}
      />
      {snapshot.banner?.kind === "revoked" && pieces.length > 0 && (
        <Pieces
          clock={clock}
          copy={copy}
          onDiscard={setDiscarding}
          pieces={pieces}
          t={t}
        />
      )}
      {sheet}
      {publish.dialog}
      <UI.AlertDialog
        cancelAction={
          <UI.Button onClick={() => setDiscarding(null)} variant="outline">
            {t("artifact.edit.discard.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            onClick={() => {
              if (discarding) session.discardRefused(discarding.id);
              setDiscarding(null);
            }}
            variant="destructive"
          >
            {t("artifact.edit.discard.confirm")}
          </UI.Button>
        }
        onOpenChange={(open) => !open && setDiscarding(null)}
        open={discarding !== null}
        title={t("artifact.edit.discard.title")}
      >
        {t("artifact.edit.discard.body")}
      </UI.AlertDialog>
    </UI.Stack>
  );
}

/** The size the shared text has reached, re-read when it changes. */
function useSizeNote(
  session: CollaborationSession,
  version: number,
  changedAt: number,
): number {
  return useMemo(
    () =>
      new TextEncoder().encode(session.document.getText("body").toString())
        .length,
    // The document's own changes are the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, version, changedAt],
  );
}

function Pieces(
  { clock, copy, onDiscard, pieces, t }: {
    readonly clock: (milliseconds: number) => string;
    readonly copy: (piece: RefusedPiece) => void;
    readonly onDiscard: (piece: RefusedPiece) => void;
    readonly pieces: readonly RefusedPiece[];
    readonly t: ReturnType<typeof useI18n>["translate"];
  },
) {
  return (
    <UI.Stack gap="standard">
      {[...pieces].sort((a, b) => b.typedAt - a.typedAt).map((piece) => (
        <UI.Stack gap="compact" key={piece.id}>
          <UI.Text variant="caption">
            {t("artifact.edit.sheet.typedAt", { time: clock(piece.typedAt) })}
          </UI.Text>
          <UI.DataText state="wrapped" variant="code">{piece.text}</UI.DataText>
          <UI.Inline gap="compact">
            <UI.Button onClick={() => copy(piece)} variant="outline">
              {t("artifact.edit.sheet.copy")}
            </UI.Button>
            <UI.Button
              onClick={() =>
                onDiscard(piece)}
              variant="outline"
            >
              {t("artifact.edit.sheet.discard")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      ))}
    </UI.Stack>
  );
}
