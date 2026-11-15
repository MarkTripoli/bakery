import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  AgentDefinitionResponse,
  AgentVersionResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  agentQueryOptions,
  agentVersionsQueryOptions,
  effectiveAccessQueryOptions,
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
  defaultVersion,
  newestFirst,
  summaryOf,
} from "./library/agent-state.ts";
import { definitionBadge } from "./library/library-state.ts";

/** How many versions the Versions card lists before "Show all". */
const CARD_VERSIONS = 5;

type Dialog =
  | { readonly kind: "use"; readonly version: AgentVersionResponse }
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
 * One agent of the organization (design-ux, #66): what its version in use is
 * configured to do, its versions, and an administrator's changes to which
 * version is used and whether it is on. A version never changes once made;
 * workflows keep the agent version they were published with.
 */
export function AgentPage({ agentId }: { readonly agentId: string }) {
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
  const agent = useQuery(agentQueryOptions(api, scope, agentId));
  const versions = useQuery(agentVersionsQueryOptions(api, scope, agentId));
  // The version being viewed is the page's address, so it can be shared.
  const viewing = (useSearch({ strict: false }) as { version?: string })
    .version ?? null;
  const setViewing = (versionId: string) =>
    void navigate({
      to: "/library/agents/$agentId",
      params: { agentId },
      search: { version: versionId },
      replace: true,
    });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [failure, setFailure] = useState<Failure>(null);
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const organizationId = scope.organizationId as string;

  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(value),
    );
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["protected"] });

  const activate = useMutation({
    mutationKey: ["agents.activateVersion"],
    mutationFn: async (
      { current, versionId }: {
        current: AgentDefinitionResponse;
        versionId: string;
      },
    ) => {
      const result = await api.activateAgentVersion({
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
    mutationKey: ["agents.update"],
    mutationFn: async (
      { current, input }: {
        current: AgentDefinitionResponse;
        input: { name?: string; enabled?: boolean };
      },
    ) => {
      const result = await api.updateAgent({
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

  const loadFailure = agent.isError
    ? agent.error
    : versions.isError
    ? versions.error
    : undefined;
  const notFound = loadFailure !== undefined &&
    failureStatus(loadFailure) === 404;
  const forbidden = loadFailure !== undefined &&
    isForbiddenFailure(loadFailure);
  const loading = loadFailure === undefined &&
    (agent.isPending || versions.isPending);
  const current = agent.data;
  const all = newestFirst(versions.data?.items ?? []);
  const versionsTruncated = versions.data?.truncated === true;
  const activeId = current?.activeVersionId ?? null;
  const shown = all.find((version) => version.id === viewing) ??
    defaultVersion(all, activeId);
  const newest = all[0] ?? null;
  const noneInUse = current !== undefined && current.enabled &&
    activeId === null && newest !== null;

  const failureNotice = failure === null
    ? null
    : (
      <UI.InlineNotice tone={failure === "conflict" ? "warning" : "error"}>
        {translate(`library.workflow.${failure}` as never)}
      </UI.InlineNotice>
    );
  const harnessLabel = (harness: string | null) =>
    harness === null ? translate("library.agent.notSet" as never) : ({
      claude_code: "Claude Code",
      codex: "Codex",
      pi: "Pi",
      mastra: "Mastra",
    } as Record<string, string>)[harness] ?? harness;
  // A label with the help button that says what the identifiers below it mean.
  const helpLabel = (key: "tools" | "prompts" | "skills") => (
    <UI.Inline gap="compact">
      {translate(`library.agent.${key}` as never)}
      <UI.HelpTip
        closeLabel={translate("core.actions.close")}
        label={translate(`library.agent.${key}` as never)}
      >
        {translate(`library.agent.${key}.help` as never)}
      </UI.HelpTip>
    </UI.Inline>
  );
  const names = (list: readonly string[]) =>
    list.length === 0
      ? translate("library.agent.none" as never)
      : <UI.DataText>{list.join(", ")}</UI.DataText>;

  const stateBadge = (version: AgentVersionResponse) =>
    version.id === activeId
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
      : undefined;

  const versionRow = (version: AgentVersionResponse, sheet: boolean) => {
    const inUse = version.id === activeId;
    const isShown = shown?.id === version.id;
    return (
      <div
        key={version.id}
        data-version-id={version.id}
        data-version-state={inUse ? "inUse" : "other"}
      >
        <UI.StackedRow
          flush
          title={translate("library.workflow.versions.row" as never, {
            version: version.revision,
          })}
          status={stateBadge(version)}
        >
          <UI.Text variant="caption">
            {translate("library.workflow.versions.created" as never, {
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
            {canManage && !inUse
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
            {isShown
              ? (
                <UI.Text variant="muted">
                  {translate("library.workflow.versions.shown" as never)}
                </UI.Text>
              )
              : (
                <UI.Inline gap="compact" data-view-link="">
                  <UI.Link
                    href={`/library/agents/${agentId}?version=${version.id}`}
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
              )}
          </UI.Inline>
        </UI.StackedRow>
      </div>
    );
  };

  const breadcrumbs = (
    <ShellSlot name="breadcrumbs">
      <UI.Breadcrumbs
        aria-label={translate("shell.navigation.breadcrumb")}
        items={[
          { href: WORK_HOME, label: translate("shell.navigation.workspace") },
          {
            href: "/library?tab=agents",
            label: translate("library.title" as never),
          },
          {
            label: current?.name ??
              translate("library.agent.breadcrumb" as never),
          },
        ]}
      />
    </ShellSlot>
  );
  const heading = (
    <UI.PageHeader
      variant="list"
      flush
      title={translate("library.agent.breadcrumb" as never)}
    />
  );

  if (loading) {
    return (
      <>
        {breadcrumbs}
        <UI.SettingsContent data-testid="agent-page" variant="wide">
          {heading}
          <UI.Stack gap="standard" aria-busy="true">
            <UI.Text variant="muted" role="status">
              {translate("library.agent.loading" as never)}
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
        <UI.SettingsContent data-testid="agent-page" variant="wide">
          {heading}
          {notFound
            ? (
              <UI.EmptyState
                title={translate("library.agent.notFound.title" as never)}
                description={translate(
                  "library.workflow.notFound.description" as never,
                )}
                action={
                  <UI.Button
                    variant="secondary"
                    onClick={() =>
                      void navigate({
                        to: "/library",
                        search: { tab: "agents" },
                      })}
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
                      void agent.refetch();
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

  const badge = definitionBadge(current);
  const summary = shown === null ? null : summaryOf(shown);
  const menuItems = canManage
    ? [
      {
        id: "rename",
        label: translate("library.workflow.rename" as never),
        disabled: offline || pending,
      },
      {
        id: current.enabled ? "off" : "on",
        label: translate(
          (current.enabled
            ? "library.workflow.turnOff"
            : "library.workflow.turnOn") as never,
        ),
        disabled: offline || pending,
      },
    ]
    : [];
  const moreMenu = menuItems.length === 0
    ? null
    : (
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
            onSelect={(id: string) => {
              const trigger = document.querySelector<HTMLElement>(
                '[data-testid="agent-page"] .ui-popover__trigger, .bakery-top-bar__actions .ui-popover__trigger',
              );
              setMenuOpen(false);
              if (id === "rename") {
                setName(current.name);
                open({ kind: "rename" });
              } else if (id === "off") {
                open({ kind: "off" });
              } else if (id === "on") {
                void run(
                  () =>
                    update.mutateAsync({ current, input: { enabled: true } }),
                  () => undefined,
                );
              }
              if (trigger !== null && id !== "on") opener.current = trigger;
            }}
          />
        </UI.Popover>
      </UI.Inline>
    );

  return (
    <>
      {breadcrumbs}
      {!phone && moreMenu !== null
        ? <ShellSlot name="actions">{moreMenu}</ShellSlot>
        : null}
      <UI.SettingsContent data-testid="agent-page" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={current.name}
          subtitle={
            <UI.Stack gap="compact">
              <UI.Text variant="muted">
                {current.description === null ||
                    current.description === undefined ||
                    current.description === ""
                  ? translate("library.noDescription" as never)
                  : current.description}
              </UI.Text>
              <UI.Inline gap="compact">
                <UI.Badge
                  tone={badge === "inUse"
                    ? "success"
                    : badge === "noVersionInUse"
                    ? "warning"
                    : "neutral"}
                >
                  {translate(`library.badge.${badge}` as never)}
                </UI.Badge>
              </UI.Inline>
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
          {viewing !== null && !all.some((version) => version.id === viewing)
            ? (
              <UI.InlineNotice tone="information">
                {translate(
                  (activeId === null
                    ? "library.workflow.versions.unknownNewest"
                    : "library.workflow.versions.unknownInUse") as never,
                )}
              </UI.InlineNotice>
            )
            : null}
          {dialog === null ? failureNotice : null}
          {noneInUse
            ? (
              <UI.AlertBanner
                tone="warning"
                action={canManage && newest !== null
                  ? (
                    <UI.Button
                      variant="secondary"
                      disabled={offline || pending}
                      onClick={() => open({ kind: "use", version: newest })}
                    >
                      {translate(
                        "library.workflow.versions.useNamed" as never,
                        { version: newest.revision },
                      )}
                    </UI.Button>
                  )
                  : undefined}
              >
                {translate("library.agent.noneInUse" as never)}
              </UI.AlertBanner>
            )
            : null}
          <UI.ListSection
            flush
            data-testid="agent-details"
            title={shown === null
              ? translate("library.agent.versions.none" as never)
              : translate("library.agent.details.title" as never, {
                version: shown.revision,
              })}
            variant="list"
          >
            {summary === null ? null : (
              <UI.DescriptionList>
                <UI.DetailRow
                  label={translate("library.agent.runsOn" as never)}
                >
                  {harnessLabel(summary.harness)}
                </UI.DetailRow>
                <UI.DetailRow label={translate("library.agent.model" as never)}>
                  {summary.model ??
                    translate("library.agent.notSet" as never)}
                </UI.DetailRow>
                <UI.DetailRow label={helpLabel("tools")}>
                  {names(summary.capabilities)}
                </UI.DetailRow>
                <UI.DetailRow label={helpLabel("prompts")}>
                  {names(summary.prompts)}
                </UI.DetailRow>
                <UI.DetailRow label={helpLabel("skills")}>
                  {names(summary.skills)}
                </UI.DetailRow>
              </UI.DescriptionList>
            )}
          </UI.ListSection>
          <UI.ListSection
            flush
            data-testid="agent-versions"
            title={translate("library.workflow.versions.title" as never)}
            description={translate("library.agent.versions.note" as never)}
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
                  {translate("library.agent.versions.none" as never)}
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
                {translate("library.agent.use.body" as never, {
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
            title={translate("library.agent.renameDialog.title" as never)}
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
                  htmlFor="agent-rename"
                  required
                  error={tried && name.trim() === ""
                    ? translate("library.workflow.renameDialog.empty" as never)
                    : undefined}
                >
                  <UI.TextInput
                    id="agent-rename"
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
