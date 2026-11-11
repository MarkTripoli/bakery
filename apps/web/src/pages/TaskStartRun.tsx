import { useEffect, useMemo, useRef, useState } from "react";
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
import { composerLabels, presetCopy } from "./task-composer-labels.ts";
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
  const preset = presets.data?.items[0];
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
  const blocked = reasons.length > 0 || profileId === null || !preset;

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
    if (
      key === null || !preset || profileId === null || blocked ||
      (phase !== "idle" && phase !== "conflict" && phase !== "error" &&
        phase !== "forbidden")
    ) return;
    const run: RunCreate = {
      presetId: preset.id,
      repositoryProfileId: profileId,
      executionMode: "repository",
      budgetLimitUsd: preset.defaultBudgetLimitUsd,
      ...(approvalId === undefined ? {} : { approvalId }),
    };
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

  const copy = preset ? presetCopy(t, preset.id) : null;
  const notice = phase === "unknown"
    ? { tone: "warning" as const, text: t("tasks.startRun.unknown") }
    : phase === "conflict"
    // A stored refusal renders its own notice below; show one.
    ? (refusal
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
      <UI.Text>{t("tasks.session.state.empty")}</UI.Text>
      {copy && (
        <UI.Text variant="caption">
          {t("tasks.composer.preset")}: {copy.title}
        </UI.Text>
      )}
      <div aria-atomic="true" aria-live="polite" role="status">
        {notice && (
          <UI.InlineNotice role="none" tone={notice.tone}>
            {notice.text}
          </UI.InlineNotice>
        )}
        {refusal && (
          <UI.InlineNotice role="none" tone="error">
            {labels.setupRequired[
              refusal.code as keyof typeof labels.setupRequired
            ] ?? labels.setupRequired[
              refusal.title as keyof typeof labels.setupRequired
            ] ?? (
              <>
                {t("tasks.startRun.conflict")}
                {refusal.title || refusal.code
                  ? ` ${refusal.title || refusal.code}`
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
        <UI.InlineNotice role="none" tone="warning">
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
            disabled={blocked || phase === "submitting"}
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
