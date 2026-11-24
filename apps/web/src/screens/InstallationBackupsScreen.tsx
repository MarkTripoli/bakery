import { type MouseEvent, type ReactNode } from "react";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type {
  BackupDrill,
  BackupOffsite,
  BackupPointInTime,
  BackupRun,
  BackupSchedule,
  BackupStatus,
} from "../api/client.ts";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ShellSlot } from "../shell/shell-slots.tsx";
import {
  RunnerKeyDialog,
  type RunnerKeyView,
} from "./backups/RunnerKeyDialog.tsx";
import {
  backupNotice,
  BACKUPS_DRILL_GUIDE_HREF,
  BACKUPS_RESTORE_GUIDE_HREF,
  BACKUPS_RUNNER_GUIDE_HREF,
  drillResult,
  isBackingUp,
  isQuiet,
  keptInKey,
  nextBackup,
  type Notice,
  offsiteWords,
  type Phrase,
  pointInTimeWords,
  restoreCheckFact,
  runResult,
  scheduleWords,
  type SettingsWord,
  sizeOf,
  type Span,
  spanOfSeconds,
  spanSince,
  startedByKey,
  takenAt,
} from "./backups/backups-model.ts";

const DETAIL_SEPARATOR = " \u00b7 ";

export const BACKUPS_SETTINGS_PATH = "/installation/backups/settings";
export const BACKUPS_RESTORE_PATH = "/installation/restore";

export type BackupsScreenState = "loading" | "error" | "notFound" | "ready";

export type BackupsListState = {
  readonly state: "loading" | "error" | "ready";
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
};

export type InstallationBackupsScreenProps = {
  readonly state: BackupsScreenState;
  readonly nowMs: number;
  readonly status: BackupStatus | null;
  readonly runs: BackupsListState & { readonly rows: readonly BackupRun[] };
  readonly drills: BackupsListState & { readonly rows: readonly BackupDrill[] };
  readonly schedule: BackupSchedule | null;
  readonly offsite: BackupOffsite | null;
  readonly pointInTime: BackupPointInTime | null;
  readonly restoreHeld: boolean;
  readonly starting: boolean;
  readonly startFailed: boolean;
  readonly runnerKey: RunnerKeyView;
  readonly onRetry: () => void;
  readonly onRetryRuns: () => void;
  readonly onRetryDrills: () => void;
  readonly onMoreRuns: () => void;
  readonly onMoreDrills: () => void;
  readonly onStart: () => void;
  readonly onMakeKey: () => void;
  readonly onKeyDone: () => void;
  readonly onNavigate: (path: string) => void;
};

type Formatters = {
  readonly utc: (iso: string) => string;
  readonly local: (iso: string) => string | null;
  readonly span: (span: Span) => string;
  readonly ago: (span: Span) => string;
  readonly size: (sizeBytes: string | null) => string;
  readonly phrase: (phrase: Phrase) => string;
  readonly word: (word: SettingsWord) => string;
};

export function useFormatters(): Formatters {
  const { translate, locale, timeZone } = useI18n();
  const utcFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const localFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const utc = (iso: string) =>
    translate("installation.backups.utc", {
      time: utcFormat.format(new Date(iso)),
    });
  const local = (iso: string) => {
    const shown = localFormat.format(new Date(iso));
    return shown === utcFormat.format(new Date(iso))
      ? null
      : translate("installation.backups.local", { time: shown });
  };
  const span = (value: Span) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: value.unit,
      unitDisplay: "long",
    }).format(value.value);
  const ago = (value: Span) =>
    translate("installation.backups.ago", { span: span(value) });
  const size = (sizeBytes: string | null) => {
    const parts = sizeOf(sizeBytes);
    if (parts === null) return "—";
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: parts.unit,
      unitDisplay: "short",
      maximumFractionDigits: parts.unit === "byte" ? 0 : 1,
    }).format(parts.value);
  };
  const phrase = (value: Phrase): string => {
    const { values } = value;
    return translate(value.key, {
      ...(values.ago === undefined ? {} : { ago: ago(values.ago) }),
      ...(values.age === undefined ? {} : { age: span(values.age) }),
      ...(values.time === undefined ? {} : { time: utc(values.time) }),
      ...(values.percent === undefined ? {} : { percent: values.percent }),
      ...(values.cause === undefined ? {} : { cause: translate(values.cause) }),
      ...(values.fix === undefined ? {} : { fix: translate(values.fix) }),
    });
  };
  const word = (value: SettingsWord) =>
    translate(value.key, {
      ...(value.values.interval === undefined
        ? {}
        : { interval: translate(value.values.interval) }),
      ...(value.values.time === undefined ? {} : { time: value.values.time }),
    });
  return { utc, local, span, ago, size, phrase, word };
}

function GuideLink(
  { href, children }: { readonly href: string; readonly children: ReactNode },
) {
  return (
    <UI.Link href={href} variant="external">
      {children}
    </UI.Link>
  );
}

function InternalLink(
  { path, onNavigate, children, variant = "internal" }: {
    readonly path: string;
    readonly onNavigate: (path: string) => void;
    readonly children: ReactNode;
    readonly variant?: "internal" | "button";
  },
) {
  return (
    <UI.Link
      href={path}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.defaultPrevented || event.button !== 0 || event.metaKey ||
          event.ctrlKey || event.shiftKey || event.altKey
        ) return;
        event.preventDefault();
        onNavigate(path);
      }}
      variant={variant}
    >
      {children}
    </UI.Link>
  );
}

export function InstallationBackupsScreen(
  props: InstallationBackupsScreenProps,
) {
  const { translate } = useI18n();
  const phone = useShellViewport() === "phone";
  const { state, status } = props;

  if (state === "notFound") {
    return (
      <UI.SettingsContent data-page="installation-backups" variant="wide">
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

  const noRunner = state === "ready" && status !== null &&
    !status.runnerConfigured;

  const headerActions = state === "ready" && status !== null
    ? (
      <UI.Inline gap="compact" variant={phone ? "actions" : undefined}>
        <InternalLink
          onNavigate={props.onNavigate}
          path={BACKUPS_SETTINGS_PATH}
          variant="button"
        >
          {translate("installation.backups.settings.open")}
        </InternalLink>
        {noRunner ? null : (
          <UI.Button
            disabled={isBackingUp(status) || props.starting}
            loading={props.starting}
            onClick={props.onStart}
            type="button"
            variant="primary"
          >
            {translate(
              isBackingUp(status) || props.starting
                ? "installation.backups.start.busy"
                : "installation.backups.start.label",
            )}
          </UI.Button>
        )}
      </UI.Inline>
    )
    : null;

  return (
    <UI.SettingsContent data-page="installation-backups" variant="wide">
      {phone || headerActions === null
        ? null
        : <ShellSlot name="actions">{headerActions}</ShellSlot>}
      <UI.Stack gap="standard">
        <UI.PageHeader
          actions={phone ? headerActions ?? undefined : undefined}
          description={translate("installation.backups.description")}
          flush
          title={translate("installation.backups.title")}
          variant="list"
        />
        {state === "loading"
          ? (
            <UI.Stack
              aria-busy="true"
              aria-label={translate("installation.backups.loading")}
              gap="standard"
            >
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
              <UI.Skeleton shape="row" />
            </UI.Stack>
          )
          : state === "error" || status === null
          ? (
            <UI.InlineNotice
              action={
                <UI.Button onClick={props.onRetry} variant="secondary">
                  {translate("core.actions.retry")}
                </UI.Button>
              }
              data-result="load-failed"
              role="alert"
              tone="error"
            >
              {translate("installation.backups.error")}
            </UI.InlineNotice>
          )
          : noRunner
          ? <NoRunner {...props} />
          : <Ready {...props} status={status} />}
      </UI.Stack>
      <RunnerKeyDialog onDone={props.onKeyDone} runnerKey={props.runnerKey} />
    </UI.SettingsContent>
  );
}

function NoRunner(props: InstallationBackupsScreenProps) {
  const { translate } = useI18n();
  return (
    <>
      <UI.EmptyState
        action={
          <UI.Inline gap="compact" variant="actions">
            <UI.Button
              loading={props.runnerKey.phase === "issuing"}
              onClick={props.onMakeKey}
              type="button"
              variant="primary"
            >
              {translate("installation.backups.empty.makeKey")}
            </UI.Button>
            <GuideLink href={BACKUPS_RUNNER_GUIDE_HREF}>
              {translate("installation.backups.empty.guide")}
            </GuideLink>
          </UI.Inline>
        }
        data-state-name="no-runner"
        description={translate("installation.backups.empty.body")}
        title={translate("installation.backups.empty.title")}
        variant="firstUse"
      />
      {props.runnerKey.phase === "failed"
        ? (
          <UI.InlineNotice data-result="key-failed" role="alert" tone="error">
            {translate("installation.backups.key.failed")}
          </UI.InlineNotice>
        )
        : null}
    </>
  );
}

function Ready(
  props: InstallationBackupsScreenProps & { readonly status: BackupStatus },
) {
  const { status } = props;
  const notice = backupNotice({
    status,
    latest: props.runs.rows[0] ?? null,
    offsiteConfigured: props.offsite === null ? null : props.offsite.configured,
    nowMs: props.nowMs,
  });
  return (
    <UI.Stack gap="standard">
      <StatusNotice notice={notice} />
      {props.startFailed ? <StartFailed /> : null}
      <Facts {...props} notice={notice} />
      <RunList {...props} />
      <DrillList {...props} />
      <SettingsCard {...props} />
      <ServiceCard {...props} status={status} />
      <RestoringCard {...props} />
    </UI.Stack>
  );
}

function StartFailed() {
  const { translate } = useI18n();
  return (
    <UI.InlineNotice data-result="start-failed" role="alert" tone="error">
      {translate("installation.backups.start.failed")}
    </UI.InlineNotice>
  );
}

function StatusNotice(
  { notice }: { readonly notice: Notice },
) {
  const { translate } = useI18n();
  const format = useFormatters();
  return (
    <UI.Stack gap="compact">
      <UI.InlineNotice
        data-notice={notice.id}
        role={notice.tone === "error" ? "alert" : "status"}
        tone={notice.tone}
      >
        <UI.Stack gap="tight">
          <UI.Text variant="strong">{format.phrase(notice.title)}</UI.Text>
          {notice.lines.map((line) => (
            <UI.Text key={line.key}>{format.phrase(line)}</UI.Text>
          ))}
        </UI.Stack>
      </UI.InlineNotice>
      {notice.holdingWork
        ? (
          <UI.Text data-result="holding-work" variant="caption">
            {translate("installation.backups.notice.holding")}
          </UI.Text>
        )
        : null}
    </UI.Stack>
  );
}

function Facts(
  props: InstallationBackupsScreenProps & {
    readonly status: BackupStatus;
    readonly notice: Notice;
  },
) {
  const { translate } = useI18n();
  const format = useFormatters();
  const { status, nowMs } = props;
  const lastGood = status.lastGoodBackupAt;
  const bannerNamesAge = props.notice.id === "protected";
  const next = props.schedule === null
    ? null
    : nextBackup(props.schedule, nowMs);
  const check = restoreCheckFact(props.drills.rows[0] ?? null);
  return (
    <UI.Inline gap="standard" variant="thirds">
      <UI.StatTile
        data-fact="last-good"
        detail={lastGood === null || bannerNamesAge
          ? undefined
          : format.ago(spanSince(lastGood, nowMs))}
        label={translate("installation.backups.facts.lastGood.label")}
        value={lastGood === null
          ? translate("installation.backups.facts.lastGood.value")
          : format.utc(lastGood)}
      />
      <UI.StatTile
        data-fact="next"
        detail={next === null
          ? translate("installation.backups.facts.next.unknown")
          : next.kind === "off"
          ? (
            <InternalLink
              onNavigate={props.onNavigate}
              path={BACKUPS_SETTINGS_PATH}
            >
              {translate("installation.backups.facts.next.turnOn")}
            </InternalLink>
          )
          : translate("installation.backups.facts.next.in", {
            span: format.span(
              spanOfSeconds(
                Math.max(0, (Date.parse(next.iso) - nowMs) / 1000),
              ),
            ),
          })}
        label={translate("installation.backups.facts.next.label")}
        value={next === null
          ? translate("installation.backups.facts.next.value")
          : next.kind === "off"
          ? translate("installation.backups.facts.next.off")
          : format.utc(next.iso)}
      />
      <UI.StatTile
        data-fact="restore-check"
        detail={check.kind === "never"
          ? (
            <GuideLink href={BACKUPS_DRILL_GUIDE_HREF}>
              {translate("installation.backups.facts.check.guide")}
            </GuideLink>
          )
          : translate("installation.backups.facts.check.detail", {
            time: format.utc(check.recordedAt),
            span: format.span(check.restoredIn),
          })}
        label={translate("installation.backups.facts.check.label")}
        value={check.kind === "never"
          ? translate("installation.backups.facts.check.never")
          : translate(
            check.passed
              ? "installation.backups.facts.check.passed"
              : "installation.backups.facts.check.failed",
          )}
      />
    </UI.Inline>
  );
}

function MoreButton(
  { list, onMore, onRetry, name }: {
    readonly list: BackupsListState & { readonly rows: readonly unknown[] };
    readonly onMore: () => void;
    readonly onRetry: () => void;
    readonly name: string;
  },
) {
  const { translate } = useI18n();
  return (
    <>
      {list.state === "error" && list.rows.length > 0
        ? (
          <UI.InlineNotice
            action={
              <UI.Button
                data-paged-retry={name}
                onClick={onMore}
                variant="secondary"
              >
                {translate("core.actions.retry")}
              </UI.Button>
            }
            data-result={`${name}-more-failed`}
            role="alert"
            tone="error"
          >
            {translate("installation.backups.moreError")}
          </UI.InlineNotice>
        )
        : null}
      {list.state === "error" && list.rows.length === 0
        ? (
          <UI.InlineNotice
            action={
              <UI.Button onClick={onRetry} variant="secondary">
                {translate("core.actions.retry")}
              </UI.Button>
            }
            data-result={`${name}-failed`}
            role="alert"
            tone="error"
          >
            {translate("installation.backups.listError")}
          </UI.InlineNotice>
        )
        : null}
      {list.hasMore && !(list.state === "error" && list.rows.length > 0)
        ? (
          <UI.Inline>
            <UI.Button
              data-paged-more={name}
              loading={list.loadingMore}
              onClick={onMore}
              type="button"
              variant="outline"
            >
              {translate("installation.backups.showOlder")}
            </UI.Button>
          </UI.Inline>
        )
        : null}
    </>
  );
}

function RunList(props: InstallationBackupsScreenProps) {
  const { translate } = useI18n();
  const format = useFormatters();
  const phone = useShellViewport() === "phone";
  const { runs } = props;
  const taken = (run: BackupRun) => {
    const at = takenAt(run);
    const local = format.local(at);
    return (
      <UI.Stack gap="none">
        <span>{format.utc(at)}</span>
        {local === null ? null : <UI.Text variant="caption">{local}</UI.Text>}
      </UI.Stack>
    );
  };
  const keptIn = (run: BackupRun) => {
    const key = keptInKey(run.locations);
    return key === null ? missing(run) : translate(key);
  };
  const missing = (run: BackupRun) =>
    translate(
      run.status === "failed"
        ? "installation.backups.list.notTaken"
        : "installation.backups.list.notFinished",
    );
  const sizeOfRun = (run: BackupRun) =>
    run.sizeBytes === null ? missing(run) : format.size(run.sizeBytes);
  if (runs.state === "ready" && runs.rows.length === 0) return null;
  return (
    <UI.SettingsSection
      data-section="backups"
      title={translate("installation.backups.list.title")}
      variant="stack"
    >
      {runs.state === "loading"
        ? (
          <UI.Stack aria-busy="true" gap="standard">
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )
        : phone
        ? (
          <UI.Stack gap="none">
            {runs.rows.map((run) => {
              const outcome = runResult(run);
              return (
                <UI.StackedRow
                  data-run={run.id}
                  flush
                  key={run.id}
                  status={
                    <UI.Badge tone={outcome.tone}>
                      {translate(outcome.key)}
                    </UI.Badge>
                  }
                  title={format.utc(takenAt(run))}
                  titleLines="wrap"
                >
                  <UI.Stack gap="tight">
                    <UI.Text variant="caption">
                      {[
                        translate(startedByKey(run)),
                        sizeOfRun(run),
                        keptIn(run),
                      ].filter((part, index, parts) =>
                        index === 0 || part !== parts[index - 1]
                      ).join(DETAIL_SEPARATOR)}
                    </UI.Text>
                    {outcome.cause === null ? null : (
                      <UI.Text variant="caption">
                        {format.phrase(outcome.cause)}
                      </UI.Text>
                    )}
                  </UI.Stack>
                </UI.StackedRow>
              );
            })}
          </UI.Stack>
        )
        : runs.rows.length === 0
        ? null
        : (
          <UI.DataTable
            caption={translate("installation.backups.list.title")}
            captionHidden
            columns={[
              {
                id: "taken",
                header: translate("installation.backups.list.taken"),
                width: "24%",
                cell: taken,
              },
              {
                id: "by",
                header: translate("installation.backups.list.by"),
                width: "16%",
                cell: (run) => translate(startedByKey(run)),
              },
              {
                id: "size",
                header: translate("installation.backups.list.size"),
                width: "12%",
                cell: sizeOfRun,
              },
              {
                id: "kept",
                header: translate("installation.backups.list.kept"),
                width: "20%",
                cell: keptIn,
              },
              {
                id: "result",
                header: translate("installation.backups.list.result"),
                cell: (run) => {
                  const outcome = runResult(run);
                  return (
                    <UI.Stack gap="tight">
                      <UI.Badge tone={outcome.tone}>
                        {translate(outcome.key)}
                      </UI.Badge>
                      {outcome.cause === null
                        ? null
                        : (
                          <UI.Text variant="caption">
                            {format.phrase(outcome.cause)}
                          </UI.Text>
                        )}
                    </UI.Stack>
                  );
                },
              },
            ]}
            getRowAttributes={(run) => ({ "data-run": run.id })}
            getRowKey={(run) => run.id}
            rows={[...runs.rows]}
            state="ready"
          />
        )}
      <MoreButton
        list={runs}
        name="backups"
        onMore={props.onMoreRuns}
        onRetry={props.onRetryRuns}
      />
    </UI.SettingsSection>
  );
}

function DrillList(props: InstallationBackupsScreenProps) {
  const { translate } = useI18n();
  const format = useFormatters();
  const phone = useShellViewport() === "phone";
  const { drills } = props;
  const outcome = (drill: BackupDrill) => {
    const result = drillResult(drill);
    return (
      <UI.Stack gap="tight">
        <UI.Badge tone={result.passed ? "success" : "danger"}>
          {translate(
            result.passed
              ? "installation.backups.drills.passed"
              : "installation.backups.drills.failed",
          )}
        </UI.Badge>
        {result.cause === null
          ? null
          : <UI.Text variant="caption">{translate(result.cause)}</UI.Text>}
        {result.fix === null
          ? null
          : <UI.Text variant="caption">{translate(result.fix)}</UI.Text>}
        {result.failedChecks.length === 0 ? null : (
          <UI.Text variant="caption">
            {translate("installation.backups.drills.failedChecks", {
              checks: result.failedChecks.join(", "),
            })}
          </UI.Text>
        )}
      </UI.Stack>
    );
  };
  const age = (drill: BackupDrill) =>
    drill.rpoSeconds === null
      ? "—"
      : translate("installation.backups.drills.age", {
        span: format.span(spanOfSeconds(drill.rpoSeconds)),
      });
  const restoredIn = (drill: BackupDrill) =>
    translate("installation.backups.drills.restoredIn", {
      span: format.span(spanOfSeconds(drill.rtoSeconds)),
    });
  return (
    <UI.SettingsSection
      data-section="restore-checks"
      title={translate("installation.backups.drills.title")}
      variant="stack"
    >
      {drills.state === "loading"
        ? <UI.Skeleton shape="row" />
        : drills.rows.length === 0 && drills.state === "ready"
        ? (
          <UI.Text data-result="no-drills" variant="muted">
            {translate("installation.backups.drills.empty")}
          </UI.Text>
        )
        : phone
        ? (
          <UI.Stack gap="none">
            {drills.rows.map((drill) => (
              <UI.StackedRow
                data-drill={drill.id}
                flush
                key={drill.id}
                status={outcome(drill)}
                title={drill.backupName}
                titleLines="wrap"
              >
                <UI.Text variant="caption">
                  {[
                    format.utc(drill.recordedAt),
                    age(drill),
                    restoredIn(drill),
                  ].join(DETAIL_SEPARATOR)}
                </UI.Text>
              </UI.StackedRow>
            ))}
          </UI.Stack>
        )
        : drills.rows.length === 0
        ? null
        : (
          <UI.DataTable
            caption={translate("installation.backups.drills.title")}
            captionHidden
            columns={[
              {
                id: "backup",
                header: translate("installation.backups.drills.backup"),
                width: "22%",
                cell: (drill) => (
                  <UI.DataText fit variant="code">
                    {drill.backupName}
                  </UI.DataText>
                ),
              },
              {
                id: "checked",
                header: translate("installation.backups.drills.checked"),
                width: "20%",
                cell: (drill) => format.utc(drill.recordedAt),
              },
              {
                id: "result",
                header: translate("installation.backups.drills.result"),
                cell: outcome,
              },
              {
                id: "age",
                header: translate("installation.backups.drills.ageHeader"),
                width: "16%",
                cell: age,
              },
              {
                id: "restoredIn",
                header: translate("installation.backups.drills.restoredHeader"),
                width: "14%",
                cell: restoredIn,
              },
            ]}
            getRowAttributes={(drill) => ({ "data-drill": drill.id })}
            getRowKey={(drill) => drill.id}
            rows={[...drills.rows]}
            state="ready"
          />
        )}
      <GuideLink href={BACKUPS_DRILL_GUIDE_HREF}>
        {translate("installation.backups.drills.guide")}
      </GuideLink>
      <MoreButton
        list={drills}
        name="drills"
        onMore={props.onMoreDrills}
        onRetry={props.onRetryDrills}
      />
    </UI.SettingsSection>
  );
}

function SettingsCard(props: InstallationBackupsScreenProps) {
  const { translate } = useI18n();
  const format = useFormatters();
  const unavailable = translate("installation.backups.settings.unavailable");
  const { schedule, offsite, pointInTime } = props;
  return (
    <UI.SettingsSection
      data-section="settings"
      title={translate("installation.backups.settings.title")}
      variant="stack"
    >
      <UI.DescriptionList labels="quiet">
        <UI.DescriptionItem
          data-fact="schedule"
          description={schedule === null
            ? unavailable
            : format.word(scheduleWords(schedule))}
          title={translate("installation.backups.settings.schedule")}
        />
        <UI.DescriptionItem
          data-fact="offsite"
          description={offsite === null
            ? unavailable
            : translate(offsiteWords(offsite.configured))}
          title={translate("installation.backups.settings.offsite")}
        />
        <UI.DescriptionItem
          data-fact="pitr"
          description={pointInTime === null ? unavailable : translate(
            pointInTimeWords(
              pointInTime.enabled,
              pointInTime.latestRestorableAt !== null,
            ),
          )}
          title={translate("installation.backups.settings.pitr")}
        />
      </UI.DescriptionList>
    </UI.SettingsSection>
  );
}

function ServiceCard(
  props: InstallationBackupsScreenProps & { readonly status: BackupStatus },
) {
  const { translate } = useI18n();
  const format = useFormatters();
  const { status, nowMs } = props;
  const heard = status.runnerLastUsedAt;
  const quiet = isQuiet(heard, nowMs);
  const span = heard === null ? null : spanSince(heard, nowMs);
  const state: { readonly label: MessageKey; readonly value: MessageKey } =
    heard === null
      ? {
        label: "installation.backups.service.state.waiting",
        value: "installation.backups.service.waiting",
      }
      : quiet
      ? {
        label: "installation.backups.service.state.quiet",
        value: "installation.backups.service.quiet",
      }
      : {
        label: "installation.backups.service.state.running",
        value: "installation.backups.service.running",
      };
  return (
    <UI.SettingsSection
      data-section="service"
      title={translate("installation.backups.service.title")}
      variant="stack"
    >
      <UI.DescriptionList labels="quiet">
        <UI.DescriptionItem
          data-fact="service"
          description={span === null
            ? translate(state.value)
            : translate(state.value, {
              ago: format.ago(span),
              span: format.span(span),
            })}
          title={translate(state.label)}
        />
      </UI.DescriptionList>
    </UI.SettingsSection>
  );
}

function RestoringCard(props: InstallationBackupsScreenProps) {
  const { translate } = useI18n();
  return (
    <UI.SettingsSection
      data-section="restoring"
      title={translate("installation.backups.restoring.title")}
      variant="stack"
    >
      <UI.Text variant="muted">
        {translate("installation.backups.restoring.body")}
      </UI.Text>
      <UI.Inline gap="compact" variant="actions">
        <GuideLink href={BACKUPS_RESTORE_GUIDE_HREF}>
          {translate("installation.backups.restoring.guide")}
        </GuideLink>
        {props.restoreHeld
          ? (
            <InternalLink
              onNavigate={props.onNavigate}
              path={BACKUPS_RESTORE_PATH}
              variant="button"
            >
              {translate("installation.backups.restoring.finish")}
            </InternalLink>
          )
          : null}
      </UI.Inline>
    </UI.SettingsSection>
  );
}
