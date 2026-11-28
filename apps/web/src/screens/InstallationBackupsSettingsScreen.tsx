import { type FormEvent, type ReactNode, useId, useState } from "react";
import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import type {
  BackupOffsite,
  BackupOffsiteVerification,
  BackupPointInTime,
  BackupSchedule,
  BackupStatus,
} from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  BACKUPS_GUIDE_HREF,
  BACKUPS_RUNNER_GUIDE_HREF,
  spanSince,
} from "./backups/backups-model.ts";
import {
  keysRequired,
  localTimeOfDay,
  type OffsiteDraft,
  offsiteProblems,
  offsiteReady,
  offsiteRequiredProblems,
  pointInTimeView,
  type SaveFailure,
  type ScheduleDraft,
  scheduleProblems,
  scheduleReady,
  VERIFY_KEYS,
} from "./backups/backups-settings-model.ts";
import {
  RunnerKeyDialog,
  type RunnerKeyView,
} from "./backups/RunnerKeyDialog.tsx";
import { useFormatters } from "./InstallationBackupsScreen.tsx";

export const BACKUPS_PATH = "/installation/backups";

export type SettingsScreenState = "loading" | "error" | "notFound" | "ready";

export type SectionStatus = "idle" | "saving" | "saved" | SaveFailure;

export type VerifyView =
  | { readonly state: "idle" }
  | { readonly state: "running" }
  | { readonly state: "failed" }
  | {
    readonly state: "done";
    readonly result: BackupOffsiteVerification;
  };

export type ScheduleSectionProps = {
  readonly saved: BackupSchedule;
  readonly draft: ScheduleDraft;
  readonly status: SectionStatus;
  readonly onChange: (patch: Partial<ScheduleDraft>) => void;
  readonly onSave: () => void;
  readonly onDismiss: () => void;
};

export type OffsiteSectionProps = {
  readonly saved: BackupOffsite;
  readonly draft: OffsiteDraft;
  readonly status: SectionStatus;
  readonly keysCleared: boolean;
  readonly verify: VerifyView;
  readonly onChange: (field: keyof OffsiteDraft, value: string) => void;
  readonly onSave: () => void;
  readonly onVerify: () => void;
  readonly onDismiss: () => void;
};

export type PointInTimeSectionProps = {
  readonly saved: BackupPointInTime;
  readonly status: SectionStatus;
  readonly confirmingOff: boolean;
  readonly lastChange: boolean;
  readonly onTurnOn: () => void;
  readonly onAskOff: () => void;
  readonly onConfirmOff: () => void;
  readonly onCancelOff: () => void;
  readonly onDismiss: () => void;
};

export type ServiceSectionProps = {
  readonly status: BackupStatus;
  readonly runnerKey: RunnerKeyView;
  readonly confirmingReplace: boolean;
  readonly onAskReplace: () => void;
  readonly onCancelReplace: () => void;
  readonly onReplace: () => void;
  readonly onMake: () => void;
  readonly onKeyDone: () => void;
};

export type InstallationBackupsSettingsScreenProps = {
  readonly state: SettingsScreenState;
  readonly offline: boolean;
  readonly nowMs: number;
  readonly schedule: ScheduleSectionProps | null;
  readonly offsite: OffsiteSectionProps | null;
  readonly pointInTime: PointInTimeSectionProps | null;
  readonly service: ServiceSectionProps | null;
  readonly onRetry: () => void;
  readonly onNavigate: (path: string) => void;
};

const SECTION_NAME: Readonly<
  Record<"schedule" | "offsite" | "pitr", MessageKey>
> = {
  schedule: "installation.backups.settings.schedule",
  offsite: "installation.backups.settings.offsite",
  pitr: "installation.backups.settings.pitr",
};

function SaveToast(
  { status, section, saved, extra, onDismiss }: {
    readonly status: SectionStatus;
    readonly section: keyof typeof SECTION_NAME;
    readonly saved: MessageKey;
    readonly extra?: ReactNode;
    readonly onDismiss: () => void;
  },
) {
  const { translate } = useI18n();
  if (status === "idle" || status === "saving") return null;
  const failure: Readonly<Record<SaveFailure, MessageKey>> = {
    stale: "installation.backups.settings.stale",
    invalid: "installation.backups.settings.invalid",
    credentialsRequired:
      "installation.backups.settings.offsite.credentialsRequired",
    unavailable: section === "offsite"
      ? "installation.backups.settings.offsite.unavailable"
      : "installation.backups.settings.failed",
    failed: "installation.backups.settings.failed",
  };
  const ok = status === "saved";
  return (
    <UI.Toast
      data-result={ok ? "saved" : status}
      onDismiss={onDismiss}
      tone={ok ? "success" : "error"}
    >
      {ok ? translate(saved) : translate(failure[status], {
        section: translate(SECTION_NAME[section]),
      })}
      {extra}
    </UI.Toast>
  );
}

export function InstallationBackupsSettingsScreen(
  props: InstallationBackupsSettingsScreenProps,
) {
  const { translate } = useI18n();
  const { state } = props;
  if (state === "notFound") {
    return (
      <UI.SettingsContent
        data-page="installation-backups-settings"
        variant="wide"
      >
        <UI.EmptyState
          align="start"
          description={translate("installation.backups.notFound.body")}
          layout="centered"
          title={translate("installation.backups.notFound.title")}
          titleStyle="heading"
          variant="filtered"
        />
      </UI.SettingsContent>
    );
  }
  return (
    <UI.SettingsContent
      data-page="installation-backups-settings"
      variant="wide"
    >
      <UI.Stack gap="standard">
        <UI.Link
          href={BACKUPS_PATH}
          onClick={(event) => {
            if (
              event.defaultPrevented || event.button !== 0 || event.metaKey ||
              event.ctrlKey || event.shiftKey || event.altKey
            ) return;
            event.preventDefault();
            props.onNavigate(BACKUPS_PATH);
          }}
          variant="internal"
        >
          {translate("installation.backups.settings.page.back")}
        </UI.Link>
        <UI.PageHeader
          description={translate(
            "installation.backups.settings.page.description",
          )}
          flush
          title={translate("installation.backups.settings.page.title")}
          variant="list"
        />
        {props.offline
          ? (
            <UI.InlineNotice data-result="offline" role="status" tone="warning">
              {translate("installation.backups.settings.offline")}
            </UI.InlineNotice>
          )
          : null}
        {state === "loading"
          ? (
            <UI.Stack
              aria-busy="true"
              aria-label={translate("installation.backups.settings.loading")}
              gap="standard"
            >
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
            </UI.Stack>
          )
          : state === "error" || props.schedule === null ||
              props.offsite === null || props.pointInTime === null ||
              props.service === null
          ? (
            <UI.InlineNotice
              action={
                <UI.Button
                  disabled={props.offline}
                  onClick={props.onRetry}
                  variant="secondary"
                >
                  {translate("core.actions.retry")}
                </UI.Button>
              }
              data-result="load-failed"
              role="alert"
              tone="error"
            >
              {translate("installation.backups.settings.error")}
            </UI.InlineNotice>
          )
          : (
            <>
              <ScheduleSection
                {...props.schedule}
                nowMs={props.nowMs}
                offline={props.offline}
              />
              <OffsiteSection {...props.offsite} offline={props.offline} />
              <PointInTimeSection
                {...props.pointInTime}
                nowMs={props.nowMs}
                offline={props.offline}
              />
              <ServiceSection
                {...props.service}
                nowMs={props.nowMs}
                offline={props.offline}
              />
            </>
          )}
      </UI.Stack>
    </UI.SettingsContent>
  );
}

function ScheduleSection(
  props: ScheduleSectionProps & {
    readonly nowMs: number;
    readonly offline: boolean;
  },
) {
  const { translate, locale, timeZone } = useI18n();
  const ids = {
    interval: useId(),
    time: useId(),
    days: useId(),
  };
  const { draft, status } = props;
  const saving = status === "saving";
  const problems = scheduleProblems(draft);
  const hourly = draft.interval === "hourly";
  const local = hourly
    ? null
    : localTimeOfDay(draft.time, props.nowMs, locale, timeZone);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || props.offline) return;
    if (scheduleReady(draft)) {
      props.onSave();
      return;
    }
    const firstInvalid = problems.time !== undefined ||
        problems.minute !== undefined
      ? ids.time
      : ids.days;
    document.getElementById(firstInvalid)?.focus();
  };
  const timeError = hourly ? problems.minute : problems.time;
  return (
    <UI.SettingsSection
      data-section="schedule"
      title={translate("installation.backups.settings.schedule")}
      variant="stack"
    >
      <form
        aria-busy={saving || undefined}
        data-form="schedule"
        noValidate
        onSubmit={submit}
      >
        <UI.Stack gap="standard">
          <UI.Switch
            checked={draft.enabled}
            data-field="schedule-enabled"
            disabled={saving || props.offline}
            onChange={(event) =>
              props.onChange({ enabled: event.target.checked })}
          >
            {translate("installation.backups.settings.schedule.enabled")}
          </UI.Switch>
          <UI.Combobox
            data-field="interval"
            disabled={saving || props.offline}
            id={ids.interval}
            label={translate("installation.backups.settings.schedule.interval")}
            onChange={(event) => {
              const interval = event.target.value as ScheduleDraft["interval"];
              props.onChange({
                interval,
                ...(hourly && interval !== "hourly" ? { time: "03:00" } : {}),
              });
            }}
            options={[
              {
                value: "hourly",
                label: translate("installation.backups.interval.hourly"),
              },
              {
                value: "daily",
                label: translate("installation.backups.interval.daily"),
              },
              {
                value: "weekly",
                label: translate("installation.backups.interval.weekly"),
              },
            ]}
            value={draft.interval}
            width="short"
          />
          <UI.Field
            error={timeError === undefined ? undefined : translate(timeError)}
            hint={local === null
              ? hourly
                ? translate(
                  "installation.backups.settings.schedule.minute.hint",
                )
                : undefined
              : translate("installation.backups.settings.schedule.local", {
                time: local,
              })}
            htmlFor={ids.time}
            label={translate(
              hourly
                ? "installation.backups.settings.schedule.minute"
                : "installation.backups.settings.schedule.time",
            )}
            width="short"
          >
            <UI.TextInput
              autoComplete="off"
              disabled={saving || props.offline}
              id={ids.time}
              inputMode="numeric"
              invalid={timeError !== undefined}
              name={hourly ? "minute" : "time"}
              onChange={(value) =>
                props.onChange(hourly ? { minute: value } : { time: value })}
              placeholder={hourly ? "0" : "03:00"}
              type="text"
              value={hourly ? draft.minute : draft.time}
            />
          </UI.Field>
          <UI.Field
            error={problems.daysToKeep === undefined
              ? undefined
              : translate(problems.daysToKeep)}
            hint={translate("installation.backups.settings.schedule.days.hint")}
            htmlFor={ids.days}
            label={translate("installation.backups.settings.schedule.days")}
            width="short"
          >
            <UI.TextInput
              autoComplete="off"
              disabled={saving || props.offline}
              id={ids.days}
              inputMode="numeric"
              invalid={problems.daysToKeep !== undefined}
              name="daysToKeep"
              onChange={(value) => props.onChange({ daysToKeep: value })}
              type="text"
              value={draft.daysToKeep}
            />
          </UI.Field>
          <UI.Inline gap="compact" variant="actions">
            <UI.Button
              data-action="save-schedule"
              disabled={props.offline}
              loading={saving}
              type="submit"
              variant="primary"
            >
              {translate(
                saving
                  ? "installation.backups.settings.schedule.saving"
                  : "installation.backups.settings.schedule.save",
              )}
            </UI.Button>
          </UI.Inline>
          <SaveToast
            onDismiss={props.onDismiss}
            saved="installation.backups.settings.saved.schedule"
            section="schedule"
            status={status}
          />
        </UI.Stack>
      </form>
    </UI.SettingsSection>
  );
}

function VerifyResult({ verify }: { readonly verify: VerifyView }) {
  const { translate, locale } = useI18n();
  if (verify.state === "idle" || verify.state === "running") return null;
  if (verify.state === "failed") {
    return (
      <UI.InlineNotice data-result="verify" role="alert" tone="error">
        {translate("installation.backups.settings.verify.failed")}
      </UI.InlineNotice>
    );
  }
  const { outcome, detail, checkedAt } = verify.result;
  if (outcome === "verified") {
    const time = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(checkedAt));
    return (
      <UI.Inline data-result="verify" data-outcome={outcome} gap="compact">
        <UI.Badge tone="success">
          {translate(VERIFY_KEYS.verified)}
        </UI.Badge>
        <UI.Text variant="caption">
          {translate("installation.backups.utc", {
            time: translate("installation.backups.settings.verify.checked", {
              time,
            }),
          })}
        </UI.Text>
      </UI.Inline>
    );
  }
  return (
    <UI.InlineNotice
      data-outcome={outcome}
      data-result="verify"
      role="status"
      tone={outcome === "not_configured" ? "information" : "error"}
    >
      <UI.Stack gap="tight">
        <span>{translate(VERIFY_KEYS[outcome])}</span>
        {outcome === "destination_refused" && detail !== null && detail !== ""
          ? <UI.DataText data-value="verify-detail">{detail}</UI.DataText>
          : null}
      </UI.Stack>
    </UI.InlineNotice>
  );
}

function OffsiteSection(
  props: OffsiteSectionProps & { readonly offline: boolean },
) {
  const { translate } = useI18n();
  const ids = {
    endpoint: useId(),
    region: useId(),
    bucket: useId(),
    prefix: useId(),
    accessKeyId: useId(),
    secretAccessKey: useId(),
  };
  const { draft, saved, status, verify } = props;
  const saving = status === "saving";
  const testing = verify.state === "running";
  const [attempted, setAttempted] = useState(false);
  const found = offsiteProblems(draft, saved);
  const problems = attempted
    ? { ...offsiteRequiredProblems(draft), ...found }
    : found;
  const ready = offsiteReady(draft, saved);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || props.offline) return;
    if (ready) {
      props.onSave();
      return;
    }
    setAttempted(true);
    const forced = { ...offsiteRequiredProblems(draft), ...found };
    const order = [
      ["endpoint", ids.endpoint],
      ["region", ids.region],
      ["bucket", ids.bucket],
      ["prefix", ids.prefix],
      [
        "keys",
        draft.accessKeyId !== "" && draft.secretAccessKey === ""
          ? ids.secretAccessKey
          : ids.accessKeyId,
      ],
    ] as const;
    const first = order.find(([field]) => forced[field] !== undefined);
    if (first !== undefined) document.getElementById(first[1])?.focus();
  };
  const keyHint = saved.configured
    ? keysRequired(draft, saved)
      ? translate("installation.backups.settings.offsite.keys.needed")
      : translate("installation.backups.settings.offsite.keys.saved")
    : translate("installation.backups.settings.offsite.keys.none");
  const keysError = problems.keys === undefined
    ? undefined
    : translate(problems.keys);
  const accessError = draft.accessKeyId === "" ? keysError : undefined;
  const secretError = draft.secretAccessKey === "" &&
      draft.accessKeyId !== ""
    ? keysError
    : undefined;
  const reveal = {
    show: translate("installation.backups.settings.offsite.keys.show"),
    hide: translate("installation.backups.settings.offsite.keys.hide"),
  };
  const text = (
    field: "endpoint" | "region" | "bucket" | "prefix",
    label: MessageKey,
    hint?: MessageKey,
  ) => {
    const problem = problems[field];
    return (
      <UI.Field
        error={problem === undefined ? undefined : translate(problem)}
        hint={hint === undefined ? undefined : translate(hint)}
        htmlFor={ids[field]}
        label={translate(label)}
        required={field !== "prefix"}
      >
        <UI.TextInput
          autoComplete="off"
          disabled={saving || props.offline}
          id={ids[field]}
          inputMode={field === "endpoint" ? "url" : "text"}
          invalid={problem !== undefined}
          name={field}
          onChange={(value) => props.onChange(field, value)}
          type="text"
          value={draft[field]}
        />
      </UI.Field>
    );
  };
  return (
    <UI.SettingsSection
      data-section="offsite"
      title={translate("installation.backups.settings.offsite")}
      variant="stack"
    >
      <form
        aria-busy={saving || undefined}
        data-form="offsite"
        noValidate
        onSubmit={submit}
      >
        <UI.Stack gap="standard">
          {text(
            "endpoint",
            "installation.backups.settings.offsite.endpoint",
            "installation.backups.settings.offsite.endpoint.hint",
          )}
          {text("region", "installation.backups.settings.offsite.region")}
          {text("bucket", "installation.backups.settings.offsite.bucket")}
          {text("prefix", "installation.backups.settings.offsite.prefix")}
          <UI.Field
            error={accessError}
            hint={keyHint}
            htmlFor={ids.accessKeyId}
            label={translate(
              "installation.backups.settings.offsite.accessKeyId",
            )}
          >
            <UI.PasswordInput
              autoComplete="new-password"
              disabled={saving || props.offline}
              id={ids.accessKeyId}
              invalid={accessError !== undefined}
              name="accessKeyId"
              onChange={(value) => props.onChange("accessKeyId", value)}
              revealLabels={reveal}
              value={draft.accessKeyId}
            />
          </UI.Field>
          <UI.Field
            error={secretError}
            hint={keyHint}
            htmlFor={ids.secretAccessKey}
            label={translate(
              "installation.backups.settings.offsite.secretAccessKey",
            )}
          >
            <UI.PasswordInput
              autoComplete="new-password"
              disabled={saving || props.offline}
              id={ids.secretAccessKey}
              invalid={secretError !== undefined}
              name="secretAccessKey"
              onChange={(value) => props.onChange("secretAccessKey", value)}
              revealLabels={reveal}
              value={draft.secretAccessKey}
            />
          </UI.Field>
          {problems.keys !== undefined && draft.accessKeyId !== "" &&
              draft.secretAccessKey !== ""
            ? (
              <UI.Text role="alert" variant="error">
                {translate(problems.keys)}
              </UI.Text>
            )
            : null}
          <UI.Inline gap="compact" variant="actions">
            <UI.Button
              data-action="save-offsite"
              disabled={props.offline || testing}
              loading={saving}
              type="submit"
              variant="primary"
            >
              {translate("installation.backups.settings.offsite.save")}
            </UI.Button>
            <UI.Button
              data-action="test-offsite"
              disabled={props.offline || saving || testing}
              loading={testing}
              onClick={props.onVerify}
              type="button"
              variant="secondary"
            >
              {translate(
                testing
                  ? "installation.backups.settings.offsite.testing"
                  : "installation.backups.settings.offsite.test",
              )}
            </UI.Button>
          </UI.Inline>
          <VerifyResult verify={verify} />
          <SaveToast
            extra={status === "unavailable"
              ? (
                <>
                  {" "}
                  <UI.Link href={BACKUPS_GUIDE_HREF} variant="external">
                    {translate("installation.backups.empty.guide")}
                  </UI.Link>
                </>
              )
              : props.keysCleared && status !== "saved"
              ? ` ${translate("installation.backups.settings.offsite.cleared")}`
              : undefined}
            onDismiss={props.onDismiss}
            saved="installation.backups.settings.saved.offsite"
            section="offsite"
            status={status}
          />
        </UI.Stack>
      </form>
    </UI.SettingsSection>
  );
}

function PointInTimeSection(
  props: PointInTimeSectionProps & {
    readonly nowMs: number;
    readonly offline: boolean;
  },
) {
  const { translate, locale } = useI18n();
  const format = useFormatters();
  const { saved, status } = props;
  const saving = status === "saving";
  const view = pointInTimeView(saved);
  const minute = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso));
  return (
    <UI.SettingsSection
      data-section="pitr"
      title={translate("installation.backups.settings.pitr")}
      variant="stack"
    >
      <UI.Stack gap="standard">
        <UI.Switch
          checked={saved.enabled}
          data-field="pitr-enabled"
          disabled={props.offline}
          onChange={(event) => {
            if (event.target.checked) props.onTurnOn();
            else props.onAskOff();
          }}
          pending={saving}
        >
          {translate("installation.backups.settings.pitr.label")}
        </UI.Switch>
        {view.kind === "window"
          ? (
            <UI.Stack data-result="pitr-window" gap="tight">
              <UI.Text>
                {translate("installation.backups.settings.pitr.window", {
                  earliest: minute(view.earliest),
                  latest: minute(view.latest),
                })}
              </UI.Text>
              <UI.Text variant="muted">
                {translate("installation.backups.settings.pitr.reported", {
                  ago: format.ago(spanSince(view.reportedAt, props.nowMs)),
                })}
              </UI.Text>
            </UI.Stack>
          )
          : view.kind === "waiting"
          ? (
            <UI.Text data-result="pitr-waiting" variant="muted">
              {translate("installation.backups.settings.pitr.pending")}
            </UI.Text>
          )
          : null}
        <SaveToast
          onDismiss={props.onDismiss}
          saved={props.lastChange
            ? "installation.backups.settings.saved.pitrOn"
            : "installation.backups.settings.saved.pitrOff"}
          section="pitr"
          status={status}
        />
      </UI.Stack>
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            data-action="pitr-cancel"
            onClick={props.onCancelOff}
            type="button"
            variant="secondary"
          >
            {translate("installation.backups.settings.pitr.confirm.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            data-action="pitr-confirm"
            loading={saving}
            onClick={props.onConfirmOff}
            type="button"
          >
            {translate("installation.backups.settings.pitr.confirm.turnOff")}
          </UI.Button>
        }
        data-dialog="pitr-off"
        onOpenChange={(open) => {
          if (!open) props.onCancelOff();
        }}
        open={props.confirmingOff}
        state={saving ? "confirming" : "open"}
        title={translate("installation.backups.settings.pitr.confirm.title")}
      >
        {translate("installation.backups.settings.pitr.confirm.body")}
      </UI.AlertDialog>
    </UI.SettingsSection>
  );
}

function ServiceSection(
  props: ServiceSectionProps & {
    readonly offline: boolean;
    readonly nowMs: number;
  },
) {
  const { translate } = useI18n();
  const format = useFormatters();
  const { status } = props;
  const configured = status.runnerConfigured;
  const lastUsed = status.runnerLastUsedAt;
  const issuing = props.runnerKey.phase === "issuing";
  return (
    <UI.SettingsSection
      data-section="service"
      title={translate("installation.backups.service.title")}
      variant="stack"
    >
      <UI.DescriptionList labels="quiet">
        <UI.DescriptionItem
          data-fact="key"
          description={!configured
            ? translate("installation.backups.settings.service.none")
            : lastUsed === null
            ? (
              <>
                {translate(
                  "installation.backups.settings.service.madeNotUsed.lead",
                )}
                <UI.Link href={BACKUPS_RUNNER_GUIDE_HREF} variant="external">
                  {translate(
                    "installation.backups.settings.service.madeNotUsed.guide",
                  )}
                </UI.Link>
                {translate(
                  "installation.backups.settings.service.madeNotUsed.tail",
                )}
              </>
            )
            : translate("installation.backups.settings.service.inUse", {
              ago: format.ago(spanSince(lastUsed, props.nowMs)),
            })}
          title={translate("installation.backups.settings.service.key")}
        />
      </UI.DescriptionList>
      {props.runnerKey.phase === "failed"
        ? (
          <UI.InlineNotice data-result="key-failed" role="alert" tone="error">
            {translate("installation.backups.key.failed")}
          </UI.InlineNotice>
        )
        : null}
      <UI.Inline gap="compact" variant="actions">
        {configured
          ? (
            <UI.Button
              data-action="replace-key"
              disabled={props.offline || issuing}
              onClick={props.onAskReplace}
              type="button"
              variant="secondary"
            >
              {translate("installation.backups.settings.service.replace")}
            </UI.Button>
          )
          : (
            <UI.Button
              data-action="make-key"
              disabled={props.offline || issuing}
              loading={issuing}
              onClick={props.onMake}
              type="button"
              variant="secondary"
            >
              {translate("installation.backups.empty.makeKey")}
            </UI.Button>
          )}
      </UI.Inline>
      <UI.AlertDialog
        cancelAction={
          <UI.Button
            data-action="replace-cancel"
            onClick={props.onCancelReplace}
            type="button"
            variant="secondary"
          >
            {translate("installation.backups.settings.service.replace.cancel")}
          </UI.Button>
        }
        confirmAction={
          <UI.Button
            data-action="replace-confirm"
            onClick={props.onReplace}
            type="button"
          >
            {translate("installation.backups.settings.service.replace.confirm")}
          </UI.Button>
        }
        data-dialog="replace-key"
        onOpenChange={(open) => {
          if (!open) props.onCancelReplace();
        }}
        open={props.confirmingReplace}
        title={translate("installation.backups.settings.service.replace.title")}
        variant="security"
      >
        {translate("installation.backups.settings.service.replace.body")}
      </UI.AlertDialog>
      <RunnerKeyDialog onDone={props.onKeyDone} runnerKey={props.runnerKey} />
    </UI.SettingsSection>
  );
}
