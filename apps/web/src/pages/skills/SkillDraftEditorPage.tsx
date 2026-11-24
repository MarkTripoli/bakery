import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  ApiFailure,
  SkillDraftCheckResponse,
  SkillDraftFileResponse,
  SkillDraftResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { skillQueryOptions } from "../../api/query.ts";
import { asyncKindForError } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  checkIsStale,
  decodeSkillText,
  draftFilesOf,
  type DraftProblem,
  draftWouldOverflow,
  encodeSkillText,
  isTextMediaType,
  problemsOf,
  SKILL_DRAFT_LIMIT_BYTES,
  SKILL_DRAFT_LIMIT_FILES,
} from "./draft-state.ts";

type Refusal = "conflict" | "failed" | "tooBig" | "offline" | "forbidden";

function refusalOf(failure: ApiFailure): Refusal {
  const kind = asyncKindForError(failure);
  if (kind === "offline") return "offline";
  if (kind === "forbidden") return "forbidden";
  if (failure.kind === "problem" && failure.problem.status === 412) {
    return "conflict";
  }
  if (failure.kind === "problem" && failure.problem.status === 413) {
    return "tooBig";
  }
  return "failed";
}

export function SkillDraftEditorPage({ skillId }: { skillId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const viewport = useShellViewport();
  const phone = viewport === "phone";
  const { translate: t } = useI18n();
  const organizationId = scope.organizationId;

  const skill = useQuery(skillQueryOptions(api, scope, skillId));
  const draftKey = useMemo(
    () => ["skillDraft", organizationId ?? "", skillId] as const,
    [organizationId, skillId],
  );
  const draft = useQuery<SkillDraftResponse, ApiFailure>({
    queryKey: [...draftKey],
    enabled: organizationId !== null && skillId !== "",
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await api.openSkillDraft({
        organizationId: organizationId as string,
        id: skillId,
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
  });

  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [refusedFile, setRefusedFile] = useState<string | null>(null);
  const [check, setCheck] = useState<SkillDraftCheckResponse | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  const problemsHeading = useRef<HTMLHeadingElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [line, setLine] = useState<number | null>(null);

  const current = draft.data;
  const files = current === undefined ? [] : draftFilesOf(current);
  const chosen = path ?? current?.entryPath ?? files[0]?.path ?? null;
  const chosenFile = files.find((file) => file.path === chosen) ?? null;
  const textFile = chosenFile !== null && isTextMediaType(chosenFile.mediaType);

  const fileQuery = useQuery<SkillDraftFileResponse, ApiFailure>({
    queryKey: [...draftKey, "file", chosenFile?.id ?? ""],
    enabled: organizationId !== null && chosenFile !== null && textFile,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await api.getSkillDraftFile({
        organizationId: organizationId as string,
        id: skillId,
        fileId: chosenFile?.id as string,
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
  });

  useEffect(() => {
    if (fileQuery.data === undefined) return;
    setText(decodeSkillText(fileQuery.data.contentBase64));
    setTouched(false);
  }, [fileQuery.data]);

  useEffect(() => {
    if (line === null || editorRef.current === null) return;
    const rows = text.split("\n");
    const start = rows.slice(0, Math.max(0, line - 1)).join("\n").length;
    const end = start + (rows[Math.max(0, line - 1)] ?? "").length;
    editorRef.current.focus();
    editorRef.current.setSelectionRange(start, end);
    setLine(null);
  }, [line, text]);

  const problems = check === null ? [] : problemsOf(check);
  const stale = check !== null && current !== undefined &&
    checkIsStale(check, current);

  const refreshDraft = (next: SkillDraftResponse) =>
    cache.setQueryData([...draftKey], next);

  const saveFile = async () => {
    if (current === undefined || chosen === null || organizationId === null) {
      return;
    }
    const bytes = new TextEncoder().encode(text).length;
    if (
      draftWouldOverflow(
        current.totalBytes - (chosenFile?.sizeBytes ?? 0) + bytes,
      )
    ) {
      setRefusal("tooBig");
      return;
    }
    setRefusal(null);
    const result = await api.saveSkillDraftFile({
      organizationId,
      id: skillId,
      path: chosen,
      mediaType: chosenFile?.mediaType ?? "text/markdown",
      contentBase64: encodeSkillText(text),
      isExecutable: chosenFile?.isExecutable,
      version: current.version,
      idempotencyKey: `skill-file-${current.id}-${current.version}-${chosen}`,
    });
    if (!result.ok) {
      setRefusedFile(chosen);
      setRefusal(refusalOf(result.error));
      return;
    }
    setTouched(false);
    refreshDraft(result.data);
    await cache.invalidateQueries({ queryKey: [...draftKey, "file"] });
  };

  const saveSettings = async (
    patch: { license?: string; entryPath?: string },
  ) => {
    if (current === undefined || organizationId === null) return;
    const result = await api.updateSkillDraft({
      organizationId,
      id: skillId,
      version: current.version,
      ...patch,
      idempotencyKey: `skill-draft-${current.id}-${current.version}`,
    });
    if (!result.ok) {
      setRefusal(refusalOf(result.error));
      return;
    }
    setRefusal(null);
    refreshDraft(result.data);
  };

  const runCheck = async (): Promise<SkillDraftCheckResponse | null> => {
    if (organizationId === null) return null;
    const result = await api.checkSkillDraft({
      organizationId,
      id: skillId,
      idempotencyKey: `skill-check-${organizationId}-${skillId}-${Date.now()}`,
    });
    if (!result.ok) {
      setRefusal(refusalOf(result.error));
      return null;
    }
    setRefusal(null);
    setCheck(result.data);
    return result.data;
  };

  const publish = async () => {
    if (current === undefined || organizationId === null) return;
    const result = await api.checkSkillDraft({
      organizationId,
      id: skillId,
      idempotencyKey: `skill-check-${organizationId}-${skillId}-${Date.now()}`,
    });
    if (!result.ok) {
      setRefusal(refusalOf(result.error));
      return;
    }
    setCheck(result.data);
    if (!result.data.ok) {
      setPublishOpen(false);
      problemsHeading.current?.focus();
      return;
    }
    setPublishOpen(true);
  };

  const publishNow = async () => {
    if (current === undefined || organizationId === null) return;
    const result = await api.publishSkillDraft({
      organizationId,
      id: skillId,
      version: current.version,
      idempotencyKey: `skill-publish-${current.id}-${current.version}`,
    });
    setPublishOpen(false);
    if (!result.ok) {
      setRefusal(refusalOf(result.error));
      return;
    }
    setPublished(result.data.revision);
    await cache.invalidateQueries({ queryKey: [...draftKey] });
  };

  const discard = async () => {
    if (current === undefined || organizationId === null) return;
    const result = await api.discardSkillDraft({
      organizationId,
      id: skillId,
      version: current.version,
      idempotencyKey: `skill-discard-${current.id}-${current.version}`,
    });
    setDiscardOpen(false);
    if (!result.ok) {
      setRefusal(refusalOf(result.error));
      return;
    }
    await navigate({
      to: "/library/skills/$skillId",
      params: { skillId },
    });
  };

  const openProblem = (problem: DraftProblem) => {
    if (problem.file !== null) setPath(problem.file);
    if (problem.line !== null) setLine(problem.line);
  };

  if (draft.isError) {
    return (
      <UI.EmptyState
        variant="filtered"
        title={t("library.skills.editor.error")}
        action={
          <UI.Button
            variant="secondary"
            onClick={() => void draft.refetch()}
          >
            {t("library.skills.editor.checkAgain")}
          </UI.Button>
        }
      />
    );
  }
  if (current === undefined) {
    return (
      <UI.Stack
        aria-busy="true"
        aria-label={t("library.skills.editor.loading")}
      >
        <UI.Skeleton shape="text" />
        <UI.Skeleton shape="surface" />
      </UI.Stack>
    );
  }

  const showList = !phone || chosen === null || path === null;
  const base = current.baseRevision;
  const problemRows = problems.map((problem, index) => (
    <UI.Link
      key={`${problem.code}-${String(index)}`}
      onClick={() => openProblem(problem)}
    >
      {problem.file === null || problem.line === null
        ? t("library.skills.editor.problems.whole", {
          message: problem.message,
        })
        : t("library.skills.editor.problems.row", {
          file: problem.file,
          line: String(problem.line),
          message: problem.message,
        })}
    </UI.Link>
  ));

  return (
    <>
      <UI.PageHeader
        variant="list"
        flush
        title={skill.data?.name ?? ""}
        subtitle={base === null
          ? t("library.skills.editor.baseNew")
          : t("library.skills.editor.base", { revision: String(base) })}
        actions={
          <UI.Inline gap="compact">
            <UI.Button
              variant="secondary"
              onClick={() => setDiscardOpen(true)}
            >
              {t("library.skills.editor.discard")}
            </UI.Button>
            <UI.Button variant="secondary" onClick={() => void runCheck()}>
              {t("library.skills.editor.check")}
            </UI.Button>
            <UI.Button variant="primary" onClick={() => void publish()}>
              {t("library.skills.editor.publish")}
            </UI.Button>
          </UI.Inline>
        }
      />
      <UI.Stack gap="standard" data-testid="skill-draft-editor">
        {published === null ? null : (
          <UI.InlineNotice tone="success">
            {t("library.skills.editor.published", {
              revision: String(published),
            })}
          </UI.InlineNotice>
        )}
        {refusal === null ? null : (
          <UI.InlineNotice
            tone={refusal === "conflict" ? "warning" : "error"}
            action={refusal === "conflict"
              ? (
                <UI.Button
                  variant="secondary"
                  onClick={() => {
                    setRefusal(null);
                    void cache.invalidateQueries({
                      queryKey: [...draftKey],
                    });
                  }}
                >
                  {t("library.skills.editor.conflict.load")}
                </UI.Button>
              )
              : undefined}
          >
            {refusal === "conflict"
              ? t("library.skills.editor.conflict.notice", {
                file: refusedFile ?? chosen ?? "",
              })
              : refusal === "tooBig"
              ? t("library.skills.editor.tooBig")
              : refusal === "offline"
              ? t("library.skills.editor.error")
              : t("library.skills.editor.error")}
          </UI.InlineNotice>
        )}
        {check === null ? null : check.ok
          ? (
            <UI.InlineNotice tone="success">
              {stale
                ? t("library.skills.editor.stale")
                : t("library.skills.editor.checked")}
              {stale
                ? (
                  <UI.Button variant="quiet" onClick={() => void runCheck()}>
                    {t("library.skills.editor.checkAgain")}
                  </UI.Button>
                )
                : null}
            </UI.InlineNotice>
          )
          : (
            <UI.Stack gap="tight" data-testid="skill-draft-problems">
              <div ref={problemsHeading} tabIndex={-1}>
                <UI.Heading level="section">
                  {t("library.skills.editor.problems.heading", {
                    count: String(problems.length),
                  })}
                </UI.Heading>
              </div>
              {problemRows}
            </UI.Stack>
          )}
        <UI.Inline gap="standard">
          {showList
            ? (
              <UI.Stack gap="compact" data-testid="skill-draft-files">
                <UI.Heading level="section">
                  {t("library.skills.editor.files.label")}
                </UI.Heading>
                <UI.ListSection title={t("library.skills.editor.files.label")}>
                  {files.map((file) => (
                    <UI.ListRow
                      key={file.id}
                      title={file.path}
                      controlLabel={file.path}
                      selected={file.path === chosen}
                      onSelect={() => {
                        setPath(file.path);
                        setRefusal(null);
                      }}
                      trailing={
                        <UI.Menu
                          aria-label={file.path}
                          items={[
                            {
                              id: "rename",
                              label: t("library.skills.editor.files.rename"),
                            },
                            {
                              id: "remove",
                              label: t("library.skills.editor.files.remove"),
                            },
                          ]}
                          onSelect={(id) => {
                            if (id === "rename") setRenaming(file.path);
                            if (id === "remove") setRemoving(file.path);
                          }}
                        />
                      }
                    />
                  ))}
                </UI.ListSection>
                <UI.Button variant="secondary" onClick={() => setAdding(true)}>
                  {t("library.skills.editor.files.add")}
                </UI.Button>
                <UI.Text variant="muted" data-testid="skill-draft-size">
                  {t("library.skills.editor.size", {
                    used: `${
                      (current.totalBytes / 1_000_000).toFixed(
                        current.totalBytes % 1_000_000 === 0 ? 0 : 1,
                      )
                    } MB`,
                    files: String(files.length),
                    limit: String(SKILL_DRAFT_LIMIT_FILES),
                  })}
                </UI.Text>
                <UI.Field
                  label={t("library.skills.editor.settings.entry")}
                  hint={t("library.skills.editor.settings.entryHint")}
                  htmlFor="skill-entry-path"
                >
                  <UI.Combobox
                    label={t("library.skills.editor.settings.entry")}
                    labelHidden
                    value={current.entryPath}
                    options={files.map((file) => ({
                      value: file.path,
                      label: file.path,
                    }))}
                    onChange={(event) =>
                      void saveSettings({
                        entryPath: event.currentTarget.value,
                      })}
                  />
                </UI.Field>
                <UI.Field
                  label={t("library.skills.editor.settings.licence")}
                  hint={t("library.skills.editor.settings.licenceHint")}
                  htmlFor="skill-licence"
                >
                  <UI.TextInput
                    id="skill-licence"
                    name="skill-licence"
                    type="text"
                    autoComplete="off"
                    value={current.license ?? ""}
                    onChange={(value) => void saveSettings({ license: value })}
                  />
                </UI.Field>
              </UI.Stack>
            )
            : null}
          {phone && path !== null
            ? (
              <UI.Button variant="quiet" onClick={() => setPath(null)}>
                {t("library.skills.editor.backToFiles")}
              </UI.Button>
            )
            : null}
          {chosenFile === null
            ? (
              <UI.Text variant="muted">
                {t("library.skills.editor.chooseFile")}
              </UI.Text>
            )
            : !textFile
            ? (
              <UI.InlineNotice tone="information">
                {t("library.skills.editor.file.binary")}
              </UI.InlineNotice>
            )
            : (
              <UI.Stack gap="compact">
                <UI.Field
                  label={t("library.skills.editor.file.content")}
                  htmlFor="skill-file-content"
                >
                  <textarea
                    id="skill-file-content"
                    ref={editorRef}
                    value={text}
                    rows={18}
                    onChange={(event) => {
                      setText(event.currentTarget.value);
                      setTouched(true);
                    }}
                  />
                </UI.Field>
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="primary"
                    disabled={!touched}
                    onClick={() => void saveFile()}
                  >
                    {t("library.skills.editor.file.save")}
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            )}
        </UI.Inline>
      </UI.Stack>
      {discardOpen
        ? (
          <UI.AlertDialog
            open
            variant="destructive"
            title={t("library.skills.editor.discard.title")}
            cancelAction={
              <UI.Button
                variant="secondary"
                onClick={() => setDiscardOpen(false)}
              >
                {t("core.actions.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="destructive"
                onClick={() => void discard()}
              >
                {t("library.skills.editor.discard")}
              </UI.Button>
            }
            onOpenChange={(open) => {
              if (!open) setDiscardOpen(false);
            }}
          >
            <UI.Text>{t("library.skills.editor.discard.body")}</UI.Text>
          </UI.AlertDialog>
        )
        : null}
      {publishOpen
        ? (
          <UI.AlertDialog
            open
            title={t("library.skills.editor.publish.title", {
              revision: String((current.baseRevision ?? 0) + 1),
            })}
            cancelAction={
              <UI.Button
                variant="secondary"
                onClick={() => setPublishOpen(false)}
              >
                {t("core.actions.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="primary"
                onClick={() => void publishNow()}
              >
                {t("library.skills.editor.publish")}
              </UI.Button>
            }
            onOpenChange={(open) => {
              if (!open) setPublishOpen(false);
            }}
          >
            <UI.Text>
              {t("library.skills.editor.publish.body", {
                revision: String((current.baseRevision ?? 0) + 1),
              })}
            </UI.Text>
          </UI.AlertDialog>
        )
        : null}
      {renaming === null ? null : (
        <RenameFileDialog
          file={renaming}
          draft={current}
          onClose={() => setRenaming(null)}
          onRenamed={(next) => {
            setRenaming(null);
            refreshDraft(next);
            setPath(renaming);
          }}
        />
      )}
      {removing === null ? null : (
        <UI.AlertDialog
          open
          variant="destructive"
          title={t("library.skills.editor.files.removeTitle", {
            file: removing,
          })}
          cancelAction={
            <UI.Button
              variant="secondary"
              onClick={() => setRemoving(null)}
            >
              {t("core.actions.cancel")}
            </UI.Button>
          }
          confirmAction={
            <UI.Button
              variant="destructive"
              onClick={() => {
                const file = files.find((item) => item.path === removing);
                setRemoving(null);
                if (file === undefined || organizationId === null) return;
                void api.deleteSkillDraftFile({
                  organizationId,
                  id: skillId,
                  fileId: file.id,
                  version: current.version,
                  idempotencyKey:
                    `skill-file-del-${current.id}-${current.version}-${file.id}`,
                }).then((result) => {
                  if (!result.ok) {
                    setRefusal(refusalOf(result.error));
                    return;
                  }
                  setPath(null);
                  void refreshDraft(result.data);
                });
              }}
            >
              {t("library.skills.editor.files.remove")}
            </UI.Button>
          }
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
        >
          <UI.Text>{t("library.skills.editor.files.removeBody")}</UI.Text>
        </UI.AlertDialog>
      )}
      {adding
        ? (
          <AddFileDialog
            draft={current}
            onClose={() => setAdding(false)}
            onAdded={(next, addedPath) => {
              setAdding(false);
              refreshDraft(next);
              setPath(addedPath);
            }}
          />
        )
        : null}
    </>
  );
}

function RenameFileDialog(
  { file, draft, onClose, onRenamed }: {
    file: string;
    draft: SkillDraftResponse;
    onClose: () => void;
    onRenamed: (next: SkillDraftResponse) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [name, setName] = useState(file);

  return (
    <UI.Dialog
      open
      variant="form"
      title={t("library.skills.editor.files.rename")}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (scope.organizationId === null) return;
          void api.renameSkillDraftFile({
            organizationId: scope.organizationId,
            id: draft.skillId,
            path: file,
            newPath: name,
            version: draft.version,
            idempotencyKey: `skill-file-rename-${draft.id}-${draft.version}`,
          }).then((result) => {
            if (result.ok) void onRenamed(result.data);
          });
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={t("library.skills.editor.file.name")}
            htmlFor="rename-skill-file"
          >
            <UI.TextInput
              id="rename-skill-file"
              name="rename-skill-file"
              type="text"
              autoComplete="off"
              value={name}
              onChange={setName}
            />
          </UI.Field>
          <UI.Inline gap="compact">
            <UI.Button variant="secondary" onClick={onClose}>
              {t("core.actions.cancel")}
            </UI.Button>
            <UI.Button type="submit" variant="primary">
              {t("library.skills.editor.files.rename")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}

function AddFileDialog(
  { draft, onClose, onAdded }: {
    draft: SkillDraftResponse;
    onClose: () => void;
    onAdded: (next: SkillDraftResponse, path: string) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate: t } = useI18n();
  const [filePath, setFilePath] = useState("");
  const [content, setContent] = useState("");

  return (
    <UI.Dialog
      open
      variant="form"
      title={t("library.skills.editor.file.addTitle")}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (scope.organizationId === null || filePath.trim() === "") return;
          const bytes = new TextEncoder().encode(content).length;
          if (bytes > SKILL_DRAFT_LIMIT_BYTES) return;
          void api.saveSkillDraftFile({
            organizationId: scope.organizationId,
            id: draft.skillId,
            path: filePath.trim(),
            mediaType: "text/markdown",
            contentBase64: encodeSkillText(content),
            version: draft.version,
            idempotencyKey: `skill-file-add-${draft.id}-${filePath.trim()}`,
          }).then((result) => {
            if (result.ok) void onAdded(result.data, filePath.trim());
          });
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={t("library.skills.editor.file.path")}
            htmlFor="add-skill-file-path"
          >
            <UI.TextInput
              id="add-skill-file-path"
              name="add-skill-file-path"
              type="text"
              autoComplete="off"
              value={filePath}
              onChange={setFilePath}
            />
          </UI.Field>
          <UI.Field
            label={t("library.skills.editor.file.content")}
            htmlFor="add-skill-file-content"
          >
            <textarea
              id="add-skill-file-content"
              value={content}
              rows={10}
              onChange={(event) => setContent(event.currentTarget.value)}
            />
          </UI.Field>
          <UI.Inline gap="compact">
            <UI.Button variant="secondary" onClick={onClose}>
              {t("core.actions.cancel")}
            </UI.Button>
            <UI.Button
              type="submit"
              variant="primary"
              disabled={filePath.trim() === ""}
            >
              {t("library.skills.editor.files.add")}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
