import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import {
  effectiveAccessQueryOptions,
  workflowQueryOptions,
  workflowVersionsQueryOptions,
} from "../../api/query.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";

import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { RouterLink } from "../../app/router-link.tsx";
import { ShellSlot } from "../../shell/shell-slots.tsx";
import { StepPanel } from "./StepPanel.tsx";
import { WorkflowDiagram } from "./WorkflowDiagram.tsx";
import { versionSource } from "./copy-workflow.ts";
import {
  editorReducer,
  editorStateOf,
  type EditorStep,
  freeStepId,
} from "./editor-state.ts";
import { problemsOf } from "./editor-validation.ts";
import { treeOf } from "./workflow-tree.ts";

/**
 * The workflow editor (#67, slice 1 of the owner's spec): the workflow drawn
 * top to bottom, a "+" on every connector to add a step, the selected step in
 * the panel, and the draft saved to the server as it changes — the header says
 * which of those it is doing. Publishing, the code view behind More, and the
 * problems' sentences arrive in the commits after this one.
 */

/** How long the editor waits after a change before it saves the draft. */
const SAVE_AFTER_MS = 600;

/**
 * The save state a spec or a still can ask the page to show, in the same spirit
 * as the prototype's State menu (#67): `?state=save-failed` or `?state=saving`.
 * Development builds only, so a person never sees it in production.
 */
function forcedSaveState(): SaveState | null {
  if (!import.meta.env.DEV) return null;
  const asked = new URLSearchParams(globalThis.location?.search ?? "").get(
    "state",
  );
  if (asked === "save-failed") return { kind: "failed" };
  if (asked === "saving") return { kind: "saving" };
  return null;
}

type SaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed" };

export function WorkflowEditorPage(
  { workflowId }: { readonly workflowId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const canManage = access.data?.role === "admin";
  const queryClient = useQueryClient();
  const { translate } = useI18n();

  const workflow = useQuery(workflowQueryOptions(api, scope, workflowId));
  const versions = useQuery(
    workflowVersionsQueryOptions(api, scope, workflowId),
  );

  // The version being edited is the workflow's draft when there is one, else
  // the version in use, else the newest version.
  const draft = useMemo(() => {
    const items = versions.data?.items ?? [];
    return items.find((item) => item.status === "draft") ??
      items.find((item) => item.id === workflow.data?.activeVersionId) ??
      items[0] ??
      null;
  }, [versions.data, workflow.data]);

  const inUse = useMemo(() => {
    const items = versions.data?.items ?? [];
    return items.find((item) => item.id === workflow.data?.activeVersionId) ??
      null;
  }, [versions.data, workflow.data]);

  const versionSteps = useMemo<readonly EditorStep[]>(() => {
    const spec = (draft?.normalizedSpec ?? {}) as { steps?: unknown };
    const steps = Array.isArray(spec.steps) ? spec.steps : [];
    return steps.flatMap((raw) => {
      const step = raw as {
        id?: unknown;
        uses?: unknown;
        agentVersionId?: unknown;
      };
      const id = typeof step.id === "string" ? step.id : "";
      const uses = typeof step.uses === "string" ? step.uses : "";
      if (id === "") return [];
      return [{
        id,
        uses,
        agentVersionId: typeof step.agentVersionId === "string"
          ? step.agentVersionId
          : null,
      }];
    });
  }, [draft]);

  const [editor, dispatch] = useReducer(
    editorReducer,
    versionSteps,
    editorStateOf,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerAfter, setPickerAfter] = useState<string | null | undefined>(
    undefined,
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: "saved" });
  const [codeOpen, setCodeOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const lastSaved = useRef<string>("");

  // A different version being edited starts the editor again.
  useEffect(() => {
    dispatch({ kind: "reset", steps: versionSteps });
    lastSaved.current = JSON.stringify(versionSteps);
    setSaveState({ kind: "saved" });
  }, [draft?.id, versionSteps]);

  const failure = workflow.error ?? versions.error;
  const status = failureStatus(failure);
  const forbidden = status === 403;
  const missing = workflow.data === undefined && status === 404;
  const offline = asyncKindForError(failure) === "offline";
  const loading = !forbidden && !missing && !offline &&
    (workflow.isPending || versions.isPending);

  // Saving the draft: one write per quiet moment, keyed so a failure is
  // reported under the operation it happened in.
  const save = useMutation({
    mutationKey: ["workflowVersions.update"],
    mutationFn: async (steps: readonly EditorStep[]) => {
      if (draft === null) throw new Error("no draft version");
      const result = await api.updateWorkflowVersion({
        organizationId: scope.organizationId as string,
        workflowId,
        versionId: draft.id,
        version: draft.version,
        input: {
          definition: {
            steps: steps.map((step) => ({
              id: step.id,
              uses: step.uses,
              ...(step.agentVersionId === null
                ? {}
                : { agentVersionId: step.agentVersionId }),
            })),
          } as never,
        },
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onMutate: () => setSaveState({ kind: "saving" }),
    onSuccess: () => {
      lastSaved.current = JSON.stringify(editor.steps);
      setSaveState({ kind: "saved" });
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
    onError: () => setSaveState({ kind: "failed" }),
  });

  // Publishing the draft, and optionally making it the version in use: two
  // forms of one action, decided by the button the person presses.
  const publish = useMutation({
    mutationKey: ["workflowVersions.publish"],
    mutationFn: async (alsoUse: boolean) => {
      if (draft === null) throw new Error("no draft version");
      const published = await api.publishWorkflowVersion({
        organizationId: scope.organizationId as string,
        workflowId,
        versionId: draft.id,
        expectedDigest: draft.digest,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!published.ok) throw published.error;
      if (!alsoUse) return published.data;
      const used = await api.activateWorkflowVersion({
        organizationId: scope.organizationId as string,
        id: workflowId,
        versionId: published.data.id,
        version: workflow.data?.version ?? 0,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!used.ok) throw used.error;
      return published.data;
    },
    onSuccess: () => {
      setPublishOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
    },
  });

  const steps = editor.steps;
  const inUseSteps = useMemo<readonly EditorStep[]>(() => {
    const spec = (inUse?.normalizedSpec ?? {}) as { steps?: unknown };
    const held = Array.isArray(spec.steps) ? spec.steps : [];
    return held.flatMap((raw) => {
      const step = raw as { id?: unknown; uses?: unknown };
      const id = typeof step.id === "string" ? step.id : "";
      return id === "" ? [] : [{
        id,
        uses: typeof step.uses === "string" ? step.uses : "",
        agentVersionId: null,
      }];
    });
  }, [inUse]);
  const draftDiffers = draft !== null &&
    JSON.stringify(steps) !== JSON.stringify(inUseSteps);
  // Checking is continuous: the draft is checked against the server as it
  // changes, and each problem lands on the step its pointer names.
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const check = useMutation({
    mutationKey: ["workflows.validate"],
    mutationFn: async (held: readonly EditorStep[]) => {
      const result = await api.validateWorkflow({
        organizationId: scope.organizationId as string,
        input: {
          definition: {
            steps: held.map((step) => ({
              id: step.id,
              uses: step.uses,
              ...(step.agentVersionId === null
                ? {}
                : { agentVersionId: step.agentVersionId }),
            })),
          } as never,
        },
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: (report, held) => {
      const sorted = problemsOf([
        ...(report.errors ?? []),
        ...(report.warnings ?? []),
      ]);
      const byId = new Map<string, string>();
      for (const [index, found] of sorted.byStep) {
        const step = held[index];
        if (step === undefined) continue;
        byId.set(step.id, found[0]?.message ?? "");
      }
      setProblems(byId);
    },
  });

  useEffect(() => {
    if (steps.length === 0) {
      setProblems(new Map());
      return;
    }
    const timer = setTimeout(() => check.mutate(steps), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [steps]);
  const changed = JSON.stringify(steps) !== lastSaved.current;

  // A change saves itself once the person stops typing; a failed save waits for
  // "Try again" rather than looping.
  useEffect(() => {
    if (!canManage || draft === null || saveState.kind === "failed") return;
    if (!changed) return;
    const timer = setTimeout(() => save.mutate(steps), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [changed, steps, canManage, draft, saveState.kind]);

  // Leaving while the latest change is not saved asks first.
  useEffect(() => {
    if (saveState.kind === "saved" && !changed) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", warn);
    return () => globalThis.removeEventListener("beforeunload", warn);
  }, [saveState.kind, changed]);

  const tree = useMemo(() => treeOf({ steps }), [steps]);

  const shownSave: SaveState = forcedSaveState() ?? saveState;
  const stateWord = shownSave.kind === "saving"
    ? translate("library.editor.save.saving" as never)
    : shownSave.kind === "failed"
    ? translate("library.editor.save.failed" as never)
    : translate("library.editor.save.saved" as never);

  const selected = selectedId === null
    ? null
    : steps.find((step) => step.id === selectedId) ?? null;
  const selectedIndex = selected === null
    ? -1
    : steps.findIndex((step) => step.id === selected.id);

  const back = (
    <RouterLink
      to="/library/workflows/$workflowId"
      params={{ workflowId }}
      variant="back"
    >
      {translate("library.editor.back" as never)}
    </RouterLink>
  );

  const body = forbidden
    ? (
      <UI.ErrorState
        title={translate("library.workflow.notFound.title" as never)}
        description={translate("library.workflow.adminOnly" as never)}
      />
    )
    : missing
    ? (
      <UI.ErrorState
        title={translate("library.workflow.notFound.title" as never)}
        description={translate(
          "library.workflow.notFound.description" as never,
        )}
        action={back}
      />
    )
    : offline
    ? (
      <UI.ErrorState
        title={translate("library.editor.offline.title" as never)}
        description={translate("library.editor.offline.description" as never)}
      />
    )
    : loading
    ? (
      <UI.Text role="status">
        {translate("library.workflow.loading" as never)}
      </UI.Text>
    )
    : draft === null
    ? (
      <UI.EmptyState
        inset="page"
        icon={<UI.IconGlyph name="book" size="large" />}
        title={translate("library.editor.empty.title" as never)}
        description={translate("library.editor.empty.description" as never)}
      />
    )
    : (
      <UI.Inline gap="standard" data-ui-region="editor-work-surface">
        <UI.Stack gap="standard">
          <WorkflowDiagram
            tree={tree}
            selectedId={selectedId}
            problems={problems}
            canManage={canManage}
            onAdd={(afterId) => setPickerAfter(afterId)}
            onSelect={setSelectedId}
            pickerAt={pickerAfter}
            onPick={(uses) => {
              const afterId = pickerAfter ?? null;
              const id = freeStepId(editor, uses.replaceAll(".", "-"));
              const step = { id, uses, agentVersionId: null };
              dispatch({ kind: "add", step });
              // Put the new step where the "+" was pressed.
              if (afterId !== null) {
                const at = steps.findIndex((one) => one.id === afterId);
                dispatch({ kind: "move", id, index: at + 1 });
              }
              setPickerAfter(undefined);
              setSelectedId(id);
            }}
            onPickClose={() => setPickerAfter(undefined)}
          />
        </UI.Stack>
        {selected === null ? null : (
          <StepPanel
            uses={selected.uses}
            code={undefined}
            problem={undefined}
            canMoveUp={selectedIndex > 0}
            canMoveDown={selectedIndex >= 0 &&
              selectedIndex < steps.length - 1}
            disabled={!canManage}
            onMoveUp={() =>
              dispatch({
                kind: "move",
                id: selected.id,
                index: selectedIndex - 1,
              })}
            onMoveDown={() =>
              dispatch({
                kind: "move",
                id: selected.id,
                index: selectedIndex + 1,
              })}
            onRemove={() => {
              dispatch({ kind: "remove", id: selected.id });
              setSelectedId(null);
            }}
          />
        )}
      </UI.Inline>
    );

  return (
    <>
      {canManage && draft !== null
        ? (
          <ShellSlot name="actions">
            <UI.Inline gap="compact">
              {shownSave.kind === "failed"
                ? (
                  <UI.Button
                    variant="secondary"
                    onClick={() => save.mutate(steps)}
                  >
                    {translate("library.editor.save.tryAgain" as never)}
                  </UI.Button>
                )
                : null}
              <UI.Text variant="muted" role="status">
                {stateWord}
              </UI.Text>
              <UI.Button
                variant="secondary"
                onClick={() => setCodeOpen(true)}
              >
                {translate("library.editor.viewAsCode" as never)}
              </UI.Button>
              <UI.Button
                variant="primary"
                onClick={() => setPublishOpen(true)}
              >
                {translate("library.editor.publish" as never)}
              </UI.Button>
            </UI.Inline>
          </ShellSlot>
        )
        : null}
      <UI.PageHeader
        variant="split"
        title={workflow.data?.name ??
          translate("library.editor.title" as never)}
        subtitle={inUse === null
          ? translate("library.editor.version.draft" as never)
          : translate("library.editor.version.inUse" as never, {
            version: inUse.revision,
          })}
      />
      {back}
      {body}
      {publishOpen && draft !== null
        ? (
          <UI.AlertDialog
            open
            variant="destructive"
            title={draftDiffers
              ? translate("library.editor.publish.title" as never, {
                version: String((inUse?.revision ?? 0) + 1),
              })
              : translate("library.editor.publish.nothing" as never)}
            state={publish.isPending ? "confirming" : "open"}
            onOpenChange={(open) => {
              if (!open) setPublishOpen(false);
            }}
            cancelAction={
              <UI.Button
                variant="outline"
                disabled={publish.isPending}
                onClick={() => setPublishOpen(false)}
              >
                {draftDiffers
                  ? translate("library.editor.publish.cancel" as never)
                  : translate("library.editor.publish.close" as never)}
              </UI.Button>
            }
            confirmAction={draftDiffers
              ? (
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="secondary"
                    disabled={publish.isPending}
                    loading={publish.isPending}
                    onClick={() => publish.mutate(false)}
                  >
                    {translate("library.editor.publish.only" as never)}
                  </UI.Button>
                  <UI.Button
                    variant="primary"
                    disabled={publish.isPending}
                    onClick={() => publish.mutate(true)}
                  >
                    {translate("library.editor.publish.andUse" as never)}
                  </UI.Button>
                </UI.Inline>
              )
              : undefined}
          >
            {draftDiffers
              ? (
                <UI.Stack gap="tight">
                  <UI.Text>
                    {translate("library.editor.publish.body" as never)}
                  </UI.Text>
                  <UI.Text variant="muted">
                    {translate("library.workflow.steps.never" as never)}
                  </UI.Text>
                </UI.Stack>
              )
              : (
                <UI.Text>
                  {translate("library.editor.publish.nothingBody" as never)}
                </UI.Text>
              )}
          </UI.AlertDialog>
        )
        : null}
      {codeOpen && draft !== null
        ? (
          <UI.Dialog
            open
            title={translate("library.editor.code.label" as never)}
            onOpenChange={(open) => {
              if (!open) setCodeOpen(false);
            }}
          >
            <UI.CodeBlock
              aria-label={translate("library.editor.code.label" as never)}
              code={versionSource(
                workflow.data ?? { name: "", description: "" },
                draft,
              ).sourceYaml ?? ""}
              language="yaml"
              variant="syntax"
            />
          </UI.Dialog>
        )
        : null}
    </>
  );
}
