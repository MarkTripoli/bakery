import { useEffect, useMemo, useReducer, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RouterLink } from "../../app/router-link.tsx";
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
import { versionSource } from "./copy-workflow.ts";
import { stepSummary } from "./step-summary.tsx";
import { ACTION_LINES, ACTION_TITLES, stepsOf } from "./workflow-state.ts";
import {
  canRedo,
  canUndo,
  editorReducer,
  editorStateOf,
  freeStepId,
  isDirty,
} from "./editor-state.ts";

/**
 * The workflow editor (#67, slice 1), the page "Edit" on a workflow opens.
 * Two views of the version being edited: its steps as a list, and its code as
 * the server returns it. Editing the steps, validation and publishing arrive in
 * the commits that follow; this first slice is the page, its address and the
 * read that both views need, so the route is never a dead end.
 */
export function WorkflowEditorPage(
  { workflowId }: { readonly workflowId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate } = useI18n();
  const [tab, setTab] = useState<"steps" | "code">("steps");

  const workflow = useQuery(workflowQueryOptions(api, scope, workflowId));
  const versions = useQuery(
    workflowVersionsQueryOptions(api, scope, workflowId),
  );
  const access = useQuery(effectiveAccessQueryOptions(api, scope));

  // The version in use is the one an edit starts from; a workflow with no
  // version in use yet is edited from its newest version.
  const current = useMemo(() => {
    const items = versions.data?.items ?? [];
    return items.find((item) => item.id === workflow.data?.activeVersionId) ??
      items[0] ?? null;
  }, [versions.data, workflow.data]);

  const versionSteps = useMemo(
    () => current === null ? [] : stepsOf(current),
    [current],
  );
  const [editor, dispatch] = useReducer(
    editorReducer,
    versionSteps,
    editorStateOf,
  );
  // The version being edited changed (another workflow, or the read arrived):
  // the editor starts from that version's steps again.
  useEffect(() => {
    dispatch({ kind: "reset", steps: versionSteps });
  }, [current?.id, versionSteps]);
  const steps = editor.steps;
  // A step is named by what it does; an action without a sentence shows its key.
  const stepTitle = (uses: string) => {
    const key = ACTION_TITLES[uses];
    return key === undefined ? uses : translate(key as never);
  };
  const stepLine = (uses: string) => {
    const key = ACTION_LINES[uses];
    return key === undefined ? undefined : translate(key as never);
  };
  const failure = workflow.error ?? versions.error;
  const status = failureStatus(failure);
  const forbidden = status === 403;
  const missing = workflow.data === undefined && status === 404;
  const offline = asyncKindForError(failure) === "offline";
  const loading = !forbidden && !missing &&
    (workflow.isPending || versions.isPending);
  const canManage = access.data?.role === "admin";

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
    : current === null
    ? (
      <UI.EmptyState
        inset="page"
        icon={<UI.IconGlyph name="book" size="large" />}
        title={translate("library.editor.empty.title" as never)}
        description={translate("library.editor.empty.description" as never)}
      />
    )
    : (
      <UI.Stack gap="standard">
        <UI.Tabs
          aria-label={translate("library.editor.tabs.label" as never)}
          variant="view"
          selectedId={tab}
          onSelect={(id) => setTab(id === "code" ? "code" : "steps")}
          tabs={[
            {
              id: "steps",
              label: translate("library.editor.tab.steps" as never),
              content: null,
            },
            {
              id: "code",
              label: translate("library.editor.tab.code" as never),
              content: null,
            },
          ]}
        />
        {tab === "steps"
          ? (
            <>
              <UI.Inline gap="compact">
                <UI.Button
                  variant="text"
                  disabled={!canUndo(editor)}
                  onClick={() => dispatch({ kind: "undo" })}
                >
                  {translate("library.editor.undo" as never)}
                </UI.Button>
                <UI.Button
                  variant="text"
                  disabled={!canRedo(editor)}
                  onClick={() => dispatch({ kind: "redo" })}
                >
                  {translate("library.editor.redo" as never)}
                </UI.Button>
                <UI.Button
                  variant="secondary"
                  onClick={() =>
                    dispatch({
                      kind: "add",
                      step: {
                        id: freeStepId(editor, "step"),
                        uses: "task.brief",
                        agentVersionId: null,
                      },
                    })}
                >
                  {translate("library.editor.addStep" as never)}
                </UI.Button>
              </UI.Inline>
              {steps.length === 0
                ? (
                  <UI.Text variant="muted">
                    {translate("library.workflow.steps.none" as never)}
                  </UI.Text>
                )
                : (
                  <UI.StepList
                    label={translate("library.editor.steps.label" as never)}
                  >
                    {steps.map((step, index) => (
                      /* The row owns the keyboard: Alt+Arrow moves the step it
                         is pressed on, which is how a keyboard reorders a row
                         in the design (#67). The buttons do the same move for
                         anyone using a pointer. */
                      <div
                        key={step.id}
                        role="group"
                        data-step-row={step.id}
                        onKeyDown={(event) => {
                          if (!event.altKey || !canManage) return;
                          if (event.key === "ArrowUp" && index > 0) {
                            event.preventDefault();
                            dispatch({
                              kind: "move",
                              id: step.id,
                              index: index - 1,
                            });
                          } else if (
                            event.key === "ArrowDown" &&
                            index < steps.length - 1
                          ) {
                            event.preventDefault();
                            dispatch({
                              kind: "move",
                              id: step.id,
                              index: index + 1,
                            });
                          }
                        }}
                      >
                        <UI.StepItem
                          data-step-id={step.id}
                          number={index + 1}
                          status="upcoming"
                          statusLabel={translate(
                            "library.workflow.steps.number" as never,
                            { n: index + 1 },
                          )}
                          title={stepTitle(step.uses)}
                          summary={stepSummary(stepLine(step.uses), undefined)}
                          action={canManage
                            ? (
                              <UI.Inline gap="compact">
                                <UI.IconButton
                                  label={translate(
                                    "library.editor.moveUp" as never,
                                    { name: stepTitle(step.uses) },
                                  )}
                                  variant="compact"
                                  disabled={index === 0}
                                  onClick={() =>
                                    dispatch({
                                      kind: "move",
                                      id: step.id,
                                      index: index - 1,
                                    })}
                                >
                                  <UI.IconGlyph
                                    name="chevron-up"
                                    size="small"
                                  />
                                </UI.IconButton>
                                <UI.IconButton
                                  label={translate(
                                    "library.editor.moveDown" as never,
                                    { name: stepTitle(step.uses) },
                                  )}
                                  variant="compact"
                                  disabled={index === steps.length - 1}
                                  onClick={() =>
                                    dispatch({
                                      kind: "move",
                                      id: step.id,
                                      index: index + 1,
                                    })}
                                >
                                  <UI.IconGlyph
                                    name="chevron-down"
                                    size="small"
                                  />
                                </UI.IconButton>
                                <UI.IconButton
                                  label={translate(
                                    "library.editor.removeStep" as never,
                                    { name: stepTitle(step.uses) },
                                  )}
                                  variant="destructive"
                                  onClick={() =>
                                    dispatch({ kind: "remove", id: step.id })}
                                >
                                  <UI.IconGlyph name="close" size="small" />
                                </UI.IconButton>
                              </UI.Inline>
                            )
                            : undefined}
                        />
                      </div>
                    ))}
                  </UI.StepList>
                )}
            </>
          )
          : (
            <UI.Stack gap="compact" data-testid="editor-code">
              <UI.Text variant="muted">
                {translate("library.editor.code.description" as never)}
              </UI.Text>
              <UI.CodeBlock
                aria-label={translate("library.editor.code.label" as never)}
                code={versionSource(
                  workflow.data ?? { name: "", description: "" },
                  current,
                ).sourceYaml ?? ""}
                language="yaml"
                variant="syntax"
              />
            </UI.Stack>
          )}
      </UI.Stack>
    );

  return (
    <>
      <UI.PageHeader
        variant="split"
        title={workflow.data?.name ??
          translate("library.editor.title" as never)}
        subtitle={current === null ? undefined : translate(
          "library.editor.version" as never,
          { version: current.revision },
        )}
        summary={canManage
          ? (isDirty(editor)
            ? (
              <UI.Badge tone="warning">
                {translate("library.editor.dirty" as never)}
              </UI.Badge>
            )
            : undefined)
          : (
            <UI.Badge tone="neutral">
              {translate("library.editor.readOnly" as never)}
            </UI.Badge>
          )}
      />
      {back}
      {body}
    </>
  );
}
