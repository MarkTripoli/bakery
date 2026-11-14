import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  AgentDefinitionResponse,
  WorkflowDefinitionResponse,
  WorkflowPresetResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  libraryAgentsQueryOptions,
  libraryWorkflowsQueryOptions,
  workflowPresetsQueryOptions,
} from "../api/query.ts";
import { asyncKindForError, isForbiddenFailure } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { WORK_HOME } from "../shell/breadcrumb-paths.ts";
import { ShellSlot } from "../shell/shell-slots.tsx";
import {
  byName,
  definitionBadge,
  libraryTab,
  presetSteps,
} from "./library/library-state.ts";
import { type LibraryRow, LibraryRows } from "./library/LibraryRows.tsx";
import { presetCopy } from "./task-composer-labels.ts";

/**
 * The workflows and agents Bakery uses to do work (design-ux, #66): what is
 * built in and what the organization has made, each with one badge. This
 * first slice only reads; opening, copying and importing follow.
 */
export function LibraryPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const search = useSearch({ strict: false }) as { tab?: string };
  const tab = libraryTab(search.tab);
  const ready = Boolean(scope.organizationId);
  const workflows = useQuery({
    ...libraryWorkflowsQueryOptions(api, scope),
    enabled: ready && tab === "workflows",
  });
  const presets = useQuery({
    ...workflowPresetsQueryOptions(api, scope, null),
    enabled: ready && tab === "workflows",
  });
  const agents = useQuery({
    ...libraryAgentsQueryOptions(api, scope),
    enabled: ready && tab === "agents",
  });
  const active = tab === "workflows" ? [workflows, presets] : [agents];
  const failure = active.find((query) => query.isError)?.error;
  const forbidden = failure !== undefined && isForbiddenFailure(failure);
  const offline = failure !== undefined && !forbidden &&
    asyncKindForError(failure) === "offline";
  const loading = !forbidden && failure === undefined &&
    active.some((query) => query.isPending);

  const badgeRow = (
    definition: WorkflowDefinitionResponse | AgentDefinitionResponse,
    openable = false,
  ): LibraryRow => {
    const badge = definitionBadge(definition);
    return {
      id: definition.id,
      name: definition.name,
      line: definition.description === null ||
          definition.description === undefined || definition.description === ""
        ? translate("library.noDescription" as never)
        : definition.description,
      badge: translate(`library.badge.${badge}` as never),
      tone: badge === "inUse"
        ? "success"
        : badge === "noVersionInUse"
        ? "warning"
        : "neutral",
      note: "",
      ...(openable
        ? {
          openLabel: translate("library.workflow.openNamed" as never, {
            name: definition.name,
          }),
        }
        : {}),
    };
  };
  const presetRow = (preset: WorkflowPresetResponse): LibraryRow => {
    const copy = presetCopy(translate, preset.id);
    return {
      id: preset.id,
      name: copy.title,
      line: copy.description ?? "",
      // The section heading already says Built in.
      badge: null,
      tone: "neutral",
      note: [
        translate("library.builtIn.version" as never, {
          version: preset.revision,
        }),
        translate("library.builtIn.steps" as never, {
          count: presetSteps(preset),
        }),
      ].join(" · "),
    };
  };

  const section = (
    id: string,
    title: string,
    description: string | undefined,
    rows: readonly LibraryRow[],
    label: string,
  ) => (
    <UI.ListSection
      data-testid={id}
      flush
      title={title}
      description={description}
      variant={phone ? "list" : "table"}
    >
      <LibraryRows
        label={label}
        onOpen={(row) =>
          void navigate({
            to: "/library/workflows/$workflowId",
            params: { workflowId: row.id },
          })}
        rows={rows}
        translate={translate}
      />
    </UI.ListSection>
  );
  const empty = (title: string, description: string) => (
    <UI.EmptyState
      title={title}
      description={description}
      variant="firstUse"
    />
  );

  const workflowRows = byName(workflows.data?.items ?? []).map((row) =>
    badgeRow(row, true)
  );
  const agentRows = byName(agents.data?.items ?? []).map((row) =>
    badgeRow(row)
  );
  const truncated = tab === "workflows"
    ? workflows.data?.truncated
    : agents.data?.truncated;

  const content = forbidden
    ? (
      <UI.EmptyState
        title={translate("library.forbidden.title" as never)}
        description={translate("library.forbidden.description" as never)}
        variant="firstUse"
      />
    )
    : loading
    ? (
      <UI.Stack gap="standard" aria-busy="true">
        <UI.Text variant="muted" role="status">
          {translate("library.loading" as never)}
        </UI.Text>
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    )
    : failure !== undefined
    ? (
      <UI.ErrorState
        title={translate(
          (offline ? "library.offlineTitle" : "library.error.title") as never,
        )}
        description={translate(
          (offline
            ? "library.offlineDescription"
            : "library.error.description") as never,
        )}
        action={
          <UI.Button
            variant="secondary"
            onClick={() => active.forEach((query) => void query.refetch())}
          >
            {translate("library.retry" as never)}
          </UI.Button>
        }
      />
    )
    : (
      <UI.Stack gap="spacious">
        {truncated
          ? (
            <UI.InlineNotice tone="warning">
              {translate("library.truncated" as never)}
            </UI.InlineNotice>
          )
          : null}
        {tab === "workflows"
          ? (
            <>
              {section(
                "library-built-in",
                translate("library.builtIn.title" as never),
                translate("library.builtIn.description" as never),
                (presets.data?.items ?? []).map(presetRow),
                translate("library.builtIn.listLabel" as never),
              )}
              {workflowRows.length > 0
                ? section(
                  "library-organization",
                  translate("library.organization.title" as never),
                  undefined,
                  workflowRows,
                  translate("library.workflows.listLabel" as never),
                )
                : (
                  <UI.ListSection
                    data-testid="library-organization"
                    flush
                    title={translate("library.organization.title" as never)}
                    variant={phone ? "list" : "table"}
                  >
                    {empty(
                      translate("library.workflows.emptyTitle" as never),
                      translate("library.workflows.emptyDescription" as never),
                    )}
                  </UI.ListSection>
                )}
            </>
          )
          : agentRows.length > 0
          ? section(
            "library-organization",
            translate("library.organization.title" as never),
            undefined,
            agentRows,
            translate("library.agents.listLabel" as never),
          )
          : (
            <UI.ListSection
              data-testid="library-organization"
              flush
              title={translate("library.organization.title" as never)}
              variant={phone ? "list" : "table"}
            >
              {empty(
                translate("library.agents.emptyTitle" as never),
                translate("library.agents.emptyDescription" as never),
              )}
            </UI.ListSection>
          )}
      </UI.Stack>
    );

  return (
    <>
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[
            {
              href: WORK_HOME,
              label: translate("shell.navigation.workspace"),
            },
            { label: translate("library.title" as never) },
          ]}
        />
      </ShellSlot>
      <UI.SettingsContent data-testid="library-page" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("library.title" as never)}
          subtitle={translate("library.description" as never)}
        />
        <UI.Tabs
          aria-label={translate("library.tabs.label" as never)}
          variant="route"
          selectedId={tab}
          onSelect={(id) =>
            void navigate({
              to: "/library",
              search: { tab: id === "agents" ? "agents" : undefined },
              replace: true,
            })}
          tabs={[
            {
              id: "workflows",
              label: translate("library.tab.workflows" as never),
              content: tab === "workflows" ? content : null,
            },
            {
              id: "agents",
              label: translate("library.tab.agents" as never),
              content: tab === "agents" ? content : null,
            },
          ]}
        />
      </UI.SettingsContent>
    </>
  );
}
