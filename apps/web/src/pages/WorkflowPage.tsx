import { useMemo, useRef, useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  AgentVersionResponse,
  WorkflowDefinitionResponse,
  WorkflowVersionResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  agentVersionsQueryOptions,
  effectiveAccessQueryOptions,
  libraryAgentsQueryOptions,
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
  agentBindings,
  canUse,
  defaultVersion,
  exportFileName,
  newestFirst,
  stepsOf,
  versionState,
} from "./library/workflow-state.ts";

/** The sentences for the actions a definition's steps run most. */
const ACTION_TITLES: Readonly<Record<string, string>> = {
  "task.brief": "library.workflow.action.taskBrief",
  "harness.implement": "library.workflow.action.harnessImplement",
  "agent.review": "library.workflow.action.agentReview",
};

/** How many versions the Versions card lists before "Show all". */
const CARD_VERSIONS = 5;

type Dialog =
  | { readonly kind: "use"; readonly version: WorkflowVersionResponse }
  | { readonly kind: "off" }
  | { readonly kind: "rename" }
  | { readonly kind: "all" }
  | null;

/** What went wrong with a change, in the words the page has for it. */
type Failure = "conflict" | "offline" | "failed" | null;

function failureOf(error: unknown): Exclude<Failure, null> {
  if (asyncKindForError(error) === "offline") return "offline";
  const status = failureStatus(error);
  return status === 409 || status === 412 ? "conflict" : "failed";
}

/**
 * One workflow of the organization (design-ux, #66): its steps in the version
 * being viewed, its versions with the one in use, and the changes an
 * administrator may make to which version is used and whether it is on.
 * Editing a version is the editor's (#67).
 */
export function WorkflowPage({ workflowId }: { readonly workflowId: string }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { translate, locale, timeZone } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const offline = useConnectivity() === "offline";
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const canManage = access.data?.role === "admin";
  const workflow = useQuery(workflowQueryOptions(api, scope, workflowId));
  const versions = useQuery(
    workflowVersionsQueryOptions(api, scope, workflowId),
  );
  const agents = useQuery(libraryAgentsQueryOptions(api, scope));
  const agentList = agents.data?.items ?? [];
  const agentVersionReads = useQueries({
    queries: agentList.map((agent) =>
      agentVersionsQueryOptions(api, scope, agent.id)
    ),
  });
  // The version being viewed is the page's address, so it can be shared.
  const viewing = (useSearch({ strict: false }) as { version?: string })
    .version ?? null;
  const setViewing = (versionId: string) =>
    void navigate({
      to: "/library/workflows/$workflowId",
      params: { workflowId },
      search: { version: versionId },
      replace: true,
    });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [failure, setFailure] = useState<Failure>(null);
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(value),
    );
  // A step is named by what it does; an action without a sentence shows its key.
  const stepTitle = (uses: string) => {
    const key = ACTION_TITLES[uses];
    return key === undefined ? uses : translate(key as never);
  };
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });
  const organizationId = scope.organizationId as string;

  const activate = useMutation({
    mutationKey: ["workflowActivations.create"],
    mutationFn: async (
      { current, versionId }: {
        current: WorkflowDefinitionResponse;
        versionId: string;
      },
    ) => {
      const result = await api.activateWorkflowVersion({
        organizationId,
        id: current.id,
        versionId,
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });
  const update = useMutation({
    mutationKey: ["workflows.update"],
    mutationFn: async (
      { current, input }: {
        current: WorkflowDefinitionResponse;
        input: { name?: string; enabled?: boolean };
      },
    ) => {
      const result = await api.updateWorkflow({
        organizationId,
        id: current.id,
        input,
        version: current.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSettled: refresh,
  });
  const pending = activate.isPending || update.isPending;

  const open = (next: Dialog) => {
    opener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setFailure(null);
    setDialog(next);
  };
  const close = () => {
    setDialog(null);
    setTried(false);
    focusAfterPaint(() => opener.current);
  };
  const run = async (change: () => Promise<unknown>, done: () => void) => {
    setFailure(null);
    try {
      await change();
      done();
    } catch (error) {
      setFailure(failureOf(error));
    }
  };

  const loadFailure = workflow.isError
    ? workflow.error
    : versions.isError
    ? versions.error
    : undefined;
  const notFound = loadFailure !== undefined &&
    failureStatus(loadFailure) === 404;
  const forbidden = loadFailure !== undefined &&
    isForbiddenFailure(loadFailure);
  const loading = loadFailure === undefined &&
    (workflow.isPending || versions.isPending);
  const current = workflow.data;
  const all = newestFirst(versions.data?.items ?? []);
  const versionsTruncated = versions.data?.truncated === true;
  const activeId = current?.activeVersionId ?? null;
  const shown = all.find((version) => version.id === viewing) ??
    defaultVersion(all, activeId);
  const bindings = useMemo(() => {
    const byAgent = new Map<string, readonly AgentVersionResponse[]>();
    agentList.forEach((agent, index) => {
      byAgent.set(agent.id, agentVersionReads[index]?.data?.items ?? []);
    });
    return agentBindings(agentList, byAgent);
  }, [agentList, agentVersionReads]);
  // What an agent line may say: nothing while the reads are in flight, that it
  // could not be read when they failed (or were cut short), else the answer.
  const agentReads: "pending" | "failed" | "ready" = agents.isError ||
      agentVersionReads.some((read) =>
        read.isError || read.data?.truncated === true
      )
    ? "failed"
    : agents.isPending || agentVersionReads.some((read) => read.isPending)
    ? "pending"
    : "ready";
  const published = all.filter((version) => version.status === "published");
  const newestPublished = published[0] ?? null;
  const noneInUse = current !== undefined && current.enabled &&
    activeId === null && newestPublished !== null;
  const draftOnly = current !== undefined && current.enabled &&
    activeId === null && newestPublished === null && all.length > 0;

  const exportVersion = (version: WorkflowVersionResponse) => {
    const link = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob([version.sourceYaml], { type: "application/yaml" }),
    );
    link.href = url;
    link.download = exportFileName(current?.slug ?? "", version.revision);
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const stateBadge = (version: WorkflowVersionResponse) => {
    const state = versionState(version, activeId);
    return state === "inUse"
      ? (
        <UI.Inline gap="compact">
          <UI.Badge tone="success">
            {translate("library.workflow.versions.inUse" as never)}
          </UI.Badge>
          <UI.HelpTip
            closeLabel={translate("core.actions.close")}
            label={translate("library.workflow.versions.inUse" as never)}
          >
            {translate("library.workflow.versions.inUseHelp" as never)}
          </UI.HelpTip>
        </UI.Inline>
      )
      : state === "draft"
      ? (
        <UI.Badge tone="neutral">
          {translate("library.workflow.versions.draft" as never)}
        </UI.Badge>
      )
      : state === "retired"
      ? (
        <UI.Badge tone="neutral">
          {translate("library.workflow.versions.retired" as never)}
        </UI.Badge>
      )
      : (
        <UI.Badge tone="neutral">
          {translate("library.workflow.versions.published" as never)}
        </UI.Badge>
      );
  };

  const versionRow = (version: WorkflowVersionResponse, sheet: boolean) => {
    const state = versionState(version, activeId);
    const isShown = shown?.id === version.id;
    return (
      <div
        key={version.id}
        data-version-id={version.id}
        data-version-state={state}
      >
        <UI.StackedRow
          flush
          title={translate("library.workflow.versions.row" as never, {
            version: version.revision,
          })}
          status={stateBadge(version)}
        >
          <UI.Text variant="caption">
            {state === "draft"
              ? translate("library.workflow.versions.changed" as never, {
                date: date(version.updatedAt),
              })
              : translate("library.workflow.versions.created" as never, {
                date: date(version.createdAt),
              })}
          </UI.Text>
          {sheet
            ? (
              <UI.Text variant="caption">
                {translate("library.workflow.versions.fingerprint" as never)}
                {": "}
                <UI.DataText>{version.digest.slice(0, 12)}</UI.DataText>
              </UI.Text>
            )
            : null}
          <UI.Inline gap="compact">
            {canManage && canUse(version, activeId)
              ? (
                <UI.Button
                  variant="secondary"
                  disabled={offline || pending}
                  onClick={() => open({ kind: "use", version })}
                >
                  {translate("library.workflow.versions.use" as never)}
                </UI.Button>
              )
              : null}
            {sheet || state !== "retired"
              ? isShown
                ? (
                  <UI.Text variant="muted">
                    {translate("library.workflow.versions.shown" as never)}
                  </UI.Text>
                )
                : (
                  <UI.Inline gap="compact" data-view-link="">
                    <UI.Link
                      href={`/library/workflows/${workflowId}?version=${version.id}`}
                      aria-label={translate(
                        "library.workflow.versions.viewNamed" as never,
                        { version: version.revision },
                      )}
                      onClick={(event) => {
                        event.preventDefault();
                        setViewing(version.id);
                        if (sheet) close();
                      }}
                    >
                      {translate("library.workflow.versions.view" as never)}
                    </UI.Link>
                  </UI.Inline>
                )
              : null}
            {sheet
              ? (
                <UI.Button
                  variant="quiet"
                  onClick={() => exportVersion(version)}
                >
                  {translate("library.workflow.export" as never)}
                </UI.Button>
              )
              : null}
          </UI.Inline>
        </UI.StackedRow>
      </div>
    );
  };

  const failureNotice = failure === null
    ? null
    : (
      <UI.InlineNotice tone={failure === "conflict" ? "warning" : "error"}>
        {translate(`library.workflow.${failure}` as never)}
      </UI.InlineNotice>
    );

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          { href: "/library", label: translate("library.title" as never) },
          {
            label: current?.name ??
              translate("library.workflow.breadcrumb" as never),
          },
        ]}
      />
    </ShellSlot>
  );

  if (loading) {
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="workflow-page" variant="wide">
          <UI.PageHeader
            variant="list"
            flush
            title={translate("library.workflow.breadcrumb" as never)}
          />
          <UI.Stack gap="standard" aria-busy="true">
            <UI.Text variant="muted" role="status">
              {translate("library.workflow.loading" as never)}
            </UI.Text>
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        </UI.SettingsContent>
      </>
    );
  }
  if (current === undefined || loadFailure !== undefined) {
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="workflow-page" variant="wide">
          <UI.PageHeader
            variant="list"
            flush
            title={translate("library.workflow.breadcrumb" as never)}
          />
          {notFound
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
            : forbidden
            ? (
              <UI.EmptyState
                title={translate("library.forbidden.title" as never)}
                description={translate(
                  "library.forbidden.description" as never,
                )}
                variant="firstUse"
              />
            )
            : (
              <UI.ErrorState
                title={translate(
                  (asyncKindForError(loadFailure) === "offline"
                    ? "library.offlineTitle"
                    : "library.error.title") as never,
                )}
                description={translate(
                  (asyncKindForError(loadFailure) === "offline"
                    ? "library.offlineDescription"
                    : "library.error.description") as never,
                )}
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
            )}
        </UI.SettingsContent>
      </>
    );
  }

  const steps = shown === null ? [] : stepsOf(shown);
  const badge = !current.enabled
    ? (
      <UI.Badge tone="neutral">
        {translate("library.badge.turnedOff" as never)}
      </UI.Badge>
    )
    : activeId === null
    ? (
      <UI.Badge tone="warning">
        {translate("library.badge.noVersionInUse" as never)}
      </UI.Badge>
    )
    : (
      <UI.Badge tone="success">
        {translate("library.badge.inUse" as never)}
      </UI.Badge>
    );
  const menuItems = [
    ...(canManage
      ? [{
        id: "rename",
        label: translate("library.workflow.rename" as never),
        disabled: offline || pending,
      }]
      : []),
    {
      id: "export",
      label: translate("library.workflow.export" as never),
      disabled: shown === null,
    },
    ...(canManage
      ? [{
        id: current.enabled ? "off" : "on",
        label: translate(
          (current.enabled
            ? "library.workflow.turnOff"
            : "library.workflow.turnOn") as never,
        ),
        disabled: offline || pending,
      }]
      : []),
  ];

  const moreMenu = (
    <UI.Inline gap="compact" data-trailing-popover={phone ? "start" : ""}>
      <UI.Popover
        label={translate("library.workflow.moreNamed" as never, {
          name: current.name,
        })}
        variant="interactive"
        open={menuOpen}
        onOpenChange={setMenuOpen}
        triggerAppearance="toolbar"
        trigger={
          <>
            {translate("library.workflow.more" as never)}
            <UI.VisuallyHidden>
              {translate("library.workflow.moreAbout" as never, {
                name: current.name,
              })}
            </UI.VisuallyHidden>
          </>
        }
      >
        <UI.Menu
          aria-label={translate("library.workflow.moreNamed" as never, {
            name: current.name,
          })}
          items={menuItems}
          onSelect={(id) => {
            const trigger = document.querySelector<HTMLElement>(
              '[data-testid="workflow-page"] .ui-popover__trigger, .bakery-top-bar__actions .ui-popover__trigger',
            );
            setMenuOpen(false);
            if (id === "export" && shown !== null) {
              exportVersion(shown);
            } else if (id === "rename") {
              setName(current.name);
              open({ kind: "rename" });
            } else if (id === "off") {
              open({ kind: "off" });
            } else if (id === "on") {
              void run(
                () =>
                  update.mutateAsync({ current, input: { enabled: true } }),
                () =>
                  undefined,
              );
            }
            if (trigger !== null && id !== "on" && id !== "export") {
              opener.current = trigger;
            }
          }}
        />
      </UI.Popover>
    </UI.Inline>
  );

  return (
    <>
      {breadcrumbs}
      {!phone ? <ShellSlot name="actions">{moreMenu}</ShellSlot> : null}
      <UI.SettingsContent data-testid="workflow-page" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={current.name}
          subtitle={
            <UI.Stack gap="compact">
              {current.description !== null && current.description !== ""
                ? <UI.Text variant="muted">{current.description}</UI.Text>
                : null}
              <UI.Inline gap="compact">{badge}</UI.Inline>
            </UI.Stack>
          }
          actions={phone ? moreMenu : null}
        />
        <UI.Stack gap="spacious">
          {!canManage
            ? (
              <UI.InlineNotice tone="information">
                {translate("library.workflow.adminOnly" as never)}
              </UI.InlineNotice>
            )
            : null}
          {dialog === null ? failureNotice : null}
          {noneInUse
            ? (
              <UI.AlertBanner
                tone="warning"
                action={canManage && newestPublished !== null
                  ? (
                    <UI.Button
                      variant="secondary"
                      disabled={offline || pending}
                      onClick={() =>
                        open({ kind: "use", version: newestPublished })}
                    >
                      {translate(
                        "library.workflow.versions.useNamed" as never,
                        { version: newestPublished.revision },
                      )}
                    </UI.Button>
                  )
                  : undefined}
              >
                {translate("library.workflow.noneInUse" as never)}
              </UI.AlertBanner>
            )
            : null}
          {draftOnly
            ? (
              <UI.Text variant="muted">
                {translate("library.workflow.draftOnly" as never)}
              </UI.Text>
            )
            : null}
          <UI.ListSection
            flush
            data-testid="workflow-steps"
            title={shown === null
              ? translate("library.workflow.versions.none" as never)
              : translate("library.workflow.steps.title" as never, {
                version: shown.revision,
              })}
            variant="list"
          >
            {steps.length === 0
              ? (
                <UI.Text variant="muted">
                  {translate("library.workflow.steps.none" as never)}
                </UI.Text>
              )
              : (
                <UI.StepList
                  label={translate("library.workflow.steps.label" as never)}
                >
                  {steps.map((step, index) => {
                    const binding = step.agentVersionId === null ||
                        agentReads === "pending"
                      ? null
                      : bindings.get(step.agentVersionId) ?? undefined;
                    return (
                      <UI.StepItem
                        key={step.id}
                        data-step-id={step.id}
                        number={index + 1}
                        status="upcoming"
                        statusLabel={translate(
                          "library.workflow.steps.number" as never,
                          { n: index + 1 },
                        )}
                        title={stepTitle(step.uses)}
                        summary={binding === null ? undefined : (
                          binding === undefined
                            ? translate(
                              (agentReads === "failed"
                                ? "library.workflow.steps.agentUnreadable"
                                : "library.workflow.steps.agentUnknown") as never,
                            )
                            : translate(
                              "library.workflow.steps.agent" as never,
                              {
                                name: binding.agentName,
                                version: binding.revision,
                              },
                            )
                        )}
                      />
                    );
                  })}
                </UI.StepList>
              )}
          </UI.ListSection>
          <UI.ListSection
            flush
            data-testid="workflow-versions"
            title={translate("library.workflow.versions.title" as never)}
            description={translate("library.workflow.steps.never" as never)}
            variant="list"
          >
            {versionsTruncated
              ? (
                <UI.InlineNotice tone="warning">
                  {translate("library.workflow.versions.truncated" as never)}
                </UI.InlineNotice>
              )
              : null}
            {all.length === 0
              ? (
                <UI.Text variant="muted">
                  {translate("library.workflow.versions.none" as never)}
                </UI.Text>
              )
              : (
                <UI.Stack gap="none" role="list">
                  {all.slice(0, CARD_VERSIONS).map((version) => (
                    <div key={version.id} role="listitem">
                      {versionRow(version, false)}
                    </div>
                  ))}
                </UI.Stack>
              )}
            {all.length > CARD_VERSIONS
              ? (
                <UI.Button
                  variant="quiet"
                  onClick={() => open({ kind: "all" })}
                >
                  {translate("library.workflow.versions.showAll" as never, {
                    count: all.length,
                  })}
                </UI.Button>
              )
              : null}
          </UI.ListSection>
        </UI.Stack>
      </UI.SettingsContent>

      {dialog?.kind === "use"
        ? (
          <UI.AlertDialog
            open
            onOpenChange={(next) => !next && !pending && close()}
            state={activate.isPending ? "confirming" : "open"}
            title={translate("library.workflow.use.title" as never, {
              version: dialog.version.revision,
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
                    () =>
                      activate.mutateAsync({
                        current,
                        versionId: dialog.version.id,
                      }),
                    close,
                  )}
              >
                {translate("library.workflow.versions.useNamed" as never, {
                  version: dialog.version.revision,
                })}
              </UI.Button>
            }
          >
            <UI.Stack gap="compact">
              <UI.Text>
                {translate("library.workflow.use.body" as never, {
                  version: dialog.version.revision,
                })}
              </UI.Text>
              {failureNotice}
            </UI.Stack>
          </UI.AlertDialog>
        )
        : null}
      {dialog?.kind === "off"
        ? (
          <UI.AlertDialog
            open
            onOpenChange={(next) => !next && !pending && close()}
            state={update.isPending ? "confirming" : "open"}
            title={translate("library.workflow.turnOff.title" as never, {
              name: current.name,
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
                    () =>
                      update.mutateAsync({
                        current,
                        input: { enabled: false },
                      }),
                    close,
                  )}
              >
                {translate("library.workflow.turnOff" as never)}
              </UI.Button>
            }
          >
            <UI.Stack gap="compact">
              <UI.Text>
                {translate("library.workflow.turnOff.body" as never)}
              </UI.Text>
              {failureNotice}
            </UI.Stack>
          </UI.AlertDialog>
        )
        : null}
      {dialog?.kind === "rename"
        ? (
          <UI.Dialog
            open
            onOpenChange={(next) => !next && !pending && close()}
            state={update.isPending ? "submitting" : "open"}
            title={translate("library.workflow.renameDialog.title" as never)}
            variant="form"
          >
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                setTried(true);
                if (name.trim() === "") return;
                void run(
                  () =>
                    update.mutateAsync({
                      current,
                      input: { name: name.trim() },
                    }),
                  close,
                );
              }}
            >
              <UI.Stack gap="standard">
                <UI.Field
                  label={translate(
                    "library.workflow.renameDialog.name" as never,
                  )}
                  htmlFor="workflow-rename"
                  required
                  error={tried && name.trim() === ""
                    ? translate("library.workflow.renameDialog.empty" as never)
                    : undefined}
                >
                  <UI.TextInput
                    id="workflow-rename"
                    name="name"
                    type="text"
                    autoComplete="off"
                    value={name}
                    invalid={tried && name.trim() === "" || undefined}
                    onChange={(value) => setName(value.slice(0, 200))}
                  />
                </UI.Field>
                {failureNotice}
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="secondary"
                    disabled={pending}
                    onClick={close}
                  >
                    {translate("core.actions.cancel")}
                  </UI.Button>
                  <UI.Button
                    type="submit"
                    variant="primary"
                    disabled={pending}
                  >
                    {translate("library.workflow.renameDialog.save" as never)}
                  </UI.Button>
                </UI.Inline>
              </UI.Stack>
            </form>
          </UI.Dialog>
        )
        : null}
      {dialog?.kind === "all"
        ? (
          <UI.Sheet
            open
            onOpenChange={(next) => !next && close()}
            title={translate("library.workflow.versions.allTitle" as never, {
              name: current.name,
            })}
            variant="side"
          >
            {versionsTruncated
              ? (
                <UI.InlineNotice tone="warning">
                  {translate("library.workflow.versions.truncated" as never)}
                </UI.InlineNotice>
              )
              : null}
            <UI.Stack gap="none" role="list">
              {all.map((version) => (
                <div key={version.id} role="listitem">
                  {versionRow(version, true)}
                </div>
              ))}
            </UI.Stack>
          </UI.Sheet>
        )
        : null}
    </>
  );
}
