import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type {
  AgentDefinitionResponse,
  MemoryEntryResponse,
  WorkflowDefinitionResponse,
  WorkflowPresetResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { useLiveEvents } from "../api/use-live-events.ts";

import { focusAfterPaint } from "../app/focus.ts";
import {
  effectiveAccessQueryOptions,
  libraryAgentsQueryOptions,
  libraryMemoriesQueryOptions,
  libraryRepositoriesQueryOptions,
  libraryWorkflowsQueryOptions,
  memoryQueryOptions,
  workflowPresetsQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForError,
  failureStatus,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
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
import { presetSource } from "./library/copy-workflow.ts";
import { EvaluationsTab } from "./library/EvaluationsTab.tsx";
import { SkillsTab } from "./library/SkillsTab.tsx";
import { type LibraryRow, LibraryRows } from "./library/LibraryRows.tsx";
import { ImportDialog } from "./library/ImportDialog.tsx";
import { SkillNewDialog } from "./library/SkillNewDialog.tsx";
import { MakeCopyDialog } from "./library/MakeCopyDialog.tsx";
import {
  memoryBadgeTone,
  MemoryFactProblem,
  MemoryFactSheet,
} from "./library/MemoryFactSheet.tsx";
import {
  correctionCount,
  memoryBadge,
  orderMemories,
  sourceLine,
} from "./library/memory-state.ts";
import { presetCopy } from "./task-composer-labels.ts";

/**
 * The workflows and agents Bakery uses to do work (design-ux, #66): what is
 * built in and what the organization has made, each with one badge. This
 * built-in workflows open read-only and can be copied; importing follows.
 */
export function LibraryPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const search = useSearch({ strict: false }) as {
    tab?: string;
    fact?: string;
  };
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
  const memories = useQuery({
    ...libraryMemoriesQueryOptions(api, scope),
    enabled: ready && tab === "memory",
  });
  // Repository names for the rows: one read, never one per fact.
  const repositories = useQuery({
    ...libraryRepositoriesQueryOptions(api, scope),
    enabled: ready && tab === "memory",
  });
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const canManage = access.data?.role === "admin";
  const offlineNow = useConnectivity() === "offline";
  const queryClient = useQueryClient();
  // Another person's change to a fact reaches an open Memory tab as a signal;
  // the page then reads again. A dropped connection is said out loud.
  const live = useLiveEvents(
    ready && tab === "memory" && scope.organizationId
      ? [{ type: "memory", id: scope.organizationId }]
      : [],
    () => void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  );
  const memoryStale = tab === "memory" && (offlineNow || live === "lost");
  const [copying, setCopying] = useState<WorkflowPresetResponse | null>(null);
  const [importing, setImporting] = useState(false);
  const [newSkill, setNewSkill] = useState(false);
  const importOpener = useRef<HTMLElement | null>(null);
  const openNewSkill = () => {
    importOpener.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setNewSkill(true);
  };
  const active = tab === "workflows"
    ? [workflows, presets]
    : tab === "memory"
    ? [memories]
    : [agents];
  const failure = active.find((query) => query.isError)?.error;
  const forbidden = failure !== undefined && isForbiddenFailure(failure);
  const offline = failure !== undefined && !forbidden &&
    asyncKindForError(failure) === "offline";
  const loading = !forbidden && failure === undefined &&
    active.some((query) => query.isPending);

  const listedFact = tab === "memory" && search.fact !== undefined
    ? memories.data?.items.find((entry) => entry.id === search.fact)
    : undefined;
  // A link to a fact the loaded list does not hold (the list was cut short, or
  // the fact is gone) reads that one fact, so the page never opens nothing.
  const unlisted = tab === "memory" && search.fact !== undefined &&
    memories.data !== undefined && listedFact === undefined;
  const fetchedFact = useQuery({
    ...memoryQueryOptions(api, scope, search.fact ?? ""),
    enabled: ready && unlisted,
  });
  const openFact = listedFact ?? (unlisted ? fetchedFact.data : undefined);
  const factProblem = unlisted && fetchedFact.isError
    ? [403, 404].includes(failureStatus(fetchedFact.error) ?? 0)
      ? "missing" as const
      : "failed" as const
    : null;

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
  const repositoryNames = new Map(
    (repositories.data ?? []).map((
      repository,
    ) => [repository.id, repository.name] as const),
  );
  const memoryRow = (entry: MemoryEntryResponse): LibraryRow => {
    const badge = memoryBadge(entry);
    const source = sourceLine(entry);
    const corrected = correctionCount(entry);
    const sourceText = source.kind === "available"
      ? translate("library.memory.source.available" as never, {
        name: source.name,
        version: source.revision,
      })
      : translate(`library.memory.source.${source.kind}.row` as never);
    const fact = entry.currentRevision?.body ?? entry.topic;
    const repositoryName = repositoryNames.get(entry.repositoryId);
    return {
      id: entry.id,
      name: fact,
      line: corrected > 0
        ? `${sourceText} · ${
          translate("library.memory.corrected" as never, { count: corrected })
        }`
        : sourceText,
      badge: translate(`library.memory.badge.${badge}` as never),
      tone: memoryBadgeTone(badge),
      note: repositoryName === undefined
        ? ""
        : translate("library.memory.repository" as never, {
          name: repositoryName,
        }),
      openLabel: translate("library.memory.openNamed" as never, { fact }),
      // A suggestion waits on a person: its button says so and is the primary one.
      ...(badge === "suggested"
        ? {
          openText: translate("library.memory.review" as never),
          primary: true,
        }
        : {}),
      ...(badge === "noLongerUsed" ? { muted: true } : {}),
      selected: search.fact === entry.id,
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
      href: `/library/built-in/${preset.id}`,
      ...(canManage && !offlineNow
        ? {
          copyLabel: translate("library.copy.action" as never, {
            name: copy.title,
          }),
        }
        : {}),
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
        onCopy={(row) =>
          setCopying(
            (presets.data?.items ?? []).find((item) => item.id === row.id) ??
              null,
          )}
        onNavigate={(href) => void navigate({ to: href })}
        onOpen={(row) =>
          void (tab === "memory"
            ? navigate({
              to: "/library",
              search: { tab: "memory", fact: row.id },
            })
            : tab === "agents"
            ? navigate({
              to: "/library/agents/$agentId",
              params: { agentId: row.id },
            })
            : navigate({
              to: "/library/workflows/$workflowId",
              params: { workflowId: row.id },
            }))}
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
    badgeRow(row, true)
  );
  const memoryEntries = orderMemories(memories.data?.items ?? []);
  const memoryRows = memoryEntries.map(memoryRow);
  const truncated = tab === "workflows"
    ? workflows.data?.truncated
    : tab === "memory"
    ? memories.data?.truncated
    : agents.data?.truncated;

  const content = tab === "evaluations"
    ? <EvaluationsTab />
    : tab === "skills"
    ? <SkillsTab onNewSkill={openNewSkill} offline={offlineNow} />
    : forbidden
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
        {memoryStale
          ? (
            <UI.InlineNotice tone="information" data-testid="memory-stale">
              {translate(
                (offlineNow
                  ? "library.memory.live.offline"
                  : "library.memory.live.lost") as never,
              )}
            </UI.InlineNotice>
          )
          : null}
        {tab === "memory"
          ? memoryRows.length > 0
            ? (
              <>
                <UI.Text variant="muted">
                  {translate("library.memory.intro" as never)}
                </UI.Text>
                {section(
                  "library-memory",
                  translate("library.memory.title" as never),
                  undefined,
                  memoryRows,
                  translate("library.memory.listLabel" as never),
                )}
              </>
            )
            : (
              <UI.ListSection
                data-testid="library-memory"
                flush
                title={translate("library.memory.title" as never)}
                variant={phone ? "list" : "table"}
              >
                {empty(
                  translate("library.memory.emptyTitle" as never),
                  translate("library.memory.emptyDescription" as never),
                )}
              </UI.ListSection>
            )
          : tab === "workflows"
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

  const newSkillButton = tab === "skills"
    ? (
      <UI.Inline gap="compact">
        {canManage
          ? (
            <UI.Button
              variant="secondary"
              disabled={offlineNow}
              onClick={() => void navigate({ to: "/library/skills/add" })}
            >
              {translate("library.skills.add.button")}
            </UI.Button>
          )
          : null}
        <UI.Button
          variant="primary"
          disabled={offlineNow}
          onClick={openNewSkill}
        >
          {translate("library.skills.new")}
        </UI.Button>
      </UI.Inline>
    )
    : null;
  const importButton = newSkillButton ??
    (canManage && tab === "workflows"
      ? (
        <UI.Button
          variant="secondary"
          disabled={offlineNow}
          onClick={() => {
            importOpener.current = document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
            setImporting(true);
          }}
        >
          {translate("library.workflow.import" as never)}
        </UI.Button>
      )
      : null);

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
      {importButton === null || phone
        ? null
        : <ShellSlot name="actions">{importButton}</ShellSlot>}
      <UI.SettingsContent data-testid="library-page" variant="wide">
        <UI.PageHeader
          variant="list"
          flush
          title={translate("library.title" as never)}
          subtitle={translate("library.description" as never)}
          actions={phone ? importButton : null}
        />
        <UI.Tabs
          aria-label={translate("library.tabs.label" as never)}
          variant="route"
          selectedId={tab}
          onSelect={(id) =>
            void navigate({
              to: "/library",
              search: {
                tab: id === "agents" || id === "skills" || id === "memory" ||
                    id === "evaluations"
                  ? id
                  : undefined,
              },
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
            {
              id: "skills",
              label: translate("library.tab.skills"),
              content: tab === "skills" ? content : null,
            },
            {
              id: "memory",
              label: translate("library.tab.memory" as never),
              content: tab === "memory" ? content : null,
            },
            {
              id: "evaluations",
              label: translate("library.tab.evaluations" as never),
              content: tab === "evaluations" ? content : null,
            },
          ]}
        />
      </UI.SettingsContent>
      {openFact === undefined ? null : (
        <MemoryFactSheet
          key={openFact.id}
          canManage={canManage}
          entry={openFact}
          phone={phone}
          onOpenSource={(href) => void navigate({ to: href })}
          repositoryName={repositoryNames.get(openFact.repositoryId) ?? null}
          onClose={() => {
            const id = openFact.id;
            void navigate({
              to: "/library",
              search: { tab: "memory" },
              replace: true,
            });
            // Back to the row that opened it.
            focusAfterPaint(() =>
              document.querySelector<HTMLElement>(
                `[data-library-id="${id}"] button`,
              )
            );
          }}
        />
      )}
      {factProblem === null ? null : (
        <MemoryFactProblem
          kind={factProblem}
          phone={phone}
          onClose={() =>
            void navigate({
              to: "/library",
              search: { tab: "memory" },
              replace: true,
            })}
          onRetry={() => void fetchedFact.refetch()}
        />
      )}
      {newSkill
        ? (
          <SkillNewDialog
            onClose={() => {
              setNewSkill(false);
              focusAfterPaint(() => importOpener.current);
            }}
          />
        )
        : null}
      {importing
        ? (
          <ImportDialog
            onClose={() => {
              setImporting(false);
              focusAfterPaint(() => importOpener.current);
            }}
            onMade={(workflow) => {
              setImporting(false);
              void navigate({
                to: "/library/workflows/$workflowId",
                params: { workflowId: workflow.id },
              });
            }}
          />
        )
        : null}
      {copying === null ? null : (
        <MakeCopyDialog
          source={presetSource(copying, {
            title: presetCopy(translate, copying.id).title,
            description: presetCopy(translate, copying.id).description ??
              null,
          })}
          onClose={() => setCopying(null)}
          onMade={(workflow) => {
            setCopying(null);
            void navigate({
              to: "/library/workflows/$workflowId",
              params: { workflowId: workflow.id },
            });
          }}
        />
      )}
    </>
  );
}
