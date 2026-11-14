import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { RunCreate, TaskCreate } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  repositoriesListQueryOptions,
  workflowPresetsQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  browserIntentStore,
  classifyFailure,
  clearIntent,
  composerIntentKey,
  type ComposerSubmission,
  type IntentRecord,
  loadIntent,
  runIdempotencyKey,
  saveIntent,
  startRunIntentKey,
  taskIdempotencyKey,
} from "./task-composer-intent.ts";
import {
  composerLabels,
  composerSetupReasons,
  presetCopy,
  validBudget,
} from "./task-composer-labels.ts";
import {
  admissionRefusal,
  writeAdmissionRefusal,
} from "./run-admission-refusal.ts";

type Values = UI.TaskComposerValues;

const EMPTY: Values = {
  repositoryId: "",
  presetId: "",
  title: "",
  taskType: "feature",
  description: "",
  budget: "",
};

/** The form as it was when the frozen submission was sent. */
function valuesFrom(submission: ComposerSubmission): Values {
  return {
    repositoryId: submission.task.repositoryId ?? "",
    presetId: submission.run?.presetId ?? "",
    title: submission.task.title,
    taskType: submission.task.taskType,
    description: submission.task.description ?? "",
    budget: submission.run?.budgetLimitUsd ?? "",
  };
}

/** Browser connectivity, plus a flag raised from `online` until `onBack` settles. */
function useOnlineStatus(onBack: () => Promise<unknown>) {
  const [online, setOnline] = useState(() =>
    globalThis.navigator?.onLine !== false
  );
  const [recovering, setRecovering] = useState(false);
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    let live = true;
    const connected = () => {
      setOnline(true);
      setRecovering(true);
      void back.current().finally(() => live && setRecovering(false));
    };
    const disconnected = () => {
      setOnline(false);
      setRecovering(false);
    };
    globalThis.addEventListener("online", connected);
    globalThis.addEventListener("offline", disconnected);
    return () => {
      live = false;
      globalThis.removeEventListener("online", connected);
      globalThis.removeEventListener("offline", disconnected);
    };
  }, []);
  return { online, recovering };
}

/**
 * The new-task composer. It owns the requests: one scoped submission intent,
 * `tasks.create` then `runs.create` with the preset, and a locked form with a
 * same-key retry whenever the server's outcome is unknown.
 */
export function NewTaskComposer(
  { layout }: { layout: "rail" | "sheet" },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const session = useSession();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const { translate: t, locale } = useI18n();
  const organizationId = scope.organizationId;
  const principalId = session.identity?.principalId ?? null;
  const intentKey = organizationId !== null && principalId !== null
    ? composerIntentKey(organizationId, principalId)
    : null;
  const store = useMemo(() => browserIntentStore(), []);
  const initial = useMemo(
    () =>
      intentKey === null
        ? null
        : loadIntent<ComposerSubmission>(store, intentKey),
    [intentKey, store],
  );
  const record = useRef<IntentRecord<ComposerSubmission> | null>(initial);
  const [values, setValues] = useState<Values>(() =>
    initial?.submission ? valuesFrom(initial.submission) : EMPTY
  );
  const [phase, setPhase] = useState<UI.TaskComposerSubmitState>(() =>
    initial?.submission ? "unknown" : "idle"
  );
  const [planFirst, setPlanFirst] = useState(
    () => initial?.submission?.run === null,
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const repositories = useQuery({
    ...repositoriesListQueryOptions(api, scope, { limit: 100 }),
    enabled: organizationId !== null,
  });
  const presets = useQuery({
    ...workflowPresetsQueryOptions(api, scope, values.repositoryId || null),
    enabled: organizationId !== null,
    placeholderData: (previous) => previous,
  });
  const { online, recovering } = useOnlineStatus(() =>
    Promise.all([repositories.refetch(), presets.refetch()])
  );
  const repository = repositories.data?.items.find((item) =>
    item.id === values.repositoryId
  );
  const preset = presets.data?.items.find((item) =>
    item.id === values.presetId
  );
  useEffect(() => {
    const first = presets.data?.items[0];
    if (!first || (values.presetId !== "" && preset)) return;
    setValues((current) => ({
      ...current,
      presetId: first.id,
      budget: current.budget === ""
        ? first.defaultBudgetLimitUsd
        : current.budget,
    }));
  }, [preset, presets.data, values.presetId]);

  const minimumBudget = preset?.availability?.minimumBudgetLimitUsd ?? null;
  const labels = composerLabels(
    t,
    minimumBudget !== null && Number.isFinite(Number(minimumBudget))
      ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD" })
        .format(Number(minimumBudget))
      : minimumBudget,
  );
  const setupReasons = !planFirst && repository && preset?.availability
    ? composerSetupReasons(
      preset.availability.reasons,
      values.budget,
      preset.availability.minimumBudgetLimitUsd ?? null,
    )
    : [];
  const failed = repositories.isError || presets.isError;
  const view: UI.TaskComposerView = failed ? "ready" : repositories.isPending ||
      (presets.isPending && presets.data === undefined)
    ? "loading"
    : repositories.data?.items.length === 0
    ? "empty"
    : !online && phase === "idle"
    ? "offline"
    : recovering && phase === "idle"
    ? "reconnecting"
    : "ready";

  const send = async (
    current: IntentRecord<ComposerSubmission> & {
      submission: ComposerSubmission;
    },
  ) => {
    if (organizationId === null) return;
    setPhase("submitting");
    const created = await api.createTask({
      organizationId,
      idempotencyKey: taskIdempotencyKey(current.intent),
      input: current.submission.task,
    });
    if (!alive.current) return;
    if (!created.ok) {
      const failure = classifyFailure(created.error);
      if (failure === "unknown") return setPhase("unknown");
      if (intentKey !== null) clearIntent(store, intentKey);
      record.current = null;
      return setPhase(
        failure === "forbidden"
          ? "forbidden"
          : failure === "error"
          ? "error"
          : "conflict",
      );
    }
    const taskId = created.data.id;
    // "Plan first" stops here: the plan is approved in the conversation and
    // the run starts from the task afterwards.
    const started = current.submission.run === null
      ? null
      : await api.createRun({
        organizationId,
        taskId,
        idempotencyKey: runIdempotencyKey(current.intent),
        input: current.submission.run,
      });
    if (!alive.current) return;
    if (
      started && !started.ok && classifyFailure(started.error) === "unknown"
    ) {
      return setPhase("unknown");
    }
    // Keep the observed refusal on the draft detail, including after reload.
    if (started && !started.ok && principalId !== null) {
      writeAdmissionRefusal(
        store,
        startRunIntentKey(organizationId, principalId, taskId),
        admissionRefusal(started.error),
      );
    }
    if (intentKey !== null) clearIntent(store, intentKey);
    record.current = null;
    await cache.invalidateQueries({
      predicate: ({ queryKey: key }) =>
        key[0] === "protected" &&
        (key[3] === "tasks.list" || key[3] === "workflowPresets.list"),
    });
    if (!alive.current) return;
    await navigate({ to: "/tasks/$taskId", params: { taskId } });
  };

  const submit = () => {
    if (
      organizationId === null || intentKey === null ||
      repository === undefined ||
      (!planFirst && preset === undefined)
    ) {
      return setPhase("error");
    }
    const profileId = repository.activeProfileId;
    if (
      (!planFirst && (profileId === null || !validBudget(values.budget)))
    ) {
      return setPhase("error");
    }
    const task: TaskCreate = {
      applicationId: repository.applicationId,
      repositoryId: repository.id,
      ...(profileId === null ? {} : { repositoryProfileId: profileId }),
      taskType: values.taskType,
      title: values.title.trim(),
      description: values.description,
      ...(planFirst ? { approvalPolicy: { plan: "human_approval" } } : {}),
    };
    const run: RunCreate | null = planFirst || preset === undefined ||
        profileId === null
      ? null
      : {
        presetId: preset.id,
        repositoryProfileId: profileId,
        executionMode: "repository",
        budgetLimitUsd: values.budget.trim(),
      };
    const fresh = loadIntent<ComposerSubmission>(store, intentKey);
    const next = {
      intent: fresh.intent,
      submission: { task, run } satisfies ComposerSubmission,
    };
    record.current = next;
    saveIntent(store, intentKey, next);
    void send(next);
  };

  const retry = () => {
    const current = record.current;
    // A frozen submission replays with its own keys and bodies; after a
    // definitive error there is none, and the current fields start afresh.
    if (current?.submission) {
      return void send({ ...current, submission: current.submission });
    }
    submit();
  };

  const discard = () => {
    if (intentKey !== null) clearIntent(store, intentKey);
    record.current = null;
    void navigate({ to: "/tasks" });
  };

  if (failed) {
    return (
      <UI.ErrorState
        title={t("tasks.live.error")}
        variant={layout === "sheet" ? "page" : "region"}
        action={
          <UI.Button
            onClick={() => {
              void repositories.refetch();
              void presets.refetch();
            }}
          >
            {t("tasks.live.retry")}
          </UI.Button>
        }
      />
    );
  }
  return (
    <UI.TaskComposerForm
      headingLevel={layout === "sheet" ? 1 : 2}
      labels={labels}
      onChange={(field, value) =>
        setValues((current) => ({ ...current, [field]: value }))}
      onDiscard={discard}
      onRetry={retry}
      onSubmit={submit}
      planFirst={{
        label: t("tasks.composer.planFirst"),
        hint: t("tasks.composer.planFirstHint"),
        submit: t("tasks.composer.submitPlan"),
        checked: planFirst,
        onChange: setPlanFirst,
      }}
      presets={(presets.data?.items ?? []).map((item) => {
        const copy = presetCopy(t, item.id);
        return {
          id: item.id,
          title: copy.title,
          description: copy.description,
        };
      })}
      repositories={(repositories.data?.items ?? []).map((item) => ({
        id: item.id,
        label: `${item.owner}/${item.name}`,
      }))}
      setupReasons={setupReasons}
      submitState={phase}
      values={values}
      view={view}
    />
  );
}
