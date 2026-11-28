import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { EditorView } from "@codemirror/view";
import * as UI from "@bakery/ui";
import type { SkillResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  skillDraftQueryOptions,
  skillQueryOptions,
  skillVersionsQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { LeaveGuard } from "./repository-rules/leave-guard.tsx";
import { pickFiles } from "./library/pick-files.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import { sayAboutSkill, SkillToast } from "./library/SkillActions.tsx";
import {
  AddFileDialog,
  RenameFileDialog,
} from "./library/SkillFileDialogs.tsx";
import {
  bytesToBase64,
  type DraftFailure,
  type DraftFile,
  type DraftProblem,
  groupFiles,
  isScript,
  isTextContent,
  isTextMedia,
  pathProblem,
  problemWords,
  sizeWords,
  SKILL_ENTRY_FILE,
  splitName,
} from "./library/skill-draft-state.ts";
import { fileSize } from "./library/skills-state.ts";
import { useSkillDraft } from "./library/useSkillDraft.ts";

type Removed = {
  readonly path: string;
  readonly mediaType: string;
  readonly isExecutable: boolean;
  readonly contentBase64: string;
};

function FailureLine(
  { failure }: { readonly failure: DraftFailure },
) {
  const { translate } = useI18n();
  return (
    <UI.InlineNotice tone="error" role="alert">
      {translate(`library.skills.editor.failure.${failure}` as never)}
    </UI.InlineNotice>
  );
}

function SkillEditor({ skill }: { readonly skill: SkillResponse }) {
  const { translate, locale, timeZone } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const phone = useShellViewport() === "phone";
  const state = useSkillDraft(skill, !phone);
  const { draft } = state;
  const versions = useInfiniteQuery(
    skillVersionsQueryOptions(api, scope, skill.id, 100),
  );
  const [view, setView] = useState<"files" | "file">("files");
  const [dialog, setDialog] = useState<
    "add" | "rename" | "publish" | "discard" | null
  >(null);
  const [working, setWorking] = useState(false);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [entryNote, setEntryNote] = useState(false);
  const [license, setLicense] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const [renaming, setRenaming] = useState<DraftFile | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [left, setLeft] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<
    {
      readonly fileId: string;
      readonly path: string;
      readonly line: number | null;
    } | null
  >(null);
  const editorView = useRef<
    | {
      readonly view: EditorView;
      readonly fileId: string;
      readonly path: string;
    }
    | null
  >(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const held = editorView.current;
    if (
      pendingFocus === null || held?.fileId !== pendingFocus.fileId ||
      held.path !== pendingFocus.path
    ) {
      return;
    }
    const { line: wanted } = pendingFocus;
    requestAnimationFrame(() => {
      const view = editorView.current?.view;
      if (view === undefined) return;
      if (wanted !== null) {
        const line = view.state.doc.line(
          Math.min(Math.max(wanted, 1), view.state.doc.lines),
        );
        view.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true,
        });
      }
      view.focus();
    });
    setPendingFocus(null);
  });
  useEffect(() => {
    if (!left) return;
    void navigate({
      to: "/library/skills/$skillId",
      params: { skillId: skill.id },
    }).then(() => {
      queryClient.removeQueries({
        queryKey: skillDraftQueryOptions(api, scope, skill.id).queryKey,
      });
      return queryClient.invalidateQueries({ queryKey: ["protected"] });
    });
  }, [left]);
  const problemsHeading = useRef<HTMLHeadingElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const nextRevision = (() => {
    const known = versions.data?.pages.flatMap((page) => page.items) ?? [];
    const highest = known.reduce(
      (most, version) => Math.max(most, version.revision),
      skill.activeRevision ?? 0,
    );
    return highest + 1;
  })();
  const open = (next: "add" | "rename" | "publish" | "discard") => {
    opener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setDialog(next);
  };
  const close = () => {
    setDialog(null);
    focusAfterPaint(() => opener.current);
  };
  const when = (at: number) =>
    new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(
      new Date(at),
    );

  if (draft === undefined) return null;
  const { entry, others } = groupFiles(draft);
  const problems = state.checked?.result.problems ?? [];
  const stale = state.checked !== null &&
    state.checked.result.draftVersion !== draft.version;
  const problemFiles = new Set(
    problems.flatMap((problem) => problem.file === null ? [] : [problem.file]),
  );

  const chooseFile = (file: DraftFile) => {
    state.select(file.id);
    setView("file");
  };
  const focusEditor = (
    file: Pick<DraftFile, "id" | "path">,
    line: number | null = null,
  ) => {
    setPendingFocus({ fileId: file.id, path: file.path, line });
  };
  const openProblem = (problem: DraftProblem) => {
    const target = problem.file === null
      ? null
      : draft.files.find((item) => item.path === problem.file) ?? null;
    if (target === null) return;
    chooseFile(target);
    focusEditor(target, problem.line);
  };
  const focusFile = (fileId: string) =>
    focusAfterPaint(() =>
      document.querySelector<HTMLElement>(
        `[data-testid="skill-editor-files"] [data-file="${fileId}"] button.ui-list-row__control`,
      )
    );
  const focusRow = (index: number) =>
    focusAfterPaint(() => {
      const rows = document.querySelectorAll<HTMLElement>(
        '[data-testid="skill-editor-files"] [data-file] button.ui-list-row__control',
      );
      return rows[Math.min(index, rows.length - 1)] ?? null;
    });

  const run = async (task: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await task();
    } finally {
      setWorking(false);
    }
  };

  const publish = () =>
    void run(async () => {
      const result = await state.check();
      if (result === null) return;
      if (!result.ok) {
        setShowProblems(true);
        focusAfterPaint(() => problemsHeading.current);
        return;
      }
      open("publish");
    });
  const confirmPublish = () =>
    void run(async () => {
      const made = await state.publish();
      if (made === null) {
        setDialog(null);
        return;
      }
      sayAboutSkill(
        translate("library.skills.editor.published", { number: made.revision }),
      );
      setDialog(null);
      setLeft(true);
    });
  const confirmDiscard = () =>
    void run(async () => {
      if (await state.discard()) setLeft(true);
      setDialog(null);
    });
  const upload = () =>
    pickFiles(true, (picked) =>
      void run(async () => {
        setDialog(null);
        const taken: string[] = [];
        let last: DraftFile | null = null;
        for (const one of picked) {
          if (pathProblem(draft.files, one.name) !== null) {
            taken.push(one.name);
            continue;
          }
          last =
            await state.addFile(one.name, false, bytesToBase64(one.bytes)) ??
              last;
        }
        setSkipped(taken);
        if (last === null) focusAfterPaint(() => opener.current);
        else focusFile(last.id);
      }));
  const focusReplace = () =>
    focusAfterPaint(() =>
      document.querySelector<HTMLElement>("[data-replace-file]")
    );
  const replace = (file: DraftFile) =>
    pickFiles(
      false,
      ([picked]) =>
        void run(async () => {
          const content = bytesToBase64(picked!.bytes);
          const replaced = await state.replaceFile(file, content);
          if (replaced === null) return;
          if (isTextContent(content)) focusEditor(replaced);
          else focusReplace();
        }),
    );
  const loadLatest = () =>
    void run(async () => {
      const fileId = await state.loadLatest();
      const file = draft.files.find((item) => item.id === fileId);
      if (file !== undefined) focusEditor(file);
    });
  const remove = (file: DraftFile) =>
    void run(async () => {
      const index = draft.files.findIndex((item) => item.id === file.id);
      if (file.path === draft.entryPath) {
        setEntryNote(true);
        return;
      }
      setEntryNote(false);
      const gone = await state.removeFile(file);
      if (gone === null) return;
      focusRow(index);
      setRemoved({
        path: gone.path,
        mediaType: gone.mediaType,
        isExecutable: gone.isExecutable,
        contentBase64: gone.contentBase64,
      });
    });

  const saveLine = state.save.kind === "saving"
    ? translate("library.skills.editor.saving")
    : state.save.kind === "saved"
    ? translate("library.skills.editor.savedAt", { time: when(state.save.at) })
    : state.save.kind === "failed"
    ? translate("library.skills.editor.notSaved")
    : null;

  const publishButton = (
    <UI.Button
      variant="primary"
      disabled={working}
      onClick={publish}
    >
      {translate("library.skills.editor.publish")}
    </UI.Button>
  );
  const actions = (
    <UI.Inline gap="compact" data-testid="skill-editor-actions">
      <UI.Button
        variant="secondary"
        disabled={working}
        onClick={() => open("discard")}
      >
        {translate("library.skills.editor.discard")}
      </UI.Button>
      <UI.Button
        variant="secondary"
        disabled={working}
        onClick={() =>
          void run(async () => {
            const result = await state.check();
            if (result !== null) setShowProblems(true);
          })}
      >
        {translate("library.skills.editor.check")}
      </UI.Button>
      {publishButton}
    </UI.Inline>
  );

  const fileRow = (file: DraftFile) => (
    <UI.ListRow
      badge={problemFiles.has(file.path)
        ? (
          <UI.Badge tone="danger">
            {translate("library.skills.editor.files.problemMark")}
          </UI.Badge>
        )
        : undefined}
      controlLabel={translate("library.skills.editor.files.openLabel", {
        file: file.path,
      })}
      data-selected={state.selectedId === file.id ? "true" : undefined}
      detail={fileSize(file.sizeBytes, locale)}
      onSelect={() => chooseFile(file)}
      title={splitName(file.path).head}
      titleEnd={splitName(file.path).end}
    />
  );
  const fileItem = (file: DraftFile) => {
    const actionsFor = translate("library.skills.editor.file.actions", {
      file: file.path,
    });
    return (
      <UI.Inline
        data-controls="file-row"
        data-file={file.id}
        gap="compact"
        key={file.id}
        role="listitem"
      >
        {fileRow(file)}
        <UI.Popover
          align="end"
          label={actionsFor}
          onOpenChange={(next) => setMenuFor(next ? file.id : null)}
          open={menuFor === file.id}
          trigger={translate("library.skill.actions.more")}
          triggerAppearance="toolbar"
          triggerLabel={actionsFor}
          variant="interactive"
        >
          <UI.Menu
            aria-label={actionsFor}
            items={[
              {
                id: "rename",
                label: translate("library.skills.editor.file.rename"),
              },
              {
                id: "remove",
                label: translate("library.skills.editor.file.remove"),
              },
            ]}
            onSelect={(id) => {
              setMenuFor(null);
              if (id === "remove") remove(file);
              else {
                setRenaming(file);
                open("rename");
              }
            }}
          />
        </UI.Popover>
      </UI.Inline>
    );
  };
  const fileList = (
    <UI.Stack gap="standard" data-testid="skill-editor-files">
      <UI.Heading level="subsection" rank={2}>
        {translate("library.skills.editor.files.title")}
      </UI.Heading>
      {entry === null && others.length === 0 ? null : (
        <UI.Stack gap="compact">
          {entry === null ? null : (
            <UI.Stack gap="none">
              <UI.Text variant="strong">
                {translate("library.skills.editor.files.instructions")}
              </UI.Text>
              <UI.Stack
                aria-label={translate(
                  "library.skills.editor.files.instructions",
                )}
                gap="none"
                role="list"
              >
                {fileItem(entry)}
              </UI.Stack>
            </UI.Stack>
          )}
          {others.length === 0 ? null : (
            <UI.Stack gap="none">
              <UI.Text variant="strong">
                {translate("library.skills.editor.files.others")}
              </UI.Text>
              <UI.Stack
                aria-label={translate("library.skills.editor.files.others")}
                gap="none"
                role="list"
              >
                {others.map(fileItem)}
              </UI.Stack>
            </UI.Stack>
          )}
        </UI.Stack>
      )}
      {entryNote
        ? (
          <UI.InlineNotice tone="warning">
            {translate("library.skills.editor.file.entryRemove")}
          </UI.InlineNotice>
        )
        : null}
      {skipped.length === 0 ? null : (
        <UI.InlineNotice tone="warning">
          {translate("library.skills.editor.addFile.skipped", {
            names: skipped.join(", "),
          })}
        </UI.InlineNotice>
      )}
      <UI.Button
        variant="secondary"
        disabled={working}
        onClick={() => open("add")}
      >
        {translate("library.skills.editor.files.add")}
      </UI.Button>
      <UI.Text variant="caption" data-testid="skill-editor-size">
        {translate(
          sizeWords(draft, locale).key,
          sizeWords(draft, locale).values,
        )}
      </UI.Text>
    </UI.Stack>
  );
  const settings = (
    <UI.Stack gap="standard" data-testid="skill-editor-settings">
      {draft.files.length === 0 ? null : (
        <UI.Stack gap="tight">
          <UI.Combobox
            label={translate("library.skills.editor.settings.entry")}
            name="skill-entry-path"
            value={draft.entryPath}
            disabled={working}
            options={draft.files.map((file) => ({
              label: file.path,
              value: file.path,
            }))}
            onChange={(event) => {
              const value = event.target.value;
              if (value !== draft.entryPath) {
                void run(() => state.changeSettings({ entryPath: value }));
              }
            }}
          />
          <UI.Text variant="caption">
            {translate("library.skills.editor.settings.entryHelp")}
          </UI.Text>
        </UI.Stack>
      )}
      <UI.Field
        label={translate("library.skills.editor.settings.license")}
        htmlFor="skill-license"
        hint={translate("library.skills.editor.settings.licenseHelp")}
      >
        <UI.TextInput
          id="skill-license"
          name="license"
          type="text"
          autoComplete="off"
          value={license ?? draft.license ?? ""}
          onChange={(value) => setLicense(value.slice(0, 200))}
          onBlur={() => {
            if (license === null || license === (draft.license ?? "")) return;
            void run(() => state.changeSettings({ license }));
          }}
        />
      </UI.Field>
    </UI.Stack>
  );

  const selected = state.selected;
  const editorPane = selected === null
    ? draft.files.length === 0
      ? (
        <UI.EmptyState
          title={translate("library.skills.editor.empty.title")}
          description={translate("library.skills.editor.empty.description")}
          action={
            <UI.Button
              variant="primary"
              disabled={working}
              onClick={() => void run(() => state.addFile(SKILL_ENTRY_FILE))}
            >
              {translate("library.skills.editor.empty.action")}
            </UI.Button>
          }
          variant="firstUse"
        />
      )
      : null
    : (
      <UI.Stack gap="standard" data-testid="skill-editor-file">
        {phone
          ? (
            <UI.Button variant="quiet" onClick={() => setView("files")}>
              {translate("library.skills.editor.backToFiles")}
            </UI.Button>
          )
          : null}
        <UI.DataText>{selected.path}</UI.DataText>
        {state.text && isScript(selected.path)
          ? (
            <UI.Checkbox
              checked={selected.isExecutable}
              disabled={working}
              onChange={(event) =>
                void run(() =>
                  state.setRunnable(selected, event.currentTarget.checked)
                )}
            >
              {translate("library.skills.editor.file.runnable")}
            </UI.Checkbox>
          )
          : null}
        {!state.text
          ? (
            <UI.InlineNotice
              tone="information"
              action={
                <UI.Inline gap="compact">
                  <UI.Button
                    data-replace-file=""
                    variant="secondary"
                    disabled={working}
                    onClick={() => replace(selected)}
                  >
                    {translate("library.skills.editor.file.replace")}
                  </UI.Button>
                  <UI.Button
                    variant="secondary"
                    disabled={working}
                    onClick={() => remove(selected)}
                  >
                    {translate("library.skills.editor.file.remove")}
                  </UI.Button>
                </UI.Inline>
              }
            >
              {translate("library.skills.editor.file.notText")}
            </UI.InlineNotice>
          )
          : state.bodyFailed
          ? (
            <UI.InlineNotice
              tone="error"
              action={
                <UI.Button variant="secondary" onClick={state.retryBody}>
                  {translate("core.actions.retry")}
                </UI.Button>
              }
            >
              {translate("library.skills.editor.file.loadFailed")}
            </UI.InlineNotice>
          )
          : state.body === null
          ? <UI.Skeleton shape="row" />
          : (
            <UI.DocumentEditor
              aria-label={translate("library.skills.editor.file.label", {
                file: selected.path,
              })}
              data-testid="skill-editor-text"
              extensions={[
                EditorView.updateListener.of((update) => {
                  if (update.docChanged) {
                    state.edit(selected.id, update.state.doc.toString());
                  }
                }),
              ]}
              initialText={state.body}
              onViewChange={(view) => {
                editorView.current = view === null
                  ? null
                  : { view, fileId: selected.id, path: selected.path };
              }}
              key={`${selected.id}:${selected.path}:${
                state.reloads[selected.id] ?? 0
              }`}
            />
          )}
        {saveLine === null
          ? null
          : (
            <UI.Inline gap="compact" data-testid="skill-editor-save">
              <UI.Text variant="caption" role="status">{saveLine}</UI.Text>
              {state.save.kind === "failed"
                ? (
                  <UI.Button variant="quiet" onClick={state.retrySave}>
                    {translate("core.actions.retry")}
                  </UI.Button>
                )
                : null}
            </UI.Inline>
          )}
      </UI.Stack>
    );

  const problemsPanel = !showProblems || state.checked === null
    ? null
    : (
      <UI.Stack gap="compact" data-testid="skill-editor-problems">
        {problems.length === 0
          ? (
            <UI.InlineNotice tone="success">
              {translate("library.skills.editor.problems.none")}
            </UI.InlineNotice>
          )
          : (
            <>
              <UI.Heading level="subsection" rank={2}>
                <span
                  ref={(node) => {
                    problemsHeading.current = node as HTMLHeadingElement | null;
                  }}
                  tabIndex={-1}
                >
                  {translate("library.skills.editor.problems.title", {
                    count: problems.length,
                  })}
                </span>
              </UI.Heading>
              <UI.Stack gap="none" role="list">
                {problems.map((problem, index) => {
                  const words = problemWords(problem);
                  return (
                    <UI.ListRow
                      controlLabel={translate(
                        words.key,
                        words.values,
                      )}
                      key={index}
                      onSelect={() => openProblem(problem)}
                      role="listitem"
                      title={translate(words.key, words.values)}
                    />
                  );
                })}
              </UI.Stack>
            </>
          )}
        {stale
          ? (
            <UI.InlineNotice
              tone="information"
              action={
                <UI.Button
                  variant="secondary"
                  disabled={working}
                  onClick={() => void run(() => state.check())}
                >
                  {translate("core.actions.checkAgain")}
                </UI.Button>
              }
            >
              {translate("library.skills.editor.problems.stale")}
            </UI.InlineNotice>
          )
          : null}
      </UI.Stack>
    );

  const conflictFile = state.save.kind === "conflict"
    ? draft.files.find((file) =>
      file.id === (state.save as {
        fileId: string;
      }).fileId
    )?.path ?? ""
    : null;
  const notices = (
    <>
      {conflictFile === null ? null : (
        <UI.InlineNotice
          tone="warning"
          data-testid="skill-editor-conflict"
          action={
            <UI.Button
              variant="secondary"
              onClick={loadLatest}
            >
              {translate("library.skills.editor.conflict.load")}
            </UI.Button>
          }
        >
          {translate("library.skills.editor.conflict.text", {
            file: conflictFile,
          })}
        </UI.InlineNotice>
      )}
      {state.writeFailure === null
        ? null
        : <FailureLine failure={state.writeFailure} />}
      {state.save.kind === "failed" && state.save.failure !== "conflict"
        ? <FailureLine failure={state.save.failure} />
        : null}
    </>
  );

  const header = (
    <>
      {!phone ? <ShellSlot name="actions">{actions}</ShellSlot> : null}
      <UI.PageHeader
        variant="list"
        flush
        title={skill.name}
        actions={phone ? actions : null}
        subtitle={
          <UI.Stack gap="compact">
            <UI.Text variant="muted">
              {draft.baseRevision === null
                ? translate("library.skills.editor.draftNew")
                : translate("library.skills.editor.draftBased", {
                  number: draft.baseRevision,
                })}
            </UI.Text>
            <UI.Text variant="caption">
              {translate("library.skills.editor.untilPublish")}
            </UI.Text>
          </UI.Stack>
        }
      />
    </>
  );

  const body = phone
    ? (
      <UI.Stack gap="spacious">
        {notices}
        {view === "file" && selected !== null ? editorPane : (
          <>
            {problemsPanel}
            {draft.files.length === 0 ? editorPane : null}
            {fileList}
            {settings}
          </>
        )}
      </UI.Stack>
    )
    : (
      <UI.FormWithSummary
        asideAt="start"
        aside={
          <UI.Stack gap="spacious">
            {fileList}
            {settings}
          </UI.Stack>
        }
      >
        <UI.Stack gap="spacious">
          {notices}
          {problemsPanel}
          {editorPane}
        </UI.Stack>
      </UI.FormWithSummary>
    );

  return (
    <>
      <SkillToast />
      <LeaveGuard
        count={left ? 0 : state.unsavedFiles}
        discard={state.drop}
        path={`/library/skills/${skill.id}/edit`}
        copy={{
          title: "library.skills.editor.leave.title",
          body: "library.skills.editor.leave.body",
          stay: "library.skills.editor.leave.stay",
          confirm: "library.skills.editor.leave.confirm",
        }}
      />
      {removed === null ? null : (
        <UI.Toast
          data-testid="skill-editor-removed"
          tone="information"
          onDismiss={() => setRemoved(null)}
          action={
            <UI.Button
              variant="quiet"
              onClick={() => {
                const back = removed;
                setRemoved(null);
                void run(async () => {
                  const restored = await state.restoreFile(back);
                  if (restored !== null) focusFile(restored.id);
                });
              }}
            >
              {translate("library.skills.editor.file.undo")}
            </UI.Button>
          }
        >
          {translate("library.skills.editor.file.removed", {
            file: removed.path,
          })}
        </UI.Toast>
      )}
      {header}
      {body}
      {dialog === "add"
        ? (
          <AddFileDialog
            files={draft.files}
            busy={working}
            suggestion={draft.files.length === 0 ? SKILL_ENTRY_FILE : ""}
            onClose={close}
            onUpload={upload}
            onAdd={(path, runnable) =>
              void run(async () => {
                const added = await state.addFile(path, runnable);
                if (added !== null) {
                  setDialog(null);
                  if (phone) setView("file");
                } else setDialog(null);
              })}
          />
        )
        : null}
      {dialog === "rename" && renaming !== null
        ? (
          <RenameFileDialog
            files={draft.files}
            file={renaming}
            busy={working}
            onClose={close}
            onRename={(newPath) =>
              void run(async () => {
                const renamed = await state.renameFile(renaming, newPath);
                setDialog(null);
                if (renamed === null) return;
                if (phone) setView("file");
                if (isTextMedia(renamed.mediaType)) focusEditor(renamed);
                else focusReplace();
              })}
          />
        )
        : null}
      <UI.AlertDialog
        open={dialog === "publish"}
        onOpenChange={(next) => !next && !working && close()}
        title={translate("library.skills.editor.publish.title", {
          number: nextRevision,
        })}
        cancelAction={
          <UI.Button variant="outline" onClick={close} disabled={working}>
            {translate("core.actions.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            variant="primary"
            onClick={confirmPublish}
            disabled={working}
          >
            {translate("library.skills.editor.publish.confirm")}
          </UI.Button>
        }
      >
        {translate("library.skills.editor.publish.body", {
          number: nextRevision,
        })}
      </UI.AlertDialog>
      <UI.AlertDialog
        open={dialog === "discard"}
        onOpenChange={(next) => !next && !working && close()}
        title={translate("library.skills.editor.discard.title")}
        variant="destructive"
        cancelAction={
          <UI.Button variant="outline" onClick={close} disabled={working}>
            {translate("core.actions.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            variant="destructive"
            onClick={confirmDiscard}
            disabled={working}
          >
            {translate("library.skills.editor.discard.confirm")}
          </UI.Button>
        }
      >
        {draft.baseRevision === null
          ? translate("library.skills.editor.discard.bodyNew")
          : translate("library.skills.editor.discard.body", {
            number: draft.baseRevision,
          })}
      </UI.AlertDialog>
    </>
  );
}
export function SkillEditorPage({ skillId }: { readonly skillId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const read = useQuery(skillQueryOptions(api, scope, skillId));
  const skill = read.data;
  const state = useSkillDraftGate(skillId);

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          { href: "/library?tab=skills", label: translate("library.title") },
          {
            href: `/library/skills/${skillId}`,
            label: skill === undefined
              ? translate("library.skill.back")
              : skill.name,
          },
          { label: translate("library.skills.editor.crumb") },
        ]}
      />
    </ShellSlot>
  );
  const heading = (
    <UI.PageHeader
      variant="list"
      flush
      title={translate("library.skills.editor.crumb")}
    />
  );
  const back = () =>
    void navigate({
      to: "/library/skills/$skillId",
      params: { skillId },
    });
  const frame = (content: React.ReactNode) => (
    <>
      {breadcrumbs}
      <UI.SettingsContent data-testid="skill-editor-page" variant="wide">
        {content}
      </UI.SettingsContent>
    </>
  );

  if (read.isPending) {
    return frame(
      <>
        {heading}
        <UI.Stack gap="standard" aria-busy="true">
          <UI.Text variant="muted" role="status">
            {translate("library.skills.editor.loading")}
          </UI.Text>
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="row" />
        </UI.Stack>
      </>,
    );
  }
  if (read.isError || skill === undefined) {
    const missing = failureStatus(read.error) === 404 ||
      isForbiddenFailure(read.error);
    const offline = asyncKindForError(read.error) === "offline";
    return frame(
      <>
        {heading}
        {missing
          ? (
            <UI.EmptyState
              title={translate("library.skill.notFound.title")}
              description={translate("library.skill.notFound.description")}
              action={
                <UI.Button variant="secondary" onClick={back}>
                  {translate("library.skill.notFound.back")}
                </UI.Button>
              }
              variant="filtered"
            />
          )
          : (
            <UI.ErrorState
              title={translate(
                offline ? "library.offlineTitle" : "library.skill.error",
              )}
              description={translate(
                offline
                  ? "library.offlineDescription"
                  : "library.error.description",
              )}
              action={
                <UI.Button
                  variant="secondary"
                  onClick={() => void read.refetch()}
                >
                  {translate("library.retry")}
                </UI.Button>
              }
            />
          )}
      </>,
    );
  }
  if (skill.scope === "global") {
    return frame(
      <>
        {heading}
        <UI.EmptyState
          title={translate("library.skills.editor.shared.title")}
          description={translate("library.skills.editor.shared.description")}
          action={
            <UI.Button variant="secondary" onClick={back}>
              {translate("library.skill.notFound.back")}
            </UI.Button>
          }
          variant="filtered"
        />
      </>,
    );
  }
  if (state.kind === "loading") {
    return frame(
      <>
        {heading}
        <UI.Stack gap="standard" aria-busy="true">
          <UI.Text variant="muted" role="status">
            {translate("library.skills.editor.loading")}
          </UI.Text>
          <UI.Skeleton shape="row" />
          <UI.Skeleton shape="row" />
        </UI.Stack>
      </>,
    );
  }
  if (state.kind === "none") {
    return frame(
      <>
        {heading}
        <UI.EmptyState
          title={translate("library.skills.editor.noDraft.title")}
          description={translate("library.skills.editor.noDraft.description")}
          action={
            <UI.Button
              variant="primary"
              loading={state.opening}
              onClick={() => void state.open()}
            >
              {translate("library.skills.editor.noDraft.action")}
            </UI.Button>
          }
          variant="firstUse"
        />
      </>,
    );
  }
  if (state.kind === "forbidden") {
    return frame(
      <>
        {heading}
        <UI.EmptyState
          title={translate("library.skills.editor.forbidden.title")}
          description={translate(
            "library.skills.editor.forbidden.description",
          )}
          action={
            <UI.Button variant="secondary" onClick={back}>
              {translate("library.skill.notFound.back")}
            </UI.Button>
          }
          variant="filtered"
        />
      </>,
    );
  }
  if (state.kind === "error") {
    return frame(
      <>
        {heading}
        <UI.ErrorState
          title={translate("library.skills.editor.error")}
          description={translate("library.error.description")}
          action={
            <UI.Button variant="secondary" onClick={state.retry}>
              {translate("library.retry")}
            </UI.Button>
          }
        />
      </>,
    );
  }
  return frame(<SkillEditor key={skill.id} skill={skill} />);
}

type Gate =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "forbidden" }
  | {
    readonly kind: "none";
    readonly opening: boolean;
    readonly open: () => Promise<void>;
  }
  | { readonly kind: "error"; readonly retry: () => void };

function useSkillDraftGate(skillId: string): Gate {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const options = skillDraftQueryOptions(api, scope, skillId);
  const read = useQuery(options);
  const [opening, setOpening] = useState(false);
  if (read.data !== undefined) return { kind: "ready" };
  if (read.isPending) return { kind: "loading" };
  if (isForbiddenFailure(read.error)) return { kind: "forbidden" };
  if (failureStatus(read.error) === 404) {
    return {
      kind: "none",
      opening,
      open: async () => {
        setOpening(true);
        const result = await api.openSkillDraft({
          organizationId: scope.organizationId as string,
          id: skillId,
        });
        setOpening(false);
        if (result.ok) queryClient.setQueryData(options.queryKey, result.data);
        else await read.refetch();
      },
    };
  }
  return { kind: "error", retry: () => void read.refetch() };
}
