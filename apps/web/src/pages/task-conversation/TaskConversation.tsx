import {
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { TaskResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  applicationQueryOptions,
  approvalsQueryOptions,
  conversationMessagesQueryOptions,
  conversationParticipantsQueryOptions,
  conversationTurnsQueryOptions,
  coordinationPlansQueryOptions,
  planRevisionsQueryOptions,
  questionsQueryOptions,
  repositoryQueryOptions,
} from "../../api/query.ts";
import { useLiveEvents } from "../../api/use-live-events.ts";
import { useConnectivity } from "../../app/connectivity.ts";
import { useShellViewport } from "../../app/responsive.ts";
import { RouterLink } from "../../app/router-link.tsx";
import { ShellFlushMain, ShellSlot } from "../../shell/shell-slots.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useSession } from "../../app/session-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { Composer } from "./Composer.tsx";
import {
  browserDraftStore,
  type Draft,
  type DraftIntent,
  draftKey,
  loadDraft,
  saveDraft,
} from "./draft.ts";
import {
  answerText,
  approvalFor,
  chronological,
  commandFailure,
  currentStage,
  latestRevision,
  participantsOf,
  planBody,
  questionOptions,
  stageWait,
} from "./model.ts";
import {
  type PlanDecision,
  type PlanPhase,
  usePlanRevision,
} from "./PlanRevisionPanel.tsx";
import { Participants } from "./Participants.tsx";
import { QuestionAnswer } from "./QuestionAnswer.tsx";
import { TASK_READS, useQuestionAnswers } from "./useQuestionAnswers.ts";
import { StageStrip } from "./StageStrip.tsx";
import { TurnStatus } from "./TurnStatus.tsx";

const POLL_MS = 3_000;
/** While the event stream is live it drives reads; polling is a slow backstop. */
const LIVE_POLL_MS = 10_000;

type Pending<Input> = { key: string; input: Input };

/**
 * The task conversation workspace: paged transcript, queued or active turn
 * status, plan revision decisions, durable questions, stage strip and the
 * private-draft composer. Every state shown here is read from the server; the
 * panel only sends the typed requests and re-reads.
 */
export function TaskConversation(
  { aside, extras, questionDefaults, references, state = "ready", task }: {
    /** More inspector content, such as the task's artifact pane. */
    aside?: ReactNode;
    /** Transcript-end content: run controls, output and artifacts. */
    extras?: ReactNode;
    /** Option preselected per question id; a design fixture supplies it. */
    questionDefaults?: Readonly<Record<string, string>>;
    /** Task reference text by id; a design fixture supplies Paper's keys. */
    references?: Readonly<Record<string, string>>;
    state?: UI.TaskDetailProps["state"];
    task: TaskResponse;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const session = useSession();
  const cache = useQueryClient();
  const { translate: t, locale } = useI18n();
  const organizationId = scope.organizationId;
  const principalId = session.identity?.principalId ?? null;
  const conversationId = task.conversationId;
  const connectivity = useConnectivity();
  const online = connectivity === "online";
  const enabled = organizationId !== null;
  const refreshRef = useRef<() => void>(() => {});
  const live = useLiveEvents(
    [{ type: "task", id: task.id }, {
      type: "conversation",
      id: conversationId,
    }],
    () => refreshRef.current(),
  );
  const poll = online ? (live === "live" ? LIVE_POLL_MS : POLL_MS) : false;

  const messages = useInfiniteQuery({
    ...conversationMessagesQueryOptions(api, scope, conversationId),
    enabled,
    refetchInterval: poll,
  });
  const turns = useQuery({
    ...conversationTurnsQueryOptions(api, scope, conversationId),
    enabled,
    refetchInterval: poll,
  });
  const plans = useQuery({
    ...planRevisionsQueryOptions(api, scope, task.id),
    enabled,
    refetchInterval: poll,
  });
  const approvals = useQuery({
    ...approvalsQueryOptions(api, scope, task.id),
    enabled,
    refetchInterval: poll,
  });
  const questions = useQuery({
    ...questionsQueryOptions(api, scope, task.id),
    enabled,
    refetchInterval: poll,
  });

  const participants = useQuery({
    ...conversationParticipantsQueryOptions(api, scope, conversationId),
    enabled,
    refetchInterval: poll,
  });
  const coordination = useQuery({
    ...coordinationPlansQueryOptions(api, scope, task.id),
    enabled,
    refetchInterval: poll,
  });

  const refresh = () =>
    cache.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === "protected" && queryKey[2] === organizationId &&
        TASK_READS.has(String(queryKey[3])),
    });
  refreshRef.current = () => void refresh();

  // ---- draft -------------------------------------------------------------
  const store = useMemo(() => browserDraftStore(), []);
  const key = organizationId !== null && principalId !== null
    ? draftKey(organizationId, principalId, task.id)
    : null;
  const [draft, setDraftState] = useState<Draft>(() =>
    key === null ? loadDraft(undefined, "") : loadDraft(store, key)
  );
  const loadedKey = useRef(key);
  useEffect(() => {
    if (key !== null && loadedKey.current !== key) {
      loadedKey.current = key;
      setDraftState(loadDraft(store, key));
    }
  }, [key, store]);
  const setDraft = (next: Draft) => {
    setDraftState(next);
    if (key !== null) saveDraft(store, key, next);
  };
  const [sendPhase, setSendPhase] = useState<
    "idle" | "sending" | "unknown" | "forbidden" | "error"
  >(draft.sendId === null ? "idle" : "unknown");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = async () => {
    if (organizationId === null || draft.body.trim() === "") return;
    const sendId = draft.sendId !== null && draft.sendBody === draft.body
      ? draft.sendId
      : crypto.randomUUID();
    const frozen: Draft = { ...draft, sendId, sendBody: draft.body };
    setDraft(frozen);
    setSendPhase("sending");
    const result = await api.createMessage({
      organizationId,
      conversationId,
      idempotencyKey: sendId,
      input: {
        body: frozen.body.trim(),
        clientMessageId: sendId,
        intent: frozen.intent === "ask" ? "agent_request" : "discussion",
      },
    });
    if (!alive.current) return;
    if (result.ok) {
      setDraft({ ...frozen, body: "", sendId: null, sendBody: null });
      setSendPhase("idle");
      void refresh();
      return;
    }
    const failure = commandFailure(result.error);
    if (failure === "unknown") return setSendPhase("unknown");
    setDraft({ ...frozen, sendId: null, sendBody: null });
    setSendPhase(failure === "forbidden" ? "forbidden" : "error");
  };

  // ---- turns -------------------------------------------------------------
  const turnItems = turns.data?.items ?? [];
  const liveTurn = turnItems.find((turn) =>
    turn.status === "queued" || turn.status === "active" ||
    turn.status === "cancel_requested"
  );
  const lastTurn = turnItems[0];
  const [canceling, setCanceling] = useState(false);
  const [cancelConflict, setCancelConflict] = useState(false);
  const cancelTurn = async () => {
    if (organizationId === null || !liveTurn) return;
    setCanceling(true);
    setCancelConflict(false);
    const result = await api.cancelConversationTurn({
      organizationId,
      turnId: liveTurn.id,
      version: liveTurn.version,
      idempotencyKey: `${liveTurn.id}:cancel:${liveTurn.version}`,
    });
    if (!alive.current) return;
    setCanceling(false);
    if (!result.ok && commandFailure(result.error) !== "unknown") {
      setCancelConflict(true);
    }
    void refresh();
  };

  // ---- plan revision -----------------------------------------------------
  const revision = latestRevision(plans.data?.items ?? []);
  const approval = revision
    ? approvalFor(revision, approvals.data?.items ?? [])
    : undefined;
  const [decision, setDecision] = useState<
    {
      revision: number;
      phase: PlanPhase;
      done: PlanDecision | null;
    } | null
  >(null);
  const [obsolete, setObsolete] = useState<number | null>(null);
  // Pending decisions are scoped to the approval id and version they were
  // sent for; another approval always gets the person's current choice and a
  // fresh idempotency key.
  const pendingDecision = useRef<
    | (Pending<{ decision: PlanDecision; comment?: string }> & {
      approvalId: string;
      version: number;
    })
    | null
  >(null);
  const decide = async (choice: PlanDecision, comment: string | undefined) => {
    if (organizationId === null || !revision || !approval) return;
    const held = pendingDecision.current;
    const reusable = held !== null && held.approvalId === approval.id &&
      held.input.decision === choice &&
      (held.input.comment ?? undefined) === (comment || undefined);
    const next = reusable ? held : {
      key: crypto.randomUUID(),
      approvalId: approval.id,
      version: approval.version,
      input: { decision: choice, ...(comment ? { comment } : {}) },
    };
    pendingDecision.current = next;
    setDecision({ revision: revision.revision, phase: "deciding", done: null });
    const result = await api.decideApproval({
      organizationId,
      approvalId: approval.id,
      idempotencyKey: next.key,
      input: { ...next.input, expectedVersion: next.version },
    });
    if (!alive.current) return;
    if (result.ok) {
      pendingDecision.current = null;
      setObsolete(null);
      // Read the approval back before the decision shows as done. The start
      // form takes its approval id from the same read, so "approved" on screen
      // never leads a start that would go out without the approval it needs.
      await refresh();
      if (!alive.current) return;
      setDecision({
        revision: revision.revision,
        phase: "idle",
        done: next.input.decision,
      });
      return;
    }
    const failure = commandFailure(result.error);
    if (failure === "unknown") {
      setDecision({
        revision: revision.revision,
        phase: "unknown",
        done: null,
      });
      // The server may have applied it; the next read settles the notice.
      void refresh();
      return;
    }
    pendingDecision.current = null;
    if (failure === "conflict") setObsolete(revision.revision);
    setDecision({
      revision: revision.revision,
      phase: failure === "conflict"
        ? "conflict"
        : failure === "forbidden"
        ? "forbidden"
        : "error",
      done: null,
    });
    void refresh();
  };
  const retryDecision = () => {
    const pending = pendingDecision.current;
    if (pending && approval && pending.approvalId === approval.id) {
      void decide(pending.input.decision, pending.input.comment);
    }
  };

  // ---- questions ---------------------------------------------------------
  const { phases: answers, answer, retry: retryAnswer } = useQuestionAnswers(
    organizationId,
    refresh,
  );

  // ---- planning only -----------------------------------------------------
  const phone = useShellViewport() === "phone";
  const [planOpen, setPlanOpen] = useState(false);
  const [planningPending, setPlanningPending] = useState<boolean | null>(null);
  const [planningFailed, setPlanningFailed] = useState(false);
  const setPlanningOnly = async (value: boolean) => {
    if (organizationId === null) return;
    setPlanningPending(value);
    setPlanningFailed(false);
    const result = await api.updateTask({
      organizationId,
      id: task.id,
      version: task.version,
      idempotencyKey: crypto.randomUUID(),
      input: { planningOnly: value },
    });
    if (!alive.current) return;
    setPlanningPending(null);
    if (!result.ok) setPlanningFailed(true);
    void refresh();
  };

  // ---- view --------------------------------------------------------------
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" })
      .format(new Date(iso));
  const failed = messages.error?.kind === "problem" &&
    messages.error.problem.status === 403;
  const transcript = chronological(messages.data?.pages ?? []);
  const loading = messages.isPending && !messages.isError;
  const hardError = messages.isError && messages.data === undefined;
  const stale = messages.isError && messages.data !== undefined;
  const sectionReads = [plans, approvals, questions];
  const sectionForbidden = sectionReads.some((read) =>
    read.error?.kind === "problem" && read.error.problem.status === 403
  );
  const sectionError = !sectionForbidden &&
    sectionReads.some((read) => read.isError);
  const stage = currentStage(
    task,
    revision,
    (questions.data?.items ?? []).some((question) =>
      question.kind !== "approval" && question.status === "open"
    ),
  );
  const openQuestions = (questions.data?.items ?? []).filter((question) =>
    question.kind !== "approval"
  ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const shownQuestions = [
    ...openQuestions.filter((question) => question.status === "open"),
    ...openQuestions.filter((question) => question.status !== "open").slice(-2),
  ];
  const runActive = task.currentRunId !== null &&
    task.status !== "completed" && task.status !== "failed" &&
    task.status !== "canceled";
  const people = participantsOf(
    transcript.map((message) =>
      message.messageType === "user" ? message.authorId : null
    ),
    participants.data?.items ?? [],
    principalId,
    (id) =>
      id === principalId
        ? t("tasks.conversation.author.you")
        : t("tasks.conversation.author.member", { id: id.slice(0, 8) }),
  );
  const nameOf = (id: string | null): string | null =>
    id === null ? null : people.find((person) => person.id === id)?.name ??
      t("tasks.conversation.author.member", { id: id.slice(0, 8) });
  const author = (message: (typeof transcript)[number]) =>
    message.messageType === "user"
      ? message.authorId === principalId
        ? t("tasks.conversation.author.you")
        : nameOf(message.authorId) ?? ""
      : message.messageType === "system"
      ? t("tasks.conversation.author.system")
      : t("tasks.conversation.author.agent");
  const variant = (message: (typeof transcript)[number]) =>
    message.messageType === "user"
      ? "person" as const
      : message.messageType === "system"
      ? "system" as const
      : "agent" as const;
  // An unknown outcome is settled once the approval reads as no longer open:
  // the recorded decision (or the next approval) shows instead of a retry.
  const unknownSettled = decision?.phase === "unknown" &&
    approval !== undefined && approval.status !== "open";
  const planPhase: PlanPhase = decision && revision &&
      decision.revision === revision.revision && !unknownSettled
    ? decision.phase
    : "idle";
  const localDecision = decision !== null && revision !== undefined &&
    decision.revision === revision.revision && decision.done !== null;
  const decided = decision && revision &&
      decision.revision === revision.revision && decision.done
    ? decision.done
    : approval?.decision ?? null;

  const obsoleteNotice = obsolete !== null && revision &&
      revision.revision > obsolete
    ? obsolete
    : null;
  const plan = usePlanRevision({
    revision: revision?.revision ?? null,
    status: revision?.status ?? "proposed",
    body: revision ? planBody(revision) : { title: "", steps: [] },
    approvalOpen: approval?.status === "open",
    obsoleteNotice,
    decided,
    decidedBy: !localDecision && approval?.decidedBy != null &&
        approval.decidedBy !== principalId
      ? nameOf(approval.decidedBy)
      : null,
    phase: planPhase,
    offline: !online,
    paused: liveTurn !== undefined,
    onDecide: (choice, comment) => void decide(choice, comment),
    onRetry: retryDecision,
    onRefresh: () => {
      setObsolete(null);
      void refresh();
    },
  });
  const conflictNotice = planPhase === "conflict" ||
    revision?.status === "superseded" || obsoleteNotice !== null;
  const application = useQuery({
    ...applicationQueryOptions(api, scope, task.applicationId),
    enabled,
  });
  const repository = useQuery({
    ...repositoryQueryOptions(api, scope, task.repositoryId ?? ""),
    enabled: enabled && task.repositoryId !== null,
  });
  const subtitle = [
    application.data?.name,
    repository.data
      ? `${repository.data.owner}/${repository.data.name}`
      : undefined,
    t("tasks.conversation.subtitle.preset"),
  ].filter((part) => part !== undefined).join(" · ");
  const reference = references?.[task.id] ?? task.id.slice(0, 8);
  const statusTone = stage === "discuss" ? "neutral" : "information";
  const coordinationLink = (coordination.data?.items.length ?? 0) > 0;
  const planCard = (
    <UI.PlanSummaryCard
      title={revision
        ? `${t("tasks.conversation.plan.heading")} · ${
          t("tasks.conversation.plan.revision", {
            revision: String(revision.revision),
          })
        }`
        : (shownQuestions[0]?.prompt ?? t("tasks.conversation.plan.heading"))}
      meta={revision
        ? t(`tasks.conversation.plan.status.${revision.status}`)
        : shownQuestions[0]
        ? t("tasks.conversation.question.status.open")
        : t("tasks.conversation.plan.none")}
      tone={revision || shownQuestions[0] ? "warning" : "neutral"}
      onClick={() => setPlanOpen(true)}
    />
  );
  const cardAnchor = revision?.createdAt ?? shownQuestions[0]?.createdAt;
  const cardAfter = cardAnchor === undefined ? -1 : transcript.reduce(
    (found, message, index) => message.createdAt <= cardAnchor ? index : found,
    transcript.length - 1,
  );
  const paneContent = (
    <>
      <Participants people={people} />
      {sectionForbidden && (
        <UI.PaneSection data-ui-region="sections-forbidden">
          <UI.InlineNotice tone="error">
            {t("tasks.conversation.sections.forbidden")}
          </UI.InlineNotice>
        </UI.PaneSection>
      )}
      {sectionError && (
        <UI.PaneSection data-ui-region="sections-error">
          <UI.InlineNotice tone="warning">
            <UI.Stack gap="compact">
              <UI.Text>{t("tasks.conversation.sections.error")}</UI.Text>
              <UI.Button
                variant="outline"
                onClick={() =>
                  void Promise.all(
                    sectionReads.map((read) => read.refetch()),
                  )}
              >
                {t("tasks.conversation.retry")}
              </UI.Button>
            </UI.Stack>
          </UI.InlineNotice>
        </UI.PaneSection>
      )}
      {shownQuestions.map((question) => (
        <UI.PaneSection key={question.id}>
          <QuestionAnswer
            id={question.id}
            prompt={question.prompt}
            status={question.status}
            options={questionOptions(question)}
            allowFreeText={question.allowFreeText ?? false}
            answered={answerText(question)}
            answeredBy={question.answeredBy != null &&
                question.answeredBy !== principalId
              ? nameOf(question.answeredBy)
              : null}
            phase={answers[question.id] ?? "idle"}
            defaultOptionId={questionDefaults?.[question.id]}
            offline={!online}
            onAnswer={(input) => void answer(question.id, input)}
            onRetry={() => retryAnswer(question.id)}
          />
        </UI.PaneSection>
      ))}
      {plan?.body}
      {!phone && aside}
    </>
  );
  return (
    <>
      <ShellFlushMain inset="page" phoneHeader="page" />
      {!phone && (
        <ShellSlot name="breadcrumbs">
          <UI.Breadcrumbs
            items={[
              {
                label: (
                  <RouterLink to="/tasks" activeOptions={{ exact: true }}>
                    {t("shell.navigation.work")}
                    <UI.VisuallyHidden>
                      {t("tasks.live.back")}
                    </UI.VisuallyHidden>
                  </RouterLink>
                ),
              },
              { label: <UI.DataText>{reference}</UI.DataText> },
            ]}
          />
        </ShellSlot>
      )}
      {!phone && (
        <ShellSlot name="actions">
          <UI.Inline gap="standard">
            <UI.StatusDot tone={statusTone}>
              {t(`tasks.conversation.status.${stage}`)}
            </UI.StatusDot>
            {coordinationLink && (
              <RouterLink
                to="/tasks/$taskId/coordination"
                params={{ taskId: task.id }}
                variant="button"
                data-ui-region="coordination-link"
              >
                {t("tasks.conversation.coordination.link")}
              </RouterLink>
            )}
          </UI.Inline>
        </ShellSlot>
      )}
      {!phone && (
        <ShellSlot name="inspector" size="medium">
          <UI.SessionPane
            label={t("tasks.conversation.plan.heading")}
            layout="sections"
            header={
              <>
                <UI.IconGlyph name="plan" />
                <UI.Text>{t("tasks.conversation.plan.heading")}</UI.Text>
                {revision && (
                  <UI.Text variant="hint">
                    {t("tasks.conversation.plan.revision", {
                      revision: String(revision.revision),
                    })}
                  </UI.Text>
                )}
              </>
            }
            footer={plan?.footer}
          >
            {paneContent}
          </UI.SessionPane>
        </ShellSlot>
      )}
      {phone && (
        <UI.Sheet
          open={planOpen}
          onOpenChange={setPlanOpen}
          title={t("tasks.conversation.plan.heading")}
          dismissLabel={t("tasks.conversation.sheet.close")}
          data-ui-region="plan-sheet"
        >
          <UI.PaneSection ruled>
            <UI.Switch
              aria-describedby="stage-planning-only-hint"
              checked={planningPending ?? task.planningOnly ?? false}
              disabled={planningPending !== null || !online}
              onChange={(event) =>
                void setPlanningOnly(event.currentTarget.checked)}
            >
              {t("tasks.conversation.stage.planningOnly")}
            </UI.Switch>
          </UI.PaneSection>
          {paneContent}
          {coordinationLink && (
            <UI.PaneSection>
              <RouterLink
                to="/tasks/$taskId/coordination"
                params={{ taskId: task.id }}
                variant="button"
                data-ui-region="coordination-link"
              >
                {t("tasks.conversation.coordination.link")}
              </RouterLink>
            </UI.PaneSection>
          )}
          {plan?.footer && (
            <UI.Inline variant="actions">{plan.footer}</UI.Inline>
          )}
        </UI.Sheet>
      )}
      <UI.TaskDetail
        layout="conversation"
        variant={phone ? "sheet" : "rail"}
        title={task.title}
        subtitle={phone
          ? <UI.DataText variant="timestamp">{reference}</UI.DataText>
          : subtitle}
        leading={phone
          ? (
            <RouterLink
              to="/tasks"
              variant="icon"
              aria-label={t("tasks.live.back")}
            >
              <UI.IconGlyph name="chevron-left" />
            </RouterLink>
          )
          : undefined}
        state={state}
        data-ui-region="task-conversation"
        aria-label={t("tasks.conversation.heading")}
        role="region"
        stages={
          <StageStrip
            compact={phone}
            people={people}
            current={stage}
            wait={(id) => stageWait(task, id)}
            planningOnly={planningPending ?? task.planningOnly ?? false}
            planningOnlyDisabled={planningPending !== null || !online}
            planningOnlyFailed={planningFailed}
            onPlanningOnly={(value) => void setPlanningOnly(value)}
          />
        }
        composer={
          <>
            {liveTurn && (
              <TurnStatus
                turn={liveTurn}
                canceling={canceling}
                cancelConflict={cancelConflict}
                offline={!online}
                onCancel={() => void cancelTurn()}
              />
            )}
            {!liveTurn && lastTurn?.status === "failed" && (
              <UI.InlineNotice layout="bar" tone="error">
                {t("tasks.conversation.turn.failed", {
                  detail: lastTurn.failure?.detail ??
                    lastTurn.failure?.title ?? "",
                })}
              </UI.InlineNotice>
            )}
            {!liveTurn && lastTurn?.status === "canceled" && (
              <UI.InlineNotice layout="bar" tone="neutral">
                {t("tasks.conversation.turn.canceled")}
              </UI.InlineNotice>
            )}
            {conflictNotice && (
              <UI.InlineNotice
                layout="bar"
                icon="refresh"
                tone="warning"
                data-ui-region="conflict"
              >
                {t("tasks.conversation.conflict")}
              </UI.InlineNotice>
            )}
            <Composer
              body={draft.body}
              intent={draft.intent}
              phase={sendPhase}
              offline={!online}
              runActive={runActive}
              resultsHint={task.status === "completed" &&
                task.currentRunId !== null}
              onBody={(body) => {
                setDraft({ ...draft, body });
                if (sendPhase === "error" || sendPhase === "forbidden") {
                  setSendPhase("idle");
                }
              }}
              onIntent={(intent: DraftIntent) => setDraft({ ...draft, intent })}
              onSend={() => void send()}
              onRetry={() => void send()}
            />
          </>
        }
      >
        {connectivity === "offline" && (
          <UI.InlineNotice tone="warning">
            {t("tasks.conversation.offline")}
          </UI.InlineNotice>
        )}
        {connectivity === "reconnecting" && (
          <UI.InlineNotice tone="warning">
            {t("tasks.conversation.reconnecting")}
          </UI.InlineNotice>
        )}
        {live === "lost" && online && (
          <UI.InlineNotice tone="warning" data-ui-region="live-lost">
            {t("tasks.conversation.live.lost")}
          </UI.InlineNotice>
        )}
        {stale && (
          <UI.InlineNotice tone="warning">
            <UI.Stack gap="compact">
              <UI.Text>{t("tasks.conversation.stale")}</UI.Text>
              <UI.Button
                variant="outline"
                onClick={() => void messages.refetch()}
              >
                {t("tasks.conversation.refresh")}
              </UI.Button>
            </UI.Stack>
          </UI.InlineNotice>
        )}
        {task.description && (
          <UI.Stack gap="compact" data-ui-region="task-brief">
            <UI.Text variant="caption">
              {t("tasks.conversation.brief")}
            </UI.Text>
            <UI.Text>{task.description}</UI.Text>
          </UI.Stack>
        )}
        {loading
          ? <UI.Text role="status">{t("tasks.conversation.loading")}</UI.Text>
          : failed
          ? (
            <UI.InlineNotice tone="error">
              {t("tasks.conversation.forbidden")}
            </UI.InlineNotice>
          )
          : hardError
          ? (
            <UI.ErrorState
              title={t("tasks.conversation.error")}
              action={
                <UI.Button onClick={() => void messages.refetch()}>
                  {t("tasks.conversation.retry")}
                </UI.Button>
              }
            />
          )
          : transcript.length === 0 && !messages.hasNextPage
          ? (
            <UI.EmptyState
              layout="centered"
              icon={<UI.IconGlyph name="chat" size="large" />}
              title={t("tasks.conversation.empty")}
            />
          )
          : (
            <UI.Stack
              gap="standard"
              role="log"
              aria-label={t("tasks.conversation.transcript")}
            >
              {messages.hasNextPage && (
                <UI.Button
                  variant="outline"
                  disabled={messages.isFetchingNextPage || !online}
                  loading={messages.isFetchingNextPage}
                  onClick={() => void messages.fetchNextPage()}
                >
                  {t("tasks.conversation.loadEarlier")}
                </UI.Button>
              )}
              {transcript.map((message, index) => (
                <Fragment key={message.id}>
                  <UI.ConversationMessage
                    author={author(message)}
                    timestamp={time(message.createdAt)}
                    variant={variant(message)}
                    data-message-id={message.id}
                  >
                    {message.body}
                  </UI.ConversationMessage>
                  {phone && index === cardAfter && planCard}
                </Fragment>
              ))}
            </UI.Stack>
          )}
        {phone && cardAfter < 0 && planCard}
        {extras}
        {phone && aside}
      </UI.TaskDetail>
    </>
  );
}
