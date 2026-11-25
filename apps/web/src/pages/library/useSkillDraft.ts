import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SkillDraftFileResponse,
  SkillDraftResponse,
  SkillResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  skillDraftFileQueryOptions,
  skillDraftQueryOptions,
} from "../../api/query.ts";
import { useUnsavedChanges } from "../../app/unsaved-changes.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import {
  base64ToText,
  type DraftFailure,
  draftFailure,
  type DraftFile,
  groupFiles,
  isScript,
  isTextMedia,
  mediaTypeOf,
  textToBase64,
  type TypedCheck,
  typedCheck,
  type TypedDraft,
  typedDraft,
} from "./skill-draft-state.ts";

const SAVE_REST_MS = 800;

export type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly at: number }
  | { readonly kind: "failed"; readonly failure: DraftFailure }
  | { readonly kind: "conflict"; readonly fileId: string };

export type Checked = {
  readonly result: TypedCheck;
};
export function useSkillDraft(
  skill: SkillResponse,
  autoSelect: boolean,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const organizationId = scope.organizationId as string;
  const options = skillDraftQueryOptions(api, scope, skill.id);
  const read = useQuery(options);
  const draft: TypedDraft | undefined = read.data === undefined
    ? undefined
    : typedDraft(read.data);
  const latest = useRef<TypedDraft | undefined>(draft);
  latest.current = draft;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Readonly<Record<string, string>>>({});
  const [reloads, setReloads] = useState<Readonly<Record<string, number>>>({});
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [checked, setChecked] = useState<Checked | null>(null);
  const [writeFailure, setWriteFailure] = useState<DraftFailure | null>(null);
  const buffered = useRef<Record<string, string>>({});
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflicted = useRef<string | null>(null);

  const firstFile = draft === undefined || !autoSelect
    ? null
    : groupFiles(draft).entry ?? draft.files[0] ?? null;
  const chosenId = selectedId ?? firstFile?.id ?? null;
  const selected: DraftFile | null =
    draft?.files.find((file) => file.id === chosenId) ?? null;
  const text = selected !== null && isTextMedia(selected.mediaType);
  const contentRead = useQuery({
    ...skillDraftFileQueryOptions(
      api,
      scope,
      skill.id,
      selected !== null && text ? selected.id : "",
    ),
  });

  const putDraft = useCallback((next: SkillDraftResponse) => {
    latest.current = typedDraft(next);
    queryClient.setQueryData(options.queryKey, next);
  }, [queryClient, options.queryKey]);

  const enqueue = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task, task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    await enqueue(async () => {
      for (;;) {
        const pending = Object.entries(buffered.current)[0];
        if (pending === undefined || conflicted.current !== null) return;
        const [fileId, value] = pending;
        const current = latest.current;
        const file = current?.files.find((item) => item.id === fileId);
        if (current === undefined || file === undefined) {
          delete buffered.current[fileId];
          continue;
        }
        setSave({ kind: "saving" });
        const result = await api.saveSkillDraftFile({
          organizationId,
          id: skill.id,
          input: {
            path: file.path,
            mediaType: file.mediaType,
            isExecutable: file.isExecutable,
            contentBase64: textToBase64(value),
          },
          version: current.version,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!result.ok) {
          const failure = draftFailure(result.error);
          if (failure === "conflict") {
            conflicted.current = fileId;
            setSave({ kind: "conflict", fileId });
          } else setSave({ kind: "failed", failure });
          return;
        }
        if (buffered.current[fileId] === value) delete buffered.current[fileId];
        putDraft(result.data);
        queryClient.setQueryData(
          skillDraftFileQueryOptions(api, scope, skill.id, fileId).queryKey,
          (old: SkillDraftFileResponse | undefined) =>
            old === undefined
              ? old
              : { ...old, contentBase64: textToBase64(value) },
        );
        setBuffers((all) => {
          const { [fileId]: _gone, ...rest } = all;
          return buffered.current[fileId] === undefined ? rest : all;
        });
        setSave({ kind: "saved", at: Date.now() });
      }
    });
  }, [api, enqueue, organizationId, putDraft, queryClient, scope, skill.id]);

  const edit = useCallback((fileId: string, value: string) => {
    buffered.current[fileId] = value;
    setBuffers((all) => ({ ...all, [fileId]: value }));
    if (conflicted.current !== null) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_REST_MS);
  }, [flush]);

  const dirty = Object.keys(buffers).length > 0;
  useUnsavedChanges(dirty);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const apply = useCallback(async (
    change: (current: TypedDraft) => Promise<
      { ok: true; data: SkillDraftResponse } | { ok: false; error: unknown }
    >,
  ): Promise<TypedDraft | null> => {
    await flush();
    return await enqueue(async () => {
      const current = latest.current;
      if (current === undefined) return null;
      setWriteFailure(null);
      const result = await change(current);
      if (!result.ok) {
        setWriteFailure(draftFailure(result.error));
        return null;
      }
      putDraft(result.data);
      setChecked(null);
      return typedDraft(result.data);
    });
  }, [enqueue, flush, putDraft]);

  const addFile = async (
    path: string,
    runnable = false,
    body = "",
  ): Promise<DraftFile | null> => {
    const next = await apply((current) =>
      api.saveSkillDraftFile({
        organizationId,
        id: skill.id,
        input: {
          path,
          mediaType: mediaTypeOf(path),
          isExecutable: isScript(path) ? runnable : undefined,
          contentBase64: textToBase64(body),
        },
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      })
    );
    const added = next?.files.find((file) => file.path === path) ?? null;
    if (added !== null) setSelectedId(added.id);
    return added;
  };

  const setRunnable = async (file: DraftFile, value: boolean) => {
    const content = await api.getSkillDraftFile({
      organizationId,
      id: skill.id,
      fileId: file.id,
    });
    if (!content.ok) {
      setWriteFailure(draftFailure(content.error));
      return;
    }
    await apply((current) =>
      api.saveSkillDraftFile({
        organizationId,
        id: skill.id,
        input: {
          path: file.path,
          mediaType: file.mediaType,
          isExecutable: value,
          contentBase64: content.data.contentBase64,
        },
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      })
    );
  };

  const renameFile = async (file: DraftFile, newPath: string) => {
    const next = await apply((current) =>
      api.renameSkillDraftFile({
        organizationId,
        id: skill.id,
        path: file.path,
        newPath,
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      })
    );
    return next !== null;
  };

  const removeFile = async (file: DraftFile) => {
    const content = await api.getSkillDraftFile({
      organizationId,
      id: skill.id,
      fileId: file.id,
    });
    if (!content.ok) {
      setWriteFailure(draftFailure(content.error));
      return null;
    }
    delete buffered.current[file.id];
    const next = await apply((current) =>
      api.deleteSkillDraftFile({
        organizationId,
        id: skill.id,
        fileId: file.id,
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      })
    );
    if (next === null) return null;
    if (selectedId === file.id) setSelectedId(null);
    return content.data;
  };

  const restoreFile = async (file: {
    path: string;
    mediaType: string;
    isExecutable: boolean;
    contentBase64: string;
  }) => {
    const next = await apply((current) =>
      api.saveSkillDraftFile({
        organizationId,
        id: skill.id,
        input: {
          path: file.path,
          mediaType: file.mediaType,
          isExecutable: file.isExecutable,
          contentBase64: file.contentBase64,
        },
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      })
    );
    const back = next?.files.find((item) => item.path === file.path) ?? null;
    if (back !== null) setSelectedId(back.id);
  };

  const changeSettings = async (
    input: { license?: string; entryPath?: string },
  ) => {
    const next = await apply((current) =>
      api.updateSkillDraft({
        organizationId,
        id: skill.id,
        input,
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      })
    );
    return next !== null;
  };

  const check = async (): Promise<TypedCheck | null> => {
    await flush();
    return await enqueue(async () => {
      setWriteFailure(null);
      const result = await api.checkSkillDraft({
        organizationId,
        id: skill.id,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) {
        setWriteFailure(draftFailure(result.error));
        return null;
      }
      const typed = typedCheck(result.data);
      setChecked({ result: typed });
      return typed;
    });
  };

  const publish = async () => {
    await flush();
    return await enqueue(async () => {
      const current = latest.current;
      if (current === undefined) return null;
      setWriteFailure(null);
      const result = await api.publishSkillDraft({
        organizationId,
        id: skill.id,
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) {
        setWriteFailure(draftFailure(result.error));
        return null;
      }
      return result.data;
    });
  };

  const discard = async () => {
    await enqueue(() => Promise.resolve());
    const current = latest.current;
    if (current === undefined) return false;
    setWriteFailure(null);
    const result = await api.discardSkillDraft({
      organizationId,
      id: skill.id,
      version: current.version,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setWriteFailure(draftFailure(result.error));
      return false;
    }
    buffered.current = {};
    setBuffers({});
    return true;
  };

  const loadLatest = async () => {
    const fileId = conflicted.current;
    conflicted.current = null;
    if (fileId !== null) {
      delete buffered.current[fileId];
      setBuffers((all) => {
        const { [fileId]: _gone, ...rest } = all;
        return rest;
      });
      setReloads((all) => ({ ...all, [fileId]: (all[fileId] ?? 0) + 1 }));
      await queryClient.invalidateQueries({
        queryKey: skillDraftFileQueryOptions(api, scope, skill.id, fileId)
          .queryKey,
      });
    }
    await read.refetch();
    setSave({ kind: "idle" });
  };

  const retrySave = () => {
    setSave({ kind: "idle" });
    void flush();
  };

  const bodyOf = (): string | null => {
    if (selected === null || !text) return null;
    const unsaved = buffers[selected.id];
    if (unsaved !== undefined) return unsaved;
    return contentRead.data === undefined
      ? null
      : base64ToText(contentRead.data.contentBase64);
  };

  return {
    read,
    draft,
    selected,
    selectedId: chosenId,
    select: setSelectedId,
    text,
    body: bodyOf(),
    bodyLoading: text && contentRead.isPending,
    bodyFailed: text && contentRead.isError,
    retryBody: () => void contentRead.refetch(),
    reloads,
    edit,
    dirty,
    save,
    checked,
    writeFailure,
    clearWriteFailure: () => setWriteFailure(null),
    addFile,
    setRunnable,
    renameFile,
    removeFile,
    restoreFile,
    changeSettings,
    check,
    publish,
    discard,
    loadLatest,
    retrySave,
    flush,
  };
}
