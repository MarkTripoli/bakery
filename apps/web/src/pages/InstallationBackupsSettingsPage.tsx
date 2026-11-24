import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  ApiFailure,
  ApiResult,
  BackupOffsite,
  BackupOffsiteVerification,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  backupOffsiteQueryOptions,
  backupPointInTimeQueryOptions,
  backupScheduleQueryOptions,
  backupStatusQueryOptions,
} from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  BACKUPS_PATH,
  InstallationBackupsSettingsScreen,
  type SectionStatus,
  type SettingsScreenState,
  type VerifyView,
} from "../screens/InstallationBackupsSettingsScreen.tsx";
import {
  classifySaveFailure,
  type OffsiteDraft,
  offsiteDraftOf,
  offsiteInput,
  type SaveFailure,
  type ScheduleDraft,
  scheduleDraftOf,
  scheduleInput,
} from "../screens/backups/backups-settings-model.ts";
import { InstallationBreadcrumbs } from "../shell/SettingsShellSlots.tsx";
import { useRunnerKey } from "./useRunnerKey.ts";

const CLOCK_TICK_MS = 30_000;

type Write<T> = (
  options: { readonly version?: number; readonly idempotencyKey: string },
) => Promise<ApiResult<T>>;

type Settled = "saved" | "forbidden" | SaveFailure;

function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(
      () => setNow(Date.now()),
      CLOCK_TICK_MS,
    );
    return () => globalThis.clearInterval(timer);
  }, []);
  return now;
}

function failureOf(error: ApiFailure): SaveFailure {
  const problem = error.kind === "problem" ? error.problem : null;
  return classifySaveFailure({
    status: failureStatus(error),
    code: problem?.code,
    reason: problem?.reason,
    issueCodes: problem?.issueCodes,
  });
}

function useBackupSetting<T extends { readonly version: number }>(
  options: Parameters<typeof useQuery<T, ApiFailure>>[0],
) {
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const query = useQuery<T, ApiFailure>(options);
  const [status, setStatus] = useState<SectionStatus>("idle");
  const [forbidden, setForbidden] = useState(false);
  useEffect(() => {
    setStatus("idle");
    setForbidden(false);
  }, [scope.sessionGeneration]);
  const saved = query.data ?? null;
  const settle = async (write: Write<T>): Promise<Settled> => {
    if (saved === null) return "failed";
    setStatus("saving");
    const started = scope.sessionGeneration;
    const result = await write({
      ...(saved.version > 0 ? { version: saved.version } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
    if (started !== scope.sessionGeneration) return "failed";
    if (result.ok) {
      queryClient.setQueryData(options.queryKey ?? [], result.data);
      setStatus("saved");
      return "saved";
    }
    if (isForbiddenFailure(result.error)) {
      setForbidden(true);
      setStatus("idle");
      return "forbidden";
    }
    const failure = failureOf(result.error);
    setStatus(failure);
    if (failure === "stale") await query.refetch();
    return failure;
  };
  return {
    query,
    saved,
    status,
    setStatus,
    settle,
    forbidden: forbidden ||
      (query.isError && isForbiddenFailure(query.error)),
  };
}

export function InstallationBackupsSettingsPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();
  const nowMs = useNowMs();
  const connectivity = useConnectivity();
  const offline = connectivity === "offline";

  const schedule = useBackupSetting(backupScheduleQueryOptions(api, scope));
  const offsite = useBackupSetting(backupOffsiteQueryOptions(api, scope));
  const pointInTime = useBackupSetting(
    backupPointInTimeQueryOptions(api, scope),
  );
  const status = useQuery(backupStatusQueryOptions(api, scope));
  const key = useRunnerKey();

  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft | null>(
    null,
  );
  const [offsiteDraft, setOffsiteDraft] = useState<OffsiteDraft | null>(null);
  const [keysCleared, setKeysCleared] = useState(false);
  const [verify, setVerify] = useState<VerifyView>({ state: "idle" });
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [pitrTarget, setPitrTarget] = useState(true);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  useEffect(() => {
    setScheduleDraft(null);
    setOffsiteDraft(null);
    setKeysCleared(false);
    setVerify({ state: "idle" });
    setConfirmingOff(false);
    setConfirmingReplace(false);
  }, [scope.sessionGeneration]);

  const shownSchedule = scheduleDraft ??
    (schedule.saved === null ? null : scheduleDraftOf(schedule.saved));
  const shownOffsite = offsiteDraft ??
    (offsite.saved === null ? null : offsiteDraftOf(offsite.saved));

  const [, saveSchedule] = useSingleFlightSubmit(async () => {
    if (shownSchedule === null) return;
    const input = scheduleInput(shownSchedule);
    if (input === null) return;
    const outcome = await schedule.settle((options) =>
      api.backups.putSchedule({ input, ...options })
    );
    if (outcome === "saved" || outcome === "stale") setScheduleDraft(null);
  });

  const [, saveOffsite] = useSingleFlightSubmit(async () => {
    if (shownOffsite === null) return;
    const typedKeys = shownOffsite.accessKeyId !== "" ||
      shownOffsite.secretAccessKey !== "";
    const input = offsiteInput(shownOffsite);
    setOffsiteDraft({ ...shownOffsite, accessKeyId: "", secretAccessKey: "" });
    setKeysCleared(typedKeys);
    setVerify({ state: "idle" });
    const outcome = await offsite.settle((options) =>
      api.backups.putOffsite({ input, ...options })
    );
    if (outcome === "saved" || outcome === "stale") {
      setOffsiteDraft(null);
      setKeysCleared(false);
    }
  });

  const [, verifyOffsite] = useSingleFlightSubmit(async () => {
    setVerify({ state: "running" });
    offsite.setStatus("idle");
    const started = scope.sessionGeneration;
    const result = await api.backups.verifyOffsite({
      idempotencyKey: crypto.randomUUID(),
    });
    if (started !== scope.sessionGeneration) return;
    if (result.ok) {
      const done: BackupOffsiteVerification = result.data;
      setVerify({ state: "done", result: done });
      return;
    }
    if (failureOf(result.error) === "unavailable") {
      offsite.setStatus("unavailable");
      setVerify({ state: "idle" });
      return;
    }
    setVerify({ state: "failed" });
  });

  const savePointInTime = async (enabled: boolean) => {
    if (pointInTime.status === "saving") return;
    setPitrTarget(enabled);
    const outcome = await pointInTime.settle((options) =>
      api.backups.putPointInTime({ input: { enabled }, ...options })
    );
    if (outcome !== "forbidden") setConfirmingOff(false);
  };

  const forbidden = schedule.forbidden || offsite.forbidden ||
    pointInTime.forbidden ||
    (status.isError && isForbiddenFailure(status.error));
  const failedLoad = schedule.query.isError || offsite.query.isError ||
    pointInTime.query.isError || status.isError;
  const loading = schedule.query.isPending || offsite.query.isPending ||
    pointInTime.query.isPending || status.isPending;
  const state: SettingsScreenState = forbidden
    ? "notFound"
    : failedLoad
    ? "error"
    : loading
    ? "loading"
    : "ready";

  const replaceKey = () => {
    setConfirmingReplace(false);
    void key.issue();
  };

  const ready = state === "ready" && shownSchedule !== null &&
    shownOffsite !== null && schedule.saved !== null &&
    offsite.saved !== null && pointInTime.saved !== null &&
    status.data !== undefined;

  return (
    <InstallationBreadcrumbs
      leaf={translate("installation.backups.settings.page.title")}
      section="installation.backups.title"
      sectionHref={BACKUPS_PATH}
    >
      <InstallationBackupsSettingsScreen
        nowMs={nowMs}
        offline={offline}
        offsite={ready
          ? {
            saved: offsite.saved as BackupOffsite,
            draft: shownOffsite,
            status: offsite.status,
            keysCleared,
            verify,
            onChange: (field, value) => {
              setOffsiteDraft({ ...shownOffsite, [field]: value });
              setVerify({ state: "idle" });
              if (offsite.status !== "saving") offsite.setStatus("idle");
            },
            onSave: () => void saveOffsite(),
            onVerify: () => void verifyOffsite(),
            onDismiss: () => offsite.setStatus("idle"),
          }
          : null}
        onNavigate={(path) => void navigate({ to: path })}
        onRetry={() => {
          void schedule.query.refetch();
          void offsite.query.refetch();
          void pointInTime.query.refetch();
          void status.refetch();
        }}
        pointInTime={ready
          ? {
            saved: pointInTime.saved as NonNullable<typeof pointInTime.saved>,
            status: pointInTime.status,
            confirmingOff,
            lastChange: pitrTarget,
            onTurnOn: () => void savePointInTime(true),
            onAskOff: () => setConfirmingOff(true),
            onConfirmOff: () => void savePointInTime(false),
            onCancelOff: () => setConfirmingOff(false),
            onDismiss: () => pointInTime.setStatus("idle"),
          }
          : null}
        schedule={ready
          ? {
            saved: schedule.saved as NonNullable<typeof schedule.saved>,
            draft: shownSchedule,
            status: schedule.status,
            onChange: (patch) => {
              setScheduleDraft({ ...shownSchedule, ...patch });
              if (schedule.status !== "saving") schedule.setStatus("idle");
            },
            onSave: () => void saveSchedule(),
            onDismiss: () => schedule.setStatus("idle"),
          }
          : null}
        service={ready
          ? {
            status: status.data as NonNullable<typeof status.data>,
            issued: key.issued,
            runnerKey: key.runnerKey,
            confirmingReplace,
            onAskReplace: () => setConfirmingReplace(true),
            onCancelReplace: () => setConfirmingReplace(false),
            onReplace: replaceKey,
            onMake: () => void key.issue(),
            onKeyDone: key.done,
          }
          : null}
        state={state}
      />
    </InstallationBreadcrumbs>
  );
}
