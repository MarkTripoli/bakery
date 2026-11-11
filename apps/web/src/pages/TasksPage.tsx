import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { createLink, useNavigate } from "@tanstack/react-router";
import { isUuid } from "@bakery/contracts/contracts";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  artifactsListQueryOptions,
  questionsQueryOptions,
  taskQueryOptions,
  tasksListQueryOptions,
} from "../api/query.ts";
import type { DurableSyncConnectivity } from "../api/durable-sync.ts";
import type { TaskCursorQuery, TaskResponse } from "../api/client.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  type OrganizationScopeRestore,
  useRestoreOrganizationScope,
} from "../app/restore-organization.ts";
import { RouterLink } from "../app/router-link.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";

import { useConnectivity } from "../app/connectivity.ts";
import { useShellViewport } from "../app/responsive.ts";
import { ShellFlushMain, ShellSlot } from "../shell/shell-slots.tsx";
import { NewTaskComposer } from "./NewTaskComposer.tsx";
import { TaskArtifactPane } from "./TaskArtifactPane.tsx";
import { TaskRunSection } from "./TaskRunSection.tsx";
import { TaskRunArtifactCard } from "./TaskRunArtifactCard.tsx";
import { TaskStartRun } from "./TaskStartRun.tsx";
import { TaskSessionView } from "./task-session-view.tsx";
import { questionOptions } from "./task-conversation/model.ts";
import {
  QuestionAnswer,
  type QuestionAnswerProps,
  type QuestionPhase,
} from "./task-conversation/QuestionAnswer.tsx";
import type { QuestionOption } from "./task-conversation/model.ts";
import { useQuestionAnswers } from "./task-conversation/useQuestionAnswers.ts";
import { TaskConversation } from "./task-conversation/TaskConversation.tsx";

const ArtifactLink = createLink(UI.ArtifactPreview);
import { useTaskReadSync } from "./task-read-sync.ts";

const statuses = [
  "draft",
  "queued",
  "active",
  "waiting_input",
  "blocked",
  "completed",
  "failed",
  "canceled",
] as const;

/** Restore the same authenticated organization used by the existing composer. */
export function TasksPage(
  { composing = false, questionDefaults, references, taskId }: {
    composing?: boolean;
    /** Option preselected per question id; a design fixture supplies it. */
    questionDefaults?: Readonly<Record<string, string>>;
    /** Task reference text by id; a design fixture supplies Paper's keys. */
    references?: Readonly<Record<string, string>>;
    taskId?: string;
  },
) {
  const { translate: t } = useI18n();
  const scope = useProtectedScope();
  const scopeRestore = useRestoreOrganizationScope();
  const phone = useShellViewport() === "phone";
  const scopeKey = `${scope.sessionGeneration}:${scope.organizationId}`;
  if (composing && phone) {
    // Phones get the composer as a full page, not a panel beside the queue.
    return (
      <>
        <ShellSlot name="actions">
          <RouterLink
            to="/tasks/new"
            activeProps={{}}
            inactiveProps={{}}
            variant="primaryIcon"
            aria-label={t("tasks.queue.newTask")}
          >
            <UI.IconGlyph name="plus" size="large" />
          </RouterLink>
        </ShellSlot>
        <NewTaskComposer key={scopeKey} layout="sheet" />
      </>
    );
  }
  return taskId === undefined
    ? (
      <Inbox
        key={scopeKey}
        composer={composing ? <NewTaskComposer layout="rail" /> : undefined}
        scopeRestore={scopeRestore}
      />
    )
    : (
      <Detail
        key={`${scope.sessionGeneration}:${scope.organizationId}:${taskId}`}
        id={taskId}
        scopeRestore={scopeRestore}
        references={references}
        questionDefaults={questionDefaults}
      />
    );
}

/**
 * How a failed organization lookup reads while no organization is selected:
 * `forbidden` for a 403, `offline` when the network failed, `error` for
 * anything else, and `null` while no lookup has failed or an organization is
 * already selected (the task queries own their own failures then).
 */
function scopeFailureState(
  scope: { readonly organizationId: string | null },
  restore: OrganizationScopeRestore,
): "forbidden" | "offline" | "error" | null {
  if (scope.organizationId !== null || restore.failure === null) return null;
  const failure = restore.failure as {
    kind?: string;
    problem?: { status?: number };
  };
  if (failure.kind === "problem" && failure.problem?.status === 403) {
    return "forbidden";
  }
  return failure.kind === "network" ? "offline" : "error";
}

function useOnline() {
  return useConnectivity() === "online";
}

type TaskStatus = (typeof statuses)[number];

/** Queue group order: what needs a person first, then live, then waiting. */
const groupOrder: readonly TaskStatus[] = [
  "waiting_input",
  "blocked",
  "active",
  "queued",
  "draft",
  "failed",
  "canceled",
  "completed",
];
const viewStatuses: readonly TaskStatus[] = [
  "waiting_input",
  "active",
  "queued",
];
const stageTones: Record<TaskStatus, UI.StatusDotTone> = {
  draft: "neutral",
  queued: "neutral",
  active: "information",
  waiting_input: "warning",
  blocked: "warning",
  completed: "success",
  failed: "destructive",
  canceled: "neutral",
};

function useTaskAge() {
  const { translate: t } = useI18n();
  return (createdAt: string) => {
    const minutes = Math.max(
      0,
      Math.floor((Date.now() - Date.parse(createdAt)) / 60_000),
    );
    if (minutes < 1) return t("tasks.queue.age.now");
    if (minutes < 60) {
      return t("tasks.queue.age.minutes", { count: String(minutes) });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("tasks.queue.age.hours", { count: String(hours) });
    return t("tasks.queue.age.days", { count: String(Math.floor(hours / 24)) });
  };
}

function InboxResults(
  { composer, filters, filtersContent, layout, onStatus, scopeRestore, valid }:
    {
      composer?: ReactNode;
      scopeRestore: OrganizationScopeRestore;
      filters: TaskCursorQuery;
      filtersContent: React.ReactNode;
      layout: "rail" | "sheet";
      onStatus: (status: TaskCursorQuery["status"]) => void;
      valid: boolean;
    },
) {
  const { translate: t } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const age = useTaskAge();
  const filterKey = JSON.stringify(filters);
  const [pages, setPages] = useState<
    { key: string; values: (string | undefined)[] }
  >({ key: filterKey, values: [undefined] });
  const [selectedId, setSelectedId] = useState<string>();
  if (pages.key !== filterKey) {
    setPages({ key: filterKey, values: [undefined] });
  }
  const cursors = pages.key === filterKey ? pages.values : [undefined];
  const setCursors = (values: (string | undefined)[]) =>
    setPages({ key: filterKey, values });
  const query = useQuery({
    ...tasksListQueryOptions(api, scope, {
      ...filters,
      cursor: cursors.at(-1),
      limit: 25,
    }),
    enabled: scope.organizationId !== null && valid,
    placeholderData: (previous) => previous,
  });
  const connectivity = useConnectivity({
    refetch: valid && scope.organizationId !== null ? query.refetch : undefined,
    refetching: query.isFetching,
    dataUpdatedAt: query.dataUpdatedAt,
  });
  const forbidden = query.error?.kind === "problem" &&
    query.error.problem.status === 403;
  const cursorBusy = query.isFetching || query.isPlaceholderData ||
    query.isError || connectivity !== "online";
  const scopeFailure = scopeFailureState(scope, scopeRestore);
  const state = !valid
    ? "empty"
    : scopeFailure !== null
    ? scopeFailure
    : forbidden
    ? "forbidden"
    : query.isError
    ? "error"
    : connectivity === "offline"
    ? "offline"
    : connectivity === "reconnecting"
    ? "reconnecting"
    : query.isPending || query.isFetching
    ? "loading"
    : query.data.items.length === 0
    ? "empty"
    : "ready";
  const message = !valid
    ? t("tasks.live.invalidRepository")
    : state === "forbidden"
    ? t("tasks.live.forbidden")
    : state === "offline"
    ? t("tasks.live.offline")
    : state === "reconnecting"
    ? t("tasks.inbox.reconnecting")
    : state === "error"
    ? t("tasks.live.error")
    : state === "loading"
    ? t("tasks.inbox.loading")
    : state === "empty"
    ? t("tasks.inbox.empty")
    : null;
  const items = valid && !query.isError ? query.data?.items ?? [] : [];
  const rows = items.map((task) => ({
    id: task.id,
    status: task.status,
    reference: task.id.slice(0, 8),
    title: task.title,
    stage: {
      label: t(`tasks.queue.stage.${task.status}`),
      tone: stageTones[task.status],
    },
    age: age(task.createdAt),
  }));
  const groups = groupOrder.map((status) => ({
    id: status,
    label: t(`tasks.queue.stage.${status}`),
    rows: rows.filter((row) => row.status === status),
  })).filter((group) => group.rows.length > 0);
  // Counts are only shown when the loaded page is the whole unfiltered set.
  const complete = !filters.status && cursors.length === 1 &&
    !query.data?.nextCursor && state === "ready";
  const counted = (label: string, count: number) =>
    complete
      ? t("tasks.queue.counted", { label, count: String(count) })
      : label;
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  const pageable = !!query.data?.nextCursor || cursors.length > 1;
  const questions = useQuery({
    ...questionsQueryOptions(api, scope, selected?.id ?? "", "open"),
    enabled: layout === "rail" && selected !== undefined &&
      isUuid(selected.id) && scope.organizationId !== null,
  });
  const openQuestion = questions.data?.items.find((question) =>
    question.kind !== "approval" && question.status === "open"
  );
  const answers = useQuestionAnswers(scope.organizationId);
  return (
    <WorkQueueView
      layout={layout}
      inspector={composer}
      state={state}
      filters={filtersContent}
      groups={groups}
      selectedId={selected?.id}
      onSelect={setSelectedId}
      onOpen={(event, row) => {
        if (
          event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey
        ) return;
        event.preventDefault();
        void navigate({ to: "/tasks/$taskId", params: { taskId: row.id } });
      }}
      answers={{
        offline: connectivity !== "online",
        onAnswer: (id, answer) => void answers.answer(id, answer),
        onRetry: answers.retry,
        phases: answers.phases,
      }}
      detail={selected
        ? {
          description: items.find((task) => task.id === selected.id)
            ?.description,
          question: openQuestion
            ? {
              allowFreeText: openQuestion.allowFreeText ?? false,
              id: openQuestion.id,
              options: questionOptions(openQuestion),
              prompt: openQuestion.prompt,
              status: openQuestion.status,
            }
            : undefined,
        }
        : undefined}
      summary={complete
        ? t("tasks.queue.summary", { count: rows.length })
        : undefined}
      views={[
        {
          id: "all",
          // Wide layouts carry the total in the header summary instead.
          label: layout === "sheet"
            ? counted(t("tasks.queue.view.all"), rows.length)
            : t("tasks.queue.view.all"),
        },
        ...viewStatuses.map((status) => ({
          id: status,
          label: counted(
            t(`tasks.queue.stage.${status}`),
            rows.filter((row) => row.status === status).length,
          ),
        })),
      ]}
      selectedView={filters.status && viewStatuses.includes(filters.status)
        ? filters.status
        : "all"}
      onSelectView={(id) =>
        onStatus(viewStatuses.find((status) => status === id))}
      stateContent={message && (
        <UI.Stack gap="compact">
          <UI.Text>{message}</UI.Text>
          {(state === "error" || (scopeFailure !== null &&
            scopeFailure !== "forbidden")) && (
            <UI.Button
              onClick={scopeFailure !== null
                ? scopeRestore.retry
                : () => void query.refetch()}
            >
              {t("tasks.live.retry")}
            </UI.Button>
          )}
        </UI.Stack>
      )}
      cursorControls={pageable && (
        <UI.CursorControls
          variant="previousNext"
          state={query.isFetching ? "loading" : "ready"}
          hasNext={!cursorBusy && !!query.data?.nextCursor}
          hasPrevious={!cursorBusy && cursors.length > 1}
          onNext={() => {
            if (cursorBusy || !query.data?.nextCursor) return;
            setCursors([
              ...cursors,
              query.data.nextCursor,
            ]);
          }}
          onPrevious={() => {
            if (cursorBusy || cursors.length <= 1) return;
            setCursors(cursors.slice(0, -1));
          }}
          labels={{
            controls: t("tasks.live.controls"),
            end: t("projects.onboarding.pagination.endOfResults"),
            loadMore: t("projects.onboarding.pagination.loadMore"),
            loading: t("projects.onboarding.pagination.loading"),
            next: t("projects.onboarding.pagination.next"),
            previous: t("projects.onboarding.pagination.previous"),
            retry: t("projects.onboarding.pagination.retry"),
          }}
        />
      )}
    />
  );
}

function Detail(
  { id, questionDefaults, references, scopeRestore }: {
    id: string;
    scopeRestore: OrganizationScopeRestore;
    questionDefaults?: Readonly<Record<string, string>>;
    references?: Readonly<Record<string, string>>;
  },
) {
  const { translate: t } = useI18n();
  const viewport = useShellViewport();
  const scope = useProtectedScope();
  const api = useBakeryApi();
  const online = useOnline();
  const [syncConnectivity, setSyncConnectivity] = useState<
    DurableSyncConnectivity
  >("unknown");
  const valid = isUuid(id);
  const query = useQuery({
    ...taskQueryOptions(api, scope, id),
    enabled: valid && scope.organizationId !== null,
  });
  const scopeFailure = scopeFailureState(scope, scopeRestore);
  const forbidden = scopeFailure === "forbidden" ||
    (query.error?.kind === "problem" && query.error.problem.status === 403);
  const missing = !valid ||
    (query.error?.kind === "problem" && query.error.problem.status === 404);
  // A failed refresh keeps the last good read mounted, so the run controls
  // keep their uncertain receipt.
  const task = query.data;
  if (task && !missing && !forbidden) {
    return (
      <TaskConversation
        task={task}
        references={references}
        questionDefaults={questionDefaults}
        state={syncConnectivity === "reconnecting" ? "reconnecting" : "ready"}
        aside={task.currentRunId
          ? (
            <TaskArtifactPane
              key={task.currentRunId}
              taskId={id}
              runId={task.currentRunId}
              connectivity={syncConnectivity}
            />
          )
          : undefined}
        extras={
          <>
            {!online && (
              <UI.InlineNotice tone="warning">
                {t("tasks.live.offline")}
              </UI.InlineNotice>
            )}
            {query.isError && (
              <UI.InlineNotice
                tone="warning"
                action={
                  <UI.Button
                    variant="outline"
                    onClick={() => void query.refetch()}
                  >
                    {t("tasks.live.retry")}
                  </UI.Button>
                }
              >
                {t("tasks.detail.error")}
              </UI.InlineNotice>
            )}
            <TaskLiveReads
              task={task}
              enabled={!query.isError && valid}
              onConnectivity={setSyncConnectivity}
              artifacts={task.currentRunId
                ? <TaskArtifacts taskId={id} presentation="run" />
                : undefined}
            />
            {task.currentRunId ? null : (
              <TaskArtifacts
                taskId={id}
                hideEmpty={task.status !== "draft"}
              />
            )}
          </>
        }
      />
    );
  }
  return (
    <TaskSessionView
      layout={viewport === "phone" ? "sheet" : "rail"}
      title={t("tasks.live.detail")}
      state={forbidden
        ? "forbidden"
        : missing || query.isError || scopeFailure !== null
        ? "error"
        : query.isPending
        ? "loading"
        : "ready"}
      presence={<RouterLink to="/tasks">{t("tasks.live.back")}</RouterLink>}
      messages={[]}
    >
      {(!online || scopeFailure === "offline") && (
        <UI.InlineNotice tone="warning">
          {t("tasks.live.offline")}
        </UI.InlineNotice>
      )}
      {missing
        ? <UI.Text>{t("tasks.live.notFound")}</UI.Text>
        : forbidden
        ? <UI.Text>{t("tasks.detail.forbidden")}</UI.Text>
        : query.isError || scopeFailure !== null
        ? (
          <UI.ErrorState
            title={t("tasks.detail.error")}
            action={
              <UI.Button
                onClick={scopeFailure !== null
                  ? scopeRestore.retry
                  : () => void query.refetch()}
              >
                {t("tasks.live.retry")}
              </UI.Button>
            }
          />
        )
        : <UI.Text>{t("tasks.session.state.loading")}</UI.Text>}
    </TaskSessionView>
  );
}

function TaskLiveReads(
  { task, enabled, onConnectivity, artifacts }: {
    task: TaskResponse;
    enabled: boolean;
    onConnectivity: (connectivity: DurableSyncConnectivity) => void;
    artifacts?: ReactNode;
  },
) {
  const runId = task.currentRunId;
  const observed = useTaskReadSync(task.id, runId);
  useEffect(() => {
    onConnectivity(observed);
  }, [observed, onConnectivity]);
  return runId
    ? (
      <TaskRunSection
        key={runId}
        taskId={task.id}
        runId={runId}
        enabled={enabled}
        connectivity={observed}
        artifacts={artifacts}
      />
    )
    : enabled && task.status === "draft"
    ? <TaskStartRun key={task.id} task={task} />
    : null;
}

function Inbox(
  { composer, scopeRestore }: {
    composer?: ReactNode;
    scopeRestore: OrganizationScopeRestore;
  },
) {
  const viewport = useShellViewport();
  const layout = viewport === "phone" ? "sheet" : "rail";
  const [search, setSearch] = useState("");
  const [repository, setRepository] = useState("");
  const [status, setStatus] = useState<TaskCursorQuery["status"]>();
  const valid = repository === "" || isUuid(repository);
  const filters = {
    search: search || undefined,
    repositoryId: repository || undefined,
    status,
  };
  return (
    <InboxResults
      composer={composer}
      scopeRestore={scopeRestore}
      filters={filters}
      layout={layout}
      onStatus={setStatus}
      valid={valid}
      filtersContent={
        <WorkQueueFilters
          layout={layout}
          repository={repository}
          onRepository={setRepository}
          repositoryValid={valid}
          search={search}
          onSearch={setSearch}
          status={status}
          onStatus={setStatus}
          statuses={statuses}
        />
      }
    />
  );
}

function TaskArtifacts(
  { hideEmpty = false, taskId, presentation = "default" }: {
    /** Show nothing instead of the empty message when no artifact exists. */
    hideEmpty?: boolean;
    taskId: string;
    presentation?: "default" | "run";
  },
) {
  const { translate: t } = useI18n();
  const scope = useProtectedScope();
  const api = useBakeryApi();
  const online = useOnline();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const query = useQuery(
    artifactsListQueryOptions(api, scope, {
      taskId,
      cursor: cursors.at(-1),
      limit: 25,
    }),
  );
  const forbidden = query.error?.kind === "problem" &&
    query.error.problem.status === 403;
  if (hideEmpty && query.data?.items.length === 0 && !query.data.nextCursor) {
    return null;
  }
  return (
    <UI.Stack
      gap="compact"
      aria-label={t("tasks.live.artifacts")}
      id={presentation === "run" ? "task-run-artifacts" : undefined}
      tabIndex={presentation === "run" ? -1 : undefined}
    >
      {query.isPending
        ? <UI.Text>{t("projects.onboarding.pagination.loading")}</UI.Text>
        : query.isError
        ? (
          <UI.ErrorState
            title={t(forbidden ? "tasks.live.forbidden" : "tasks.live.error")}
            action={!forbidden && (
              <UI.Button onClick={() => void query.refetch()}>
                {t("tasks.live.retry")}
              </UI.Button>
            )}
          />
        )
        : (
          <>
            {query.data.items.length === 0 && (
              <UI.Text>{t("tasks.live.noArtifacts")}</UI.Text>
            )}
            {query.data.items.map((artifact) =>
              presentation === "run"
                ? (
                  <TaskRunArtifactCard
                    key={artifact.id}
                    taskId={taskId}
                    artifact={artifact}
                  />
                )
                : (
                  <ArtifactLink
                    key={artifact.id}
                    to="/tasks/$taskId/artifacts/$artifactId"
                    params={{ taskId, artifactId: artifact.id }}
                    title={artifact.name}
                    meta={t("tasks.session.artifactMeta", {
                      type: artifact.artifactType,
                      version: String(artifact.version),
                    })}
                  />
                )
            )}
          </>
        )}
      {(cursors.length > 1 || !!query.data?.nextCursor) && (
        <UI.CursorControls
          variant="previousNext"
          state={query.isFetching || !online ? "loading" : "ready"}
          hasPrevious={cursors.length > 1}
          hasNext={!!query.data?.nextCursor && !query.isError}
          onPrevious={() => setCursors(cursors.slice(0, -1))}
          onNext={() => {
            if (query.data?.nextCursor) {
              setCursors([
                ...cursors,
                query.data.nextCursor,
              ]);
            }
          }}
          labels={{
            controls: t("tasks.live.controls"),
            end: t("projects.onboarding.pagination.endOfResults"),
            loadMore: t("projects.onboarding.pagination.loadMore"),
            loading: t("projects.onboarding.pagination.loading"),
            next: t("projects.onboarding.pagination.next"),
            previous: t("projects.onboarding.pagination.previous"),
            retry: t("projects.onboarding.pagination.retry"),
          }}
        />
      )}
    </UI.Stack>
  );
}

// Work queue presentation, shared with the /__fixtures__/work/queue design
// fixture so the fixture renders this production view.
export type WorkQueueStage = {
  label: string;
  tone: UI.StatusDotTone;
};

export type WorkQueueTask = {
  id: string;
  reference: string;
  title: string;
  application?: string;
  harness?: string;
  stage: WorkQueueStage;
  age: string;
};

export type WorkQueueGroup = {
  id: string;
  label: string;
  rows: readonly WorkQueueTask[];
};

/**
 * Selected-task detail the inspector can show. Every field is optional: a
 * field without an authoritative source stays absent rather than invented.
 */
export type WorkQueueInspectorDetail = {
  activity?: readonly UI.RunTimelineEvent[];
  description?: string;
  model?: string;
  participants?: readonly string[];
  /** The task's open question, read from the questions API (or a fixture). */
  question?: WorkQueueQuestion;
};

/** One answerable question shown in the queue inspector. */
export type WorkQueueQuestion = {
  allowFreeText: boolean;
  id: string;
  options: readonly QuestionOption[];
  /** Option chosen before the reader picks one; a design fixture sets it. */
  defaultOptionId?: string;
  prompt: string;
  status: QuestionAnswerProps["status"];
};

/** Answer action and state the queue inspector forwards to the question. */
export type WorkQueueQuestionAnswers = {
  offline: boolean;
  onAnswer: (
    id: string,
    answer: { optionId?: string; text?: string },
  ) => void;
  onRetry: (id: string) => void;
  phases: Readonly<Record<string, QuestionPhase>>;
};

export type WorkQueueViewProps = {
  /** Answer action for the selected task's question. */
  answers?: WorkQueueQuestionAnswers;
  cursorControls?: ReactNode;
  detail?: WorkQueueInspectorDetail;
  filters?: ReactNode;
  groups: readonly WorkQueueGroup[];
  /** Replaces the selected-task inspector, e.g. with the new-task composer. */
  inspector?: ReactNode;
  layout: "rail" | "sheet";
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, row: UI.TaskQueueRow) => void;
  onSelect?: (id: string) => void;
  onSelectView?: (id: string) => void;
  selectedId?: string;
  selectedView?: string;
  state: UI.TaskInboxState;
  stateContent?: ReactNode;
  /** Worker readiness for the shell status strip, when a source exists. */
  statusStrip?: ReactNode;
  summary?: string;
  views?: readonly UI.TaskInboxView[];
};

/**
 * Lets the top-bar search button open the filter bar's search field, which
 * lives in a popover owned by the page body.
 */
const QueueSearchContext = createContext<
  { open: boolean; setOpen: (open: boolean) => void } | null
>(null);

/** Presentational Work queue shared by `/tasks` and its design fixture. */
export function WorkQueueView(
  {
    answers,
    cursorControls,
    detail,
    filters,
    groups,
    inspector,
    layout,
    onOpen,
    onSelect,
    onSelectView,
    selectedId,
    selectedView,
    state,
    stateContent,
    statusStrip,
    summary,
    views,
  }: WorkQueueViewProps,
) {
  const { translate: t } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const unknown = t("tasks.queue.unknown");
  const selected = groups.flatMap((group) => group.rows).find((row) =>
    row.id === selectedId
  );
  return (
    <QueueSearchContext.Provider
      value={{ open: searchOpen, setOpen: setSearchOpen }}
    >
      <ShellFlushMain />
      <ShellSlot name="actions">
        <UI.Inline gap="compact">
          {layout === "rail" && (
            <UI.IconButton
              aria-expanded={searchOpen}
              aria-haspopup="dialog"
              label={t("tasks.queue.search")}
              onClick={() => setSearchOpen(!searchOpen)}
            >
              <UI.IconGlyph name="search" />
            </UI.IconButton>
          )}
          <RouterLink
            to="/tasks/new"
            activeProps={{}}
            inactiveProps={{}}
            variant={layout === "sheet" ? "primaryIcon" : "primaryButton"}
            aria-label={layout === "sheet"
              ? t("tasks.queue.newTask")
              : undefined}
          >
            <UI.IconGlyph
              name="plus"
              size={layout === "sheet" ? "large" : "medium"}
            />
            {layout === "rail" && t("tasks.queue.newTask")}
          </RouterLink>
        </UI.Inline>
      </ShellSlot>
      {/* E8-0 has no worker strip on phones; readiness stays a desktop footer. */}
      {statusStrip && layout === "rail" && (
        <ShellSlot name="statusStrip">{statusStrip}</ShellSlot>
      )}
      {layout === "rail" && inspector && (
        <ShellSlot name="inspector">
          <UI.InspectorPanel label={t("tasks.composer.heading")}>
            {inspector}
          </UI.InspectorPanel>
        </ShellSlot>
      )}
      {layout === "rail" && !inspector && selected && (
        <ShellSlot name="inspector">
          <UI.InspectorPanel
            label={selected.title}
            footer={
              <WorkQueueInspectorActions detail={detail} task={selected} />
            }
          >
            <WorkQueueInspector
              answers={answers}
              detail={detail}
              task={selected}
            />
          </UI.InspectorPanel>
        </ShellSlot>
      )}
      <UI.TaskInbox
        title={t("tasks.queue.title")}
        filtersLabel={t("tasks.inbox.title")}
        filters={filters}
        state={state}
        stateContent={stateContent}
        resultSummary={layout === "rail" ? summary : undefined}
        variant={layout === "sheet" ? "sheet" : "queue"}
        views={views}
        viewsLabel={t("tasks.queue.views")}
        maxVisibleViews={layout === "sheet" ? 2 : undefined}
        moreViewsLabel={t("tasks.queue.moreViews")}
        selectedView={selectedView}
        onSelectView={onSelectView}
        cursorControls={cursorControls}
      >
        {groups.length > 0 && (
          <UI.TaskQueue
            variant={layout === "sheet" ? "list" : "table"}
            labels={{
              caption: t("tasks.queue.caption"),
              task: t("tasks.queue.column.task"),
              application: t("tasks.queue.column.application"),
              stage: t("tasks.queue.column.stage"),
              harness: t("tasks.queue.column.harness"),
              age: t("tasks.queue.column.age"),
            }}
            selectedId={selectedId}
            onOpen={onOpen}
            onPreview={(row) => onSelect?.(row.id)}
            groups={groups.map((group, index) => ({
              id: group.id,
              label: t("tasks.queue.counted", {
                label: group.label,
                count: String(group.rows.length),
              }),
              // Phones fold everything after the first two groups.
              defaultCollapsed: layout === "sheet" && index >= 2
                ? true
                : undefined,
              rows: group.rows.map((row) => ({
                id: row.id,
                reference: row.reference,
                title: row.title,
                href: `/tasks/${row.id}`,
                application: row.application ?? unknown,
                harness: row.harness ?? unknown,
                age: row.age,
                stage: (
                  <UI.StatusDot tone={row.stage.tone}>
                    {row.stage.label}
                  </UI.StatusDot>
                ),
              })),
            }))}
          />
        )}
      </UI.TaskInbox>
    </QueueSearchContext.Provider>
  );
}

function WorkQueueInspector(
  { answers, detail, task }: {
    answers?: WorkQueueQuestionAnswers;
    detail?: WorkQueueInspectorDetail;
    task: WorkQueueTask;
  },
) {
  const { translate: t } = useI18n();
  const [view, setView] = useState("activity");
  const question = detail?.question;
  return (
    <UI.TaskInspector
      title={task.title}
      reference={task.reference}
      status={
        <UI.StatusDot tone={task.stage.tone}>{task.stage.label}</UI.StatusDot>
      }
      participantsLabel={t("tasks.queue.inspector.participants")}
      participants={detail?.participants?.length
        ? detail.participants.map((name) => <UI.Avatar alt={name} key={name} />)
        : undefined}
      activity={
        <UI.Tabs
          aria-label={t("tasks.queue.inspector.activity")}
          selectedId={view}
          onSelect={setView}
          tabs={[
            {
              id: "activity",
              label: t("tasks.queue.inspector.activity"),
              content: detail?.activity?.length
                ? (
                  <UI.RunTimeline
                    events={[...detail.activity]}
                    label={t("tasks.queue.inspector.activity")}
                    variant="activity"
                  />
                )
                : <UI.Text>{t("tasks.queue.inspector.noActivity")}</UI.Text>,
            },
            {
              id: "evidence",
              label: t("tasks.queue.inspector.evidence"),
              content: <UI.Text>{t("tasks.live.noArtifacts")}</UI.Text>,
            },
          ]}
        />
      }
    >
      {question && (
        <QuestionAnswer
          key={question.id}
          id={question.id}
          layout="inline"
          prompt={question.prompt}
          status={question.status}
          options={question.options}
          allowFreeText={question.allowFreeText}
          answered=""
          defaultOptionId={question.defaultOptionId}
          phase={answers?.phases[question.id] ?? "idle"}
          offline={answers?.offline ?? false}
          onAnswer={(input) => answers?.onAnswer(question.id, input)}
          onRetry={() => answers?.onRetry(question.id)}
        />
      )}
      {detail?.description && <UI.Text>{detail.description}</UI.Text>}
    </UI.TaskInspector>
  );
}

export type WorkQueueFiltersProps = {
  layout: "rail" | "sheet";
  onRepository: (value: string) => void;
  onSearch: (value: string) => void;
  onStatus: (value: TaskStatus | undefined) => void;
  repository: string;
  repositoryValid: boolean;
  search: string;
  status: TaskStatus | undefined;
  statuses: readonly TaskStatus[];
};

/**
 * Paper filter bar: application scope and free-text search open from their
 * toolbar buttons; status is a toolbar select on wide layouts and joins the
 * search sheet on phones.
 */
export function WorkQueueFilters(
  {
    layout,
    onRepository,
    onSearch,
    onStatus,
    repository,
    repositoryValid,
    search,
    status,
    statuses,
  }: WorkQueueFiltersProps,
) {
  const { translate: t } = useI18n();
  const searchControl = useContext(QueueSearchContext);
  const statusFilter = (
    <UI.Combobox
      appearance={layout === "rail" ? "filter" : "field"}
      label={t("tasks.live.status")}
      value={status ?? ""}
      onChange={(event) =>
        onStatus(statuses.find((item) => item === event.target.value))}
      options={[
        {
          value: "",
          label: t(
            layout === "rail" ? "tasks.queue.filter.status" : "tasks.live.all",
          ),
        },
        ...statuses.map((value) => ({
          value,
          label: t(`tasks.live.status.${value}`),
        })),
      ]}
    />
  );
  return (
    <>
      <UI.Popover
        label={t("tasks.queue.filter.repository")}
        variant="interactive"
        triggerAppearance="toolbar"
        trigger={
          <>
            <UI.IconGlyph name="applications" />
            {t("tasks.queue.filter.applications")}
          </>
        }
      >
        <UI.Field
          label={t("tasks.live.repository")}
          htmlFor="tasks-repository"
          error={repositoryValid
            ? undefined
            : t("tasks.live.invalidRepository")}
        >
          <UI.TextInput
            id="tasks-repository"
            name="repository"
            type="text"
            autoComplete="off"
            value={repository}
            onChange={onRepository}
            aria-invalid={!repositoryValid || undefined}
          />
        </UI.Field>
      </UI.Popover>
      {layout === "rail" && statusFilter}
      <UI.Popover
        label={t("tasks.queue.filter.search")}
        open={searchControl?.open}
        onOpenChange={searchControl?.setOpen}
        variant="interactive"
        triggerAppearance="toolbar"
        trigger={t("tasks.queue.filter.more")}
      >
        <UI.Stack gap="compact">
          <UI.Field label={t("tasks.live.search")} htmlFor="tasks-search">
            <UI.SearchField
              id="tasks-search"
              value={search}
              maxLength={200}
              onChange={(event) => onSearch(event.target.value)}
            />
          </UI.Field>
          {layout === "sheet" && statusFilter}
        </UI.Stack>
      </UI.Popover>
    </>
  );
}

function WorkQueueInspectorActions(
  { detail, task }: { detail?: WorkQueueInspectorDetail; task: WorkQueueTask },
) {
  const { translate: t } = useI18n();
  return (
    <>
      {detail?.model && (
        <UI.Button variant="outline">
          <UI.IconGlyph name="chevron-down" />
          {t("tasks.queue.inspector.model", { model: detail.model })}
        </UI.Button>
      )}
      <RouterLink
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        variant="button"
      >
        <UI.IconGlyph name="terminal" />
        {t("tasks.queue.inspector.open")}
      </RouterLink>
    </>
  );
}
