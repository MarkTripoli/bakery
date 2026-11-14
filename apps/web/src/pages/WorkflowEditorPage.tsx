import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  ValidationReportResponse,
  WorkflowVersionResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  workflowActionsQueryOptions,
  workflowQueryOptions,
  workflowVersionsQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { focusAfterPaint } from "../app/focus.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import {
  addStep,
  definitionText,
  type EditorDefinition,
  hasStepList,
  moveStep,
  readDefinitionText,
  removeStep,
  sameDefinition,
  setStepField,
  stepIndexOf,
  stepsOf,
} from "./library/editor-state.ts";
import { ACTION_TITLES, newestFirst } from "./library/workflow-state.ts";

/** How long the definition rests before it is checked. */
const SETTLE_MS = 800;

type Dialog =
  | { readonly kind: "add" }
  | { readonly kind: "publish" }
  | { readonly kind: "leave" }
  | { readonly kind: "discard" }
  | null;

/** What went wrong with a save or a publish, in the words the page has for it. */
type Failure = "conflict" | "offline" | "failed" | null;

function failureOf(error: unknown): Exclude<Failure, null> {
  if (asyncKindForError(error) === "offline") return "offline";
  const status = failureStatus(error);
  return status === 409 || status === 412 ? "conflict" : "failed";
}

/** What the check of the current definition found. */
type Check =
  | { readonly state: "checking" }
  | { readonly state: "unreadable" }
  | {
    readonly state: "done";
    readonly problems: readonly {
      readonly path: string;
      readonly message: string;
    }[];
  };

/**
 * The editor of one draft version (design-ux, #67, slice 1): the steps in
 * order with a panel for the selected one, the definition as code, the
 * server's findings on the steps they belong to, and Save and Publish. A
 * published version never changes; editing always works on a draft.
 */
export function WorkflowEditorPage(
  { workflowId }: { readonly workflowId: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const offline = useConnectivity() === "offline";
  const organizationId = scope.organizationId as string;
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const canManage = access.data?.role === "admin";
  const workflow = useQuery(workflowQueryOptions(api, scope, workflowId));
  const versions = useQuery(
    workflowVersionsQueryOptions(api, scope, workflowId),
  );
  const actions = useQuery(workflowActionsQueryOptions(api, scope));

  const all = newestFirst(versions.data?.items ?? []);
  const draft: WorkflowVersionResponse | null =
    all.find((version) => version.status === "draft") ?? null;
  const newestPublished =
    all.find((version) => version.status === "published") ?? null;

  // The definition being edited: the draft's, until the person changes it.
  const saved = (draft?.normalizedSpec ?? {}) as EditorDefinition;
  const [definition, setDefinition] = useState<EditorDefinition | null>(null);
  const [loadedDraft, setLoadedDraft] = useState<string | null>(null);
  if (draft !== null && loadedDraft !== draft.id) {
    setLoadedDraft(draft.id);
    setDefinition(saved);
  }
  const current = definition ?? saved;
  const dirty = draft !== null && !sameDefinition(current, saved);

  const [tab, setTab] = useState<"steps" | "code">("steps");
  const [selected, setSelected] = useState<number | null>(null);
  const [codeText, setCodeText] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [failure, setFailure] = useState<Failure>(null);
  const [published, setPublished] = useState<number | null>(null);
  const [newAction, setNewAction] = useState("");
  const [check, setCheck] = useState<Check>({ state: "checking" });
  const opener = useRef<HTMLElement | null>(null);
  const turn = useRef(0);

  const stepList = stepsOf(current);
  const known: string[] = (actions.data ?? []).map((action) => action.actionId);
  const title = (uses: string) => {
    const key = ACTION_TITLES[uses];
    return key === undefined ? uses : translate(key as never);
  };
  const options = [
    ...known.map((id) => ({ value: id, label: title(id) })),
  ];
  const optionsFor = (uses: string) =>
    uses === "" || known.includes(uses)
      ? options
      : [...options, { value: uses, label: uses }];

  const validate = useMutation({
    mutationKey: ["workflows.validate"],
    mutationFn: async (value: EditorDefinition) => {
      const result = await api.validateWorkflow({
        organizationId,
        input: { definition: value as never },
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data satisfies ValidationReportResponse;
    },
  });

  // Check the definition once it has rested; a newer one overrides an older check.
  useEffect(() => {
    if (draft === null || definition === null) return;
    const mine = ++turn.current;
    setCheck({ state: "checking" });
    const timer = setTimeout(async () => {
      try {
        const report = await validate.mutateAsync(definition);
        if (mine !== turn.current) return;
        const found = [
          ...report.errors,
          ...(report.compilerDiagnostics ?? []).filter((item) =>
            !report.errors.some((known) =>
              known.path === item.path && known.message === item.message
            )
          ),
        ];
        setCheck({ state: "done", problems: found });
      } catch {
        if (mine === turn.current) setCheck({ state: "unreadable" });
      }
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // `validate` is a stable mutation handle; the definition is the only input.
  }, [definition, loadedDraft]);

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  const save = useMutation({
    mutationKey: ["workflowVersions.update"],
    mutationFn: async (version: WorkflowVersionResponse) => {
      const result = await api.updateWorkflowDraft({
        organizationId,
        workflowId,
        versionId: version.id,
        input: { definition: current as never },
        version: version.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });
  const publish = useMutation({
    mutationKey: ["workflowVersions.publish"],
    mutationFn: async (version: WorkflowVersionResponse) => {
      // Publishing is of what was saved: save first when there are changes.
      const target = dirty ? await save.mutateAsync(version) : version;
      const result = await api.publishWorkflowVersion({
        organizationId,
        workflowId,
        versionId: target.id,
        version: target.version,
        expectedDigest: target.digest,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });
  const start = useMutation({
    mutationKey: ["workflowVersions.create"],
    mutationFn: async (from: WorkflowVersionResponse) => {
      const result = await api.createWorkflowVersion({
        organizationId,
        workflowId,
        input: {
          definition: from.normalizedSpec as never,
          ...(from.sourceYaml === "" ? {} : { sourceYaml: from.sourceYaml }),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });
  const pending = save.isPending || publish.isPending || start.isPending;

  const problems = check.state === "done" ? check.problems : [];
  const problemsOn = (index: number) =>
    problems.filter((problem) => stepIndexOf(problem.path) === index);
  const wholeProblems = problems.filter((problem) =>
    stepIndexOf(problem.path) === null
  );
  const blocked = problems.length > 0 || check.state !== "done" ||
    codeError !== null;

  const change = (next: EditorDefinition) => {
    setDefinition(next);
    setCodeText(null);
    setCodeError(null);
    setFailure(null);
  };
  const open = (next: Dialog) => {
    opener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setFailure(null);
    setDialog(next);
  };
  const close = () => {
    setDialog(null);
    focusAfterPaint(() => opener.current);
  };
  const run = async (action: () => Promise<unknown>, done: () => void) => {
    setFailure(null);
    try {
      await action();
      done();
    } catch (error) {
      setFailure(failureOf(error));
    }
  };

  // Leaving with unsaved changes is the browser's to confirm too.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener("beforeunload", warn);
    return () => globalThis.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const back = () =>
    void navigate({
      to: "/library/workflows/$workflowId",
      params: { workflowId },
    });
  const leave = () => dirty ? open({ kind: "leave" }) : back();

  const loadFailure = workflow.isError
    ? workflow.error
    : versions.isError
    ? versions.error
    : undefined;
  const loading = loadFailure === undefined &&
    (workflow.isPending || versions.isPending || access.isPending);
  const name = workflow.data?.name ??
    translate("library.workflow.breadcrumb" as never);

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          { href: "/library", label: translate("library.title" as never) },
          {
            href: `/library/workflows/${workflowId}`,
            label: name,
          },
          { label: translate("library.editor.breadcrumb" as never) },
        ]}
      />
    </ShellSlot>
  );
  const heading = (
    <UI.PageHeader
      variant="list"
      flush
      title={translate("library.editor.title" as never, { name })}
    />
  );
  const shell = (children: React.ReactNode) => (
    <>
      {breadcrumbs}
      <UI.SettingsContent data-testid="workflow-editor" variant="wide">
        {heading}
        {children}
      </UI.SettingsContent>
    </>
  );

  if (loading) {
    return shell(
      <UI.Stack gap="standard" aria-busy="true">
        <UI.Text variant="muted" role="status">
          {translate("library.workflow.loading" as never)}
        </UI.Text>
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>,
    );
  }
  if (loadFailure !== undefined || workflow.data === undefined) {
    const notFound = loadFailure !== undefined &&
      failureStatus(loadFailure) === 404;
    return shell(
      notFound
        ? (
          <UI.EmptyState
            title={translate("library.workflow.notFound.title" as never)}
            description={translate(
              "library.workflow.notFound.description" as never,
            )}
            action={
              <UI.Button
                variant="secondary"
                onClick={() => void navigate({ to: "/library" })}
              >
                {translate("library.workflow.back" as never)}
              </UI.Button>
            }
            variant="firstUse"
          />
        )
        : loadFailure !== undefined && isForbiddenFailure(loadFailure)
        ? (
          <UI.EmptyState
            title={translate("library.forbidden.title" as never)}
            description={translate("library.forbidden.description" as never)}
            variant="firstUse"
          />
        )
        : (
          <UI.ErrorState
            title={translate("library.error.title" as never)}
            description={translate("library.error.description" as never)}
            action={
              <UI.Button
                variant="secondary"
                onClick={() => {
                  void workflow.refetch();
                  void versions.refetch();
                }}
              >
                {translate("library.retry" as never)}
              </UI.Button>
            }
          />
        ),
    );
  }
  if (!canManage) {
    return shell(
      <UI.Stack gap="standard">
        <UI.InlineNotice tone="information">
          {translate("library.workflow.adminOnly" as never)}
        </UI.InlineNotice>
        <UI.Inline gap="compact">
          <UI.Button variant="secondary" onClick={back}>
            {translate("library.editor.back" as never)}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>,
    );
  }
  if (published !== null) {
    return shell(
      <UI.Stack gap="standard">
        <UI.AlertBanner
          tone="success"
          action={
            <UI.Button variant="secondary" onClick={back}>
              {translate("library.editor.back" as never)}
            </UI.Button>
          }
        >
          {translate("library.editor.published" as never, {
            version: published,
          })}
        </UI.AlertBanner>
      </UI.Stack>,
    );
  }
  if (draft === null) {
    return shell(
      <UI.EmptyState
        title={translate("library.editor.noDraft.title" as never)}
        description={translate(
          (newestPublished === null
            ? "library.editor.noDraft.none"
            : "library.editor.noDraft.description") as never,
        )}
        action={newestPublished === null ? undefined : (
          <UI.Button
            variant="primary"
            disabled={offline || pending}
            onClick={() =>
              void run(
                () => start.mutateAsync(newestPublished),
                () => undefined,
              )}
          >
            {translate("library.editor.startDraft" as never, {
              version: newestPublished.revision,
            })}
          </UI.Button>
        )}
        variant="firstUse"
      />,
    );
  }

  const failureNotice = failure === null
    ? null
    : (
      <UI.InlineNotice tone={failure === "conflict" ? "warning" : "error"}>
        {translate(`library.editor.${failure}` as never)}
      </UI.InlineNotice>
    );
  const selectedStep = selected === null ? undefined : stepList[selected];
  const stateText = check.state === "checking"
    ? translate("library.editor.state.checking" as never)
    : check.state === "unreadable"
    ? translate("library.editor.state.unreadable" as never)
    : problems.length > 0
    ? translate("library.editor.state.problems" as never, {
      count: problems.length,
    })
    : translate("library.editor.state.draft" as never);

  const panel = selectedStep === undefined || selected === null
    ? null
    : (
      <UI.Stack gap="standard" data-testid="step-panel">
        <UI.Text variant="muted">
          {translate("library.editor.panel.title" as never, {
            number: selected + 1,
          })}
        </UI.Text>
        <UI.Field
          label={translate("library.editor.panel.name" as never)}
          htmlFor="step-name"
          hint={translate("library.editor.panel.nameHelp" as never)}
        >
          <UI.TextInput
            id="step-name"
            name="name"
            type="text"
            autoComplete="off"
            value={selectedStep.id}
            onChange={(value) =>
              change(setStepField(current, selected, "id", value))}
          />
        </UI.Field>
        <UI.Combobox
          label={translate("library.editor.panel.action" as never)}
          value={selectedStep.uses}
          options={optionsFor(selectedStep.uses)}
          onChange={(event) =>
            change(setStepField(current, selected, "uses", event.target.value))}
        />
        {problemsOn(selected).map((problem, index) => (
          <UI.InlineNotice key={index} tone="error">
            {problem.message}
          </UI.InlineNotice>
        ))}
        <UI.Inline gap="compact">
          <UI.Button
            variant="secondary"
            disabled={selected === 0}
            onClick={() => {
              change(moveStep(current, selected, -1));
              setSelected(selected - 1);
            }}
          >
            {translate("library.editor.panel.up" as never)}
          </UI.Button>
          <UI.Button
            variant="secondary"
            disabled={selected === stepList.length - 1}
            onClick={() => {
              change(moveStep(current, selected, 1));
              setSelected(selected + 1);
            }}
          >
            {translate("library.editor.panel.down" as never)}
          </UI.Button>
          <UI.Button
            variant="secondary"
            onClick={() => {
              change(removeStep(current, selected));
              setSelected(null);
            }}
          >
            {translate("library.editor.panel.remove" as never)}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    );

  const stepsView = !hasStepList(current)
    ? (
      <UI.InlineNotice tone="information">
        {translate("library.editor.noStepList" as never)}
      </UI.InlineNotice>
    )
    : (
      <UI.Inline variant={phone ? "flow" : "split"} gap="spacious">
        <UI.Stack gap="standard">
          <UI.Stack gap="none" role="list" data-testid="editor-steps">
            {stepList.map((step, index) => (
              <div
                key={`${index}-${step.id}`}
                role="listitem"
                data-step-index={index}
                data-selected={selected === index ? "true" : undefined}
              >
                <UI.StackedRow
                  flush
                  title={`${index + 1}. ${title(step.uses)}`}
                  status={problemsOn(index).length > 0
                    ? (
                      <UI.Badge tone="warning">
                        {translate("library.editor.fix" as never)}
                      </UI.Badge>
                    )
                    : undefined}
                >
                  <UI.Text variant="caption">
                    {step.id === ""
                      ? translate("library.editor.noName" as never)
                      : step.id}
                  </UI.Text>
                  {problemsOn(index).map((problem, at) => (
                    <UI.Text key={at} variant="caption">
                      {problem.message}
                    </UI.Text>
                  ))}
                  <UI.Button
                    variant="secondary"
                    aria-label={translate("library.editor.editStep" as never, {
                      number: index + 1,
                    })}
                    onClick={() => setSelected(index)}
                  >
                    {translate("library.editor.edit" as never)}
                  </UI.Button>
                </UI.StackedRow>
              </div>
            ))}
          </UI.Stack>
          <UI.Inline gap="compact">
            <UI.Button
              variant="secondary"
              onClick={() => {
                setNewAction(known[0] ?? "");
                open({ kind: "add" });
              }}
            >
              {translate("library.editor.addStep" as never)}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
        {phone ? null : panel}
      </UI.Inline>
    );

  const codeView = (
    <UI.Stack gap="standard">
      <UI.InlineNotice tone="information">
        {translate("library.editor.codeNote" as never)}
      </UI.InlineNotice>
      <UI.Field
        label={translate("library.editor.code" as never)}
        htmlFor="editor-code"
        variant="textarea"
        error={codeError ?? undefined}
      >
        <textarea
          id="editor-code"
          name="definition"
          rows={16}
          spellCheck={false}
          autoComplete="off"
          value={codeText ?? definitionText(current)}
          onChange={(event) => {
            const text = event.target.value;
            setCodeText(text);
            const read = readDefinitionText(text);
            if (read.ok) {
              setCodeError(null);
              setDefinition(read.definition);
            } else {
              setCodeError(
                translate("library.editor.codeInvalid" as never, {
                  message: read.message,
                }),
              );
            }
          }}
        />
      </UI.Field>
    </UI.Stack>
  );

  const reason = problems.length > 0
    ? translate("library.editor.fixToPublish" as never, {
      count: problems.length,
    })
    : codeError !== null
    ? translate("library.editor.fixCode" as never)
    : check.state !== "done"
    ? translate("library.editor.state.checking" as never)
    : offline
    ? translate("library.workflow.offline" as never)
    : null;
  const actionsNode = (
    <UI.Inline gap="compact">
      <UI.Button
        variant="secondary"
        disabled={!dirty || pending}
        onClick={() => open({ kind: "discard" })}
      >
        {translate("library.editor.discard" as never)}
      </UI.Button>
      <UI.Button
        variant="secondary"
        disabled={!dirty || pending || offline || codeError !== null}
        onClick={() => void run(() => save.mutateAsync(draft), () => undefined)}
      >
        {translate("library.editor.save" as never)}
      </UI.Button>
      <UI.Button
        variant="primary"
        disabled={blocked || pending || offline}
        onClick={() => open({ kind: "publish" })}
      >
        {translate("library.editor.publish" as never)}
      </UI.Button>
    </UI.Inline>
  );

  return (
    <>
      {breadcrumbs}
      {!phone ? <ShellSlot name="actions">{actionsNode}</ShellSlot> : null}
      <UI.SettingsContent data-testid="workflow-editor" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("library.editor.title" as never, { name })}
          subtitle={
            <UI.Stack gap="compact">
              <UI.Text variant="muted">
                {translate("library.editor.headline" as never, {
                  version: draft.revision,
                })}
              </UI.Text>
              <UI.Inline gap="compact">
                <UI.Badge
                  tone={problems.length > 0 ? "warning" : "neutral"}
                  data-testid="editor-state"
                >
                  {stateText}
                </UI.Badge>
                {dirty
                  ? (
                    <UI.Text variant="caption">
                      {translate("library.editor.unsaved" as never)}
                    </UI.Text>
                  )
                  : null}
                <UI.Button variant="quiet" onClick={leave}>
                  {translate("library.editor.back" as never)}
                </UI.Button>
              </UI.Inline>
            </UI.Stack>
          }
          actions={phone ? actionsNode : null}
        />
        <UI.Stack gap="spacious">
          {reason === null
            ? null
            : (
              <UI.Text variant="muted" data-testid="publish-reason">
                {reason}
              </UI.Text>
            )}
          {dialog === null ? failureNotice : null}
          {wholeProblems.length > 0
            ? (
              <UI.AlertBanner tone="error">
                <UI.Stack gap="compact">
                  {wholeProblems.map((problem, index) => (
                    <UI.Text key={index}>{problem.message}</UI.Text>
                  ))}
                </UI.Stack>
              </UI.AlertBanner>
            )
            : null}
          <UI.Tabs
            aria-label={translate("library.editor.tabs" as never)}
            selectedId={tab}
            onSelect={(id) => setTab(id === "code" ? "code" : "steps")}
            tabs={[
              {
                id: "steps",
                label: translate("library.editor.tab.steps" as never),
                content: tab === "steps" ? stepsView : null,
              },
              {
                id: "code",
                label: translate("library.editor.tab.code" as never),
                content: tab === "code" ? codeView : null,
              },
            ]}
          />
        </UI.Stack>
      </UI.SettingsContent>

      {phone && selectedStep !== undefined
        ? (
          <UI.Sheet
            open
            onOpenChange={(next) => !next && setSelected(null)}
            title={translate("library.editor.panel.title" as never, {
              number: (selected ?? 0) + 1,
            })}
            variant="side"
          >
            {panel}
          </UI.Sheet>
        )
        : null}
      {dialog?.kind === "add"
        ? (
          <UI.Dialog
            open
            onOpenChange={(next) => !next && close()}
            title={translate("library.editor.addStep" as never)}
            variant="form"
          >
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                if (newAction === "") return;
                change(addStep(current, newAction, selected ?? undefined));
                setSelected(
                  selected === null ? stepList.length : selected + 1,
                );
                close();
              }}
            >
              <UI.Stack gap="standard">
                <UI.Combobox
                  label={translate("library.editor.panel.action" as never)}
                  value={newAction}
                  options={options}
                  onChange={(event) => setNewAction(event.target.value)}
                />
                <UI.Inline gap="compact">
                  <UI.Button variant="secondary" onClick={close}>
                    {translate("core.actions.cancel")}
                  </UI.Button>
                  <UI.Button
                    type="submit"
                    variant="primary"
                    disabled={newAction === ""}
                  >
                    {translate("library.editor.add" as never)}
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            </form>
          </UI.Dialog>
        )
        : null}
      {dialog?.kind === "publish"
        ? (
          <UI.AlertDialog
            open
            onOpenChange={(next) => !next && !pending && close()}
            state={pending ? "confirming" : "open"}
            title={translate("library.editor.publishDialog.title" as never, {
              version: draft.revision,
            })}
            cancelAction={
              <UI.Button variant="secondary" onClick={close}>
                {translate("core.actions.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="primary"
                disabled={pending}
                onClick={() =>
                  void run(
                    async () => {
                      const result = await publish.mutateAsync(draft);
                      setPublished(result.revision);
                    },
                    () => setDialog(null),
                  )}
              >
                {translate("library.editor.publish" as never)}
              </UI.Button>
            }
          >
            <UI.Stack gap="compact">
              <UI.Text>
                {translate("library.editor.publishDialog.body" as never)}
              </UI.Text>
              {failureNotice}
            </UI.Stack>
          </UI.AlertDialog>
        )
        : null}
      {dialog?.kind === "discard"
        ? (
          <UI.AlertDialog
            open
            onOpenChange={(next) => !next && close()}
            title={translate("library.editor.discardDialog.title" as never)}
            cancelAction={
              <UI.Button variant="secondary" onClick={close}>
                {translate("core.actions.cancel")}
              </UI.Button>
            }
            confirmAction={
              <UI.Button
                variant="primary"
                onClick={() => {
                  setDefinition(saved);
                  setCodeText(null);
                  setCodeError(null);
                  setSelected(null);
                  close();
                }}
              >
                {translate("library.editor.discard" as never)}
              </UI.Button>
            }
          >
            <UI.Text>
              {translate("library.editor.discardDialog.body" as never)}
            </UI.Text>
          </UI.AlertDialog>
        )
        : null}
      {dialog?.kind === "leave"
        ? (
          <UI.AlertDialog
            open
            onOpenChange={(next) => !next && close()}
            title={translate("library.editor.leaveDialog.title" as never)}
            cancelAction={
              <UI.Button variant="secondary" onClick={close}>
                {translate("library.editor.leaveDialog.stay" as never)}
              </UI.Button>
            }
            confirmAction={
              <UI.Button variant="primary" onClick={back}>
                {translate("library.editor.leaveDialog.leave" as never)}
              </UI.Button>
            }
          >
            <UI.Text>
              {translate("library.editor.leaveDialog.body" as never)}
            </UI.Text>
          </UI.AlertDialog>
        )
        : null}
    </>
  );
}
