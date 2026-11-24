import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { RunCreate, TaskResponse } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  approvalsQueryOptions,
  planRevisionsQueryOptions,
  workflowPresetsQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { RouterLink } from "../app/router-link.tsx";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  browserIntentStore,
  classifyFailure,
  clearIntent,
  type IntentRecord,
  loadIntent,
  runIdempotencyKey,
  saveIntent,
  startRunIntentKey,
} from "./task-composer-intent.ts";
import {
  composerLabels,
  presetCopy,
  validBudget,
} from "./task-composer-labels.ts";
import { WorkflowChoice } from "./WorkflowChoice.tsx";
import {
  approvalFor,
  latestRevision,
  planPolicy,
} from "./task-conversation/model.ts";
import {
  admissionRefusal,
  readAdmissionRefusal,
  writeAdmissionRefusal,
} from "./run-admission-refusal.ts";

type Phase =
  | "idle"
  | "submitting"
  | "unknown"
  | "conflict"
  | "forbidden"
  | "error";
type RunSubmission = Readonly<{ run: RunCreate }>;

/**
 * A draft task has no run yet. This starts the preset run with its own scoped
 * intent, so an abandoned half-submission is recovered rather than duplicated:
 * a retry after an unknown outcome replays the same key and body.
 */
export function TaskStartRun({ task }: { task: TaskResponse }) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const session = useSession();
  const cache = useQueryClient();
  const { translate: t } = useI18n();
  const setupId = useId();
  const organizationId = scope.organizationId;
  const principalId = session.identity?.principalId ?? null;
  const key = organizationId !== null && principalId !== null
    ? startRunIntentKey(organizationId, principalId, task.id)
    : null;
  const store = useMemo(() => browserIntentStore(), []);
  const [refusal, setRefusal] = useState(() =>
    key === null ? null : readAdmissionRefusal(store, key)
  );
  const record = useRef<IntentRecord<RunSubmission> | null>(
    key === null ? null : loadIntent<RunSubmission>(store, key),
  );
  const [phase, setPhase] = useState<Phase>(() =>
    record.current?.submission ? "unknown" : "idle"
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const presets = useQuery({
    ...workflowPresetsQueryOptions(api, scope, task.repositoryId),
    enabled: organizationId !== null && task.repositoryId !== null,
  });
  const [presetId, setPresetId] = useState("");
  const [budget, setBudget] = useState("");
  const [budgetTyped, setBudgetTyped] = useState(false);
  const preset = presets.data?.items.find((item) => item.id === presetId);
  const [chooseAsked, setChooseAsked] = useState(false);
  const [budgetAsked, setBudgetAsked] = useState(false);
  const setupRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const choose = (id: string) => {
    setPresetId(id);
    const picked = presets.data?.items.find((item) => item.id === id);
    if (!budgetTyped) setBudget(picked?.defaultBudgetLimitUsd ?? "");
  };
  // A task whose plan stage waits for a human starts only from the approved,
  // unconsumed approval of its newest plan revision; the server decides.
  const gated = planPolicy(task) === "human_approval";
  const plans = useQuery({
    ...planRevisionsQueryOptions(api, scope, task.id),
    enabled: organizationId !== null && gated,
  });
  const approvals = useQuery({
    ...approvalsQueryOptions(api, scope, task.id),
    enabled: organizationId !== null && gated,
  });
  const newest = latestRevision(plans.data?.items ?? []);
  const gate = newest
    ? approvalFor(newest, approvals.data?.items ?? [])
    : undefined;
  const approvalId = gated && gate?.status === "answered" &&
      gate.decision === "approve" && gate.consumedAt === null
    ? gate.id
    : undefined;
  const labels = composerLabels(t);
  const reasons = preset?.availability?.status === "setup_required"
    ? preset.availability.reasons
    : [];
  const profileId = task.repositoryProfileId;
  const blocked = reasons.length > 0 || profileId === null || !preset ||
    !validBudget(budget);

  const send = async (current: IntentRecord<RunSubmission> & RunSubmission) => {
    if (organizationId === null) return;
    setPhase("submitting");
    const result = await api.createRun({
      organizationId,
      taskId: task.id,
      idempotencyKey: runIdempotencyKey(current.intent),
      input: current.run,
    });
    if (!alive.current) return;
    if (result.ok) {
      if (key !== null) writeAdmissionRefusal(store, key, null);
      setRefusal(null);
      if (key !== null) clearIntent(store, key);
      record.current = null;
      await cache.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] === "protected" && queryKey[2] === organizationId,
      });
      return;
    }
    const failure = classifyFailure(result.error);
    if (failure === "unknown") return setPhase("unknown");
    if (key !== null) clearIntent(store, key);
    record.current = null;
    const refused = admissionRefusal(result.error);
    setRefusal(refused);
    if (key !== null) writeAdmissionRefusal(store, key, refused);
    // A refused run changes what the server says is missing; read it again so
    // the setup copy below is the server's current verdict, not a stale one.
    if (failure === "state-conflict" || failure === "conflict") {
      void presets.refetch();
    }
    setPhase(
      failure === "forbidden"
        ? "forbidden"
        : failure === "error"
        ? "error"
        : "conflict",
    );
  };

  const start = () => {
    if (preset === undefined) {
      setChooseAsked(true);
      return;
    }
    if (
      phase !== "idle" && phase !== "conflict" && phase !== "error" &&
      phase !== "forbidden"
    ) return;
    if (reasons.length > 0) {
      setupRef.current?.focus();
      return;
    }
    if (!validBudget(budget)) {
      setBudgetAsked(true);
      document.getElementById("start-run-budget")?.focus();
      return;
    }
    if (profileId === null) {
      profileRef.current?.focus();
      return;
    }
    if (key === null || blocked) return;
    const run: RunCreate = {
      presetId: preset.id,
      repositoryProfileId: profileId,
      executionMode: "repository",
      budgetLimitUsd: budget.trim(),
      ...(approvalId === undefined ? {} : { approvalId }),
    };
    // The next Start run clears what the last refusal said.
    setRefusal(null);
    const fresh = loadIntent<RunSubmission>(store, key);
    const next = { intent: fresh.intent, submission: { run }, run };
    record.current = { intent: next.intent, submission: next.submission };
    saveIntent(store, key, record.current);
    void send(next);
  };

  const retry = () => {
    const current = record.current;
    if (current?.submission) {
      return void send({ ...current, run: current.submission.run });
    }
    start();
  };

  // A refusal the server explained in plain terms, shown as the words it chose.
  const explained = refusal?.reason === "source_policy_changed" ||
      refusal?.reason === "requirements_changed"
    ? refusal.reason
    : null;
  // An approval that ran out of time is the one action's turn: the plan panel's
  // Approve again. While it is expired this section is not drawn at all, because
  // every press would be refused, and it comes back the moment the approval is
  // live again. A press that beat the refresh keeps its sentence, so the person
  // sees why the run did not start.
  const expiredRace = refusal?.reason === "approval_expired";
  if (gated && gate?.status === "expired") {
    return expiredRace
      ? (
        <UI.Stack data-ui-region="start-run" gap="compact">
          <UI.InlineNotice role="none" tone="warning">
            {t("tasks.startRun.refused.approvalExpired")}
          </UI.InlineNotice>
        </UI.Stack>
      )
      : null;
  }
  if (presets.data !== undefined && presets.data.items.length === 0) {
    return null;
  }
  // The stored race sentence belongs to the expired approval it named.
  const shown = expiredRace ? null : refusal;
  const notice = expiredRace
    ? {
      tone: "warning" as const,
      text: t("tasks.startRun.refused.approvalExpired"),
    }
    : phase === "unknown"
    ? { tone: "warning" as const, text: t("tasks.startRun.unknown") }
    : phase === "conflict"
    // A stored refusal renders its own notice below; show one.
    ? (shown
      ? null
      : { tone: "error" as const, text: t("tasks.startRun.conflict") })
    : phase === "forbidden"
    ? { tone: "error" as const, text: t("tasks.startRun.forbidden") }
    : phase === "error"
    ? { tone: "error" as const, text: t("tasks.startRun.error") }
    : profileId === null
    ? { tone: "information" as const, text: t("tasks.startRun.noProfile") }
    : null;
  return (
    <UI.Stack data-ui-region="start-run" gap="compact">
      <UI.Heading level="section">{t("tasks.startRun.heading")}</UI.Heading>
      <UI.Text>{t("tasks.startRun.empty")}</UI.Text>
      <WorkflowChoice
        disabled={phase === "submitting"}
        error={chooseAsked && preset === undefined
          ? t("tasks.startRun.chooseFirst")
          : undefined}
        id="start-run-preset"
        items={(presets.data?.items ?? []).map((item) => {
          const words = presetCopy(t, item.id);
          return {
            id: item.id,
            title: words.title,
            ...(words.description === undefined
              ? {}
              : { description: words.description }),
          };
        })}
        label={labels.preset}
        onChange={choose}
        placeholder={t("tasks.startRun.choose")}
        value={presetId}
      />
      {preset && (
        <UI.Field
          error={budgetAsked && !validBudget(budget)
            ? t("tasks.startRun.budgetInvalid")
            : undefined}
          hint={labels.budgetHint}
          htmlFor="start-run-budget"
          label={labels.budget}
        >
          <UI.TextInput
            autoComplete="off"
            id="start-run-budget"
            inputMode="decimal"
            name="budget"
            onChange={(value) => {
              setBudgetTyped(true);
              setBudget(value);
            }}
            readOnly={phase === "submitting"}
            type="text"
            value={budget}
          />
        </UI.Field>
      )}
      <div aria-atomic="true" aria-live="polite" role="status">
        {notice && (
          <UI.InlineNotice
            ref={profileRef}
            role="none"
            tabIndex={-1}
            tone={notice.tone}
          >
            {notice.text}
          </UI.InlineNotice>
        )}
        {shown !== null && explained && (
          <UI.InlineNotice role="none" tone="warning">
            <UI.Stack gap="compact">
              <UI.Text>
                {t(
                  explained === "source_policy_changed"
                    ? "tasks.startRun.refused.sourcePolicyChanged"
                    : "tasks.startRun.refused.requirementsChanged",
                )}
              </UI.Text>
              {explained === "source_policy_changed" &&
                task.repositoryId !== null && (
                <RouterLink
                  params={{ repositoryId: task.repositoryId }}
                  to="/projects/repositories/$repositoryId/rules"
                >
                  {t("tasks.run.rules.open")}
                </RouterLink>
              )}
            </UI.Stack>
          </UI.InlineNotice>
        )}
        {shown !== null && !explained && (
          <UI.InlineNotice role="none" tone="error">
            {labels.setupRequired[
              shown.code as keyof typeof labels.setupRequired
            ] ?? labels.setupRequired[
              shown.title as keyof typeof labels.setupRequired
            ] ?? (
              <>
                {t("tasks.startRun.conflict")}
                {shown.title || shown.code
                  ? ` ${shown.title || shown.code}`
                  : null}
              </>
            )}
          </UI.InlineNotice>
        )}
      </div>
      {gated && approvalId === undefined && (
        <UI.Text variant="hint">
          {t("tasks.startRun.needsApproval")}
        </UI.Text>
      )}
      {reasons.length > 0 && (
        <UI.InlineNotice
          id={setupId}
          ref={setupRef}
          role="none"
          tabIndex={-1}
          tone="warning"
        >
          <UI.Stack gap="compact">
            <UI.Text>{labels.setupHeading}</UI.Text>
            {reasons.map((reason) => (
              <UI.Text key={reason}>
                {labels.setupRequired[reason] ?? labels.setupUnknown}
              </UI.Text>
            ))}
          </UI.Stack>
        </UI.InlineNotice>
      )}
      {phase === "unknown"
        ? (
          <UI.Button onClick={retry} variant="primary">
            {t("tasks.startRun.retry")}
          </UI.Button>
        )
        : (
          <UI.Button
            aria-describedby={reasons.length > 0 ? setupId : undefined}
            disabled={phase === "submitting"}
            loading={phase === "submitting"}
            onClick={start}
            variant="primary"
          >
            {phase === "submitting"
              ? t("tasks.startRun.starting")
              : t("tasks.startRun.action")}
          </UI.Button>
        )}
    </UI.Stack>
  );
}
