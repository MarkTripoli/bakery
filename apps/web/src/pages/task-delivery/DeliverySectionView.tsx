import { useState } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { MessageKey } from "@bakery/i18n";
import type { CheckRow, DeliveryModel, FindingRow, NowCard } from "./model.ts";

export type DeliveryViewState = "loading" | "error" | "forbidden" | "ready";

export type DeliverySectionViewProps = Readonly<{
  state: DeliveryViewState;
  model: DeliveryModel | null;
  offline: boolean;
  /** When the last read arrived, already formatted, shown while offline. */
  lastUpdated: string | null;
  onRetry: () => void;
  /** Scroll to and focus the task's message box. */
  onTellBakery: () => void;
  onOpenRules: () => void;
}>;

/** At most this many findings or checks show before "Show all". */
const SHOWN = 5;

type Translate = ReturnType<typeof useI18n>["translate"];

type NowCopy = Readonly<{
  title: string;
  body: string;
  action: "tell" | "rules" | null;
}>;

function nowCopy(t: Translate, now: NowCard): NowCopy {
  const next = t("tasks.delivery.now.nextStep");
  switch (now.kind) {
    case "checking":
      return {
        title: t("tasks.delivery.now.checking.title"),
        body: t("tasks.delivery.now.checking.body"),
        action: null,
      };
    case "fixing":
      return {
        title: t("tasks.delivery.now.fixing.title", {
          attempt: now.attempt,
          max: now.max,
        }),
        body: t("tasks.delivery.now.fixing.body"),
        action: null,
      };
    case "paused":
      return {
        title: t("tasks.delivery.now.paused.title"),
        body: t("tasks.delivery.now.paused.body"),
        action: null,
      };
    case "clean":
      return {
        title: t("tasks.delivery.now.clean.title"),
        body: t("tasks.delivery.now.clean.body"),
        action: null,
      };
    case "checksFailed":
      return {
        title: t("tasks.delivery.now.checksFailed.title"),
        body: `${
          t("tasks.delivery.now.checksFailed.body", { count: now.failed })
        } ${next}`,
        action: "tell",
      };
    case "stopped":
      return stoppedCopy(t, now, next);
  }
}

function stoppedCopy(
  t: Translate,
  now: Extract<NowCard, { kind: "stopped" }>,
  next: string,
): NowCopy {
  const tell = (title: string, body: string): NowCopy => ({
    title,
    body: `${body} ${next}`,
    action: "tell",
  });
  switch (now.reason) {
    case "repair_cycles_exhausted":
      return tell(
        t("tasks.delivery.now.stopped.cycles.title"),
        t("tasks.delivery.now.stopped.cycles.body", {
          max: now.max,
          count: now.blocking,
        }),
      );
    case "repair_time_exhausted":
      return tell(
        t("tasks.delivery.now.stopped.time.title"),
        t("tasks.delivery.now.stopped.remaining", { count: now.blocking }),
      );
    case "repair_budget_exhausted":
      return tell(
        t("tasks.delivery.now.stopped.budget.title"),
        t("tasks.delivery.now.stopped.remaining", { count: now.blocking }),
      );
    case "repeated_blocker":
      return tell(
        t("tasks.delivery.now.stopped.repeated.title"),
        now.findingTitle === null
          ? t("tasks.delivery.now.stopped.repeated.bodyUnnamed")
          : t("tasks.delivery.now.stopped.repeated.body", {
            title: now.findingTitle,
          }),
      );
    case "checks_unavailable":
      return tell(
        t("tasks.delivery.now.stopped.checks.title"),
        t("tasks.delivery.now.stopped.checks.body", {
          count: now.unavailableChecks,
        }),
      );
    case "reviewer_unavailable":
    case "review_failed":
      return tell(
        t("tasks.delivery.now.stopped.review.title"),
        t("tasks.delivery.now.stopped.review.body"),
      );
    case "policy_missing":
      return {
        title: t("tasks.delivery.now.stopped.policy.title"),
        body: t("tasks.delivery.now.stopped.policy.body"),
        action: "rules",
      };
    case "stale_evidence":
      return {
        title: t("tasks.delivery.now.checking.title"),
        body: t("tasks.delivery.now.checking.body"),
        action: null,
      };
  }
}

const CHECK_TONE = {
  passed: "success",
  failed: "danger",
  pending: "neutral",
  unavailable: "warning",
  canceled: "neutral",
} as const;

const CHECK_LABEL: Readonly<Record<CheckRow["result"], MessageKey>> = {
  passed: "tasks.delivery.check.passed",
  failed: "tasks.delivery.check.failed",
  pending: "tasks.delivery.check.running",
  unavailable: "tasks.delivery.check.unavailable",
  canceled: "tasks.delivery.check.canceled",
};

const SEVERITY_LABEL: Readonly<Record<FindingRow["severity"], MessageKey>> = {
  blocker: "tasks.delivery.severity.blocker",
  major: "tasks.delivery.severity.major",
  minor: "tasks.delivery.severity.minor",
  note: "tasks.delivery.severity.note",
};

const SEVERITY_TONE = {
  blocker: "danger",
  major: "warning",
  minor: "neutral",
  note: "neutral",
} as const;

export function DeliverySectionView(
  { lastUpdated, model, offline, onOpenRules, onRetry, onTellBakery, state }:
    DeliverySectionViewProps,
) {
  const { translate: t } = useI18n();
  const heading = t("tasks.delivery.heading");
  return (
    <UI.PaneSection
      aria-label={heading}
      data-testid="delivery-section"
      heading="strong"
      title={heading}
    >
      <UI.Stack>
        <UI.Text>{t("tasks.delivery.purpose")}</UI.Text>
        {state === "loading" && (
          <UI.Stack aria-label={t("tasks.delivery.loading")} role="status">
            <UI.Skeleton shape="surface" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
            <UI.Skeleton shape="row" />
          </UI.Stack>
        )}
        {state === "error" && (
          <UI.ErrorState
            action={
              <UI.Button onClick={onRetry}>
                {t("tasks.delivery.error.retry")}
              </UI.Button>
            }
            description={t("tasks.delivery.error.description")}
            title={t("tasks.delivery.error.title")}
            variant="region"
          />
        )}
        {state === "forbidden" && (
          <UI.AlertBanner tone="information">
            {t("tasks.delivery.forbidden")}
          </UI.AlertBanner>
        )}
        {state === "ready" && model !== null && (
          <ReadyView
            lastUpdated={lastUpdated}
            model={model}
            offline={offline}
            onOpenRules={onOpenRules}
            onTellBakery={onTellBakery}
          />
        )}
      </UI.Stack>
    </UI.PaneSection>
  );
}

function ReadyView(
  { lastUpdated, model, offline, onOpenRules, onTellBakery }: Readonly<{
    model: DeliveryModel;
    offline: boolean;
    lastUpdated: string | null;
    onOpenRules: () => void;
    onTellBakery: () => void;
  }>,
) {
  const { translate: t } = useI18n();
  const copy = nowCopy(t, model.now);
  const action = copy.action === null ? null : (
    <UI.Button
      disabled={offline && copy.action === "tell"}
      onClick={copy.action === "tell" ? onTellBakery : onOpenRules}
      variant={copy.action === "tell" ? "primary" : "text"}
    >
      {t(
        copy.action === "tell"
          ? "tasks.delivery.now.tell"
          : "tasks.delivery.now.openRules",
      )}
    </UI.Button>
  );
  return (
    <>
      {model.outOfDate && (
        <UI.AlertBanner tone="warning">
          <UI.Heading level="subsection">
            {t("tasks.delivery.outOfDate.title")}
          </UI.Heading>
          <UI.Text>{t("tasks.delivery.outOfDate.body")}</UI.Text>
        </UI.AlertBanner>
      )}
      <UI.AlertBanner
        action={action}
        data-testid="delivery-now"
        tone="information"
      >
        <UI.Heading level="subsection">{copy.title}</UI.Heading>
        <UI.Text>{copy.body}</UI.Text>
        {offline && (
          <UI.Text>
            {t("tasks.delivery.offline")}
            {lastUpdated !== null &&
              ` ${t("tasks.delivery.lastUpdated", { time: lastUpdated })}`}
          </UI.Text>
        )}
      </UI.AlertBanner>
      <Steps model={model} />
    </>
  );
}

function Steps({ model }: Readonly<{ model: DeliveryModel }>) {
  const { translate: t } = useI18n();
  const [showAllChecks, setShowAllChecks] = useState(false);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const { checks, review, fixing } = model;

  const changesSummary = model.headSha === null
    ? t("tasks.delivery.changes.preparing")
    : model.baseSha === null
    ? t("tasks.delivery.changes.summaryNoBase", {
      head: model.headSha.slice(0, 7),
    })
    : t("tasks.delivery.changes.summary", {
      head: model.headSha.slice(0, 7),
      base: model.baseSha.slice(0, 7),
    });

  const failedAny = checks.rows.some((row) => row.result === "failed");
  const olderRows = checks.rows.filter((row) => row.olderSha !== null);
  const checksStatus = failedAny
    ? "failed"
    : checks.running > 0 || (checks.rows.length > 0 && olderRows.length > 0)
    ? "running"
    : checks.unavailable > 0
    ? "unknown"
    : checks.total > 0 && checks.passed === checks.total
    ? "done"
    : "upcoming";
  const sortedChecks = [...checks.rows].sort((a, b) =>
    Number(b.result === "failed") - Number(a.result === "failed")
  );
  const shownChecks = showAllChecks
    ? sortedChecks
    : sortedChecks.slice(0, SHOWN);
  const olderSha = olderRows[0]?.olderSha ?? null;

  const reviewStatus = review === null
    ? "upcoming"
    : review.status === "approved"
    ? review.olderSha === null ? "done" : "running"
    : review.status === "running"
    ? "running"
    : "failed";
  const findings = review?.findings ?? [];
  const shownFindings = showAllFindings ? findings : findings.slice(0, SHOWN);

  const label = (status: string) =>
    t(`tasks.delivery.status.${status}` as MessageKey);
  const helpTip = (
    key: "checks" | "review" | "fixing",
    args?: Record<string, number>,
  ) => (
    <UI.HelpTip label={t(`tasks.delivery.help.${key}.label` as MessageKey)}>
      {t(`tasks.delivery.help.${key}.text` as MessageKey, args)}
    </UI.HelpTip>
  );

  return (
    <UI.StepList label={t("tasks.delivery.steps")}>
      <UI.StepItem
        status={model.headSha === null ? "running" : "done"}
        statusLabel={label(model.headSha === null ? "running" : "done")}
        summary={changesSummary}
        title={t("tasks.delivery.changes.title")}
      />
      <UI.StepItem
        status={checksStatus}
        statusLabel={label(checksStatus)}
        summary={checks.rows.length === 0 ? t("tasks.delivery.checks.none") : (
          <>
            {failedAny
              ? t("tasks.delivery.checks.failedOf", {
                failed: checks.rows.filter((row) =>
                  row.result === "failed"
                ).length,
                total: checks.rows.length,
              })
              : t("tasks.delivery.checks.passedOf", {
                passed: checks.passed,
                total: checks.rows.length,
              })}
            {olderSha !== null && (
              <>
                {" "}
                <UI.Badge>
                  {t("tasks.delivery.olderCommit", { sha: olderSha })}
                </UI.Badge>
              </>
            )}
          </>
        )}
        title={<>{t("tasks.delivery.checks.title")}{helpTip("checks")}</>}
      >
        {checksStatus === "done" || checks.rows.length === 0
          ? null
          : (
            <UI.Stack gap="compact">
              {shownChecks.map((row) => (
                <UI.Text key={row.id}>
                  {row.name}{" "}
                  <UI.Badge tone={CHECK_TONE[row.result]}>
                    {t(CHECK_LABEL[row.result])}
                  </UI.Badge>
                  {row.olderSha !== null && (
                    <>
                      {" "}
                      <UI.Badge>
                        {t("tasks.delivery.olderCommit", { sha: row.olderSha })}
                      </UI.Badge>
                    </>
                  )}
                </UI.Text>
              ))}
              {!showAllChecks && sortedChecks.length > SHOWN && (
                <UI.Button
                  onClick={() => setShowAllChecks(true)}
                  variant="text"
                >
                  {t("tasks.delivery.showAll")}
                </UI.Button>
              )}
            </UI.Stack>
          )}
      </UI.StepItem>
      <UI.StepItem
        status={reviewStatus}
        statusLabel={label(reviewStatus)}
        summary={review === null ? t("tasks.delivery.review.none") : (
          <>
            {review.status === "approved"
              ? t("tasks.delivery.review.approved", { count: review.others })
              : review.status === "running"
              ? t("tasks.delivery.review.running")
              : review.status === "failed"
              ? t("tasks.delivery.review.failed")
              : review.others === 0
              ? t("tasks.delivery.review.changesBlockingOnly", {
                blocking: review.blocking,
              })
              : t("tasks.delivery.review.changes", {
                blocking: review.blocking,
                others: review.others,
              })}
            {review.olderSha !== null && (
              <>
                {" "}
                <UI.Badge>
                  {t("tasks.delivery.olderCommit", { sha: review.olderSha })}
                </UI.Badge>
              </>
            )}
          </>
        )}
        title={<>{t("tasks.delivery.review.title")}{helpTip("review")}</>}
      >
        {findings.length === 0 ? null : (
          <UI.Stack gap="compact">
            {shownFindings.map((finding) => (
              <UI.Text key={finding.id}>
                <UI.Badge tone={SEVERITY_TONE[finding.severity]}>
                  {t(SEVERITY_LABEL[finding.severity])}
                </UI.Badge>{" "}
                {finding.body}{" "}
                <UI.DataText variant="code">
                  {finding.line === null
                    ? finding.path
                    : `${finding.path}:${finding.line}`}
                </UI.DataText>
              </UI.Text>
            ))}
            {!showAllFindings && findings.length > SHOWN && (
              <UI.Button
                onClick={() => setShowAllFindings(true)}
                variant="text"
              >
                {t("tasks.delivery.showAll")}
              </UI.Button>
            )}
          </UI.Stack>
        )}
      </UI.StepItem>
      {fixing !== null && (
        <UI.StepItem
          status={fixing.running ? "running" : "done"}
          statusLabel={label(fixing.running ? "running" : "done")}
          summary={fixing.running
            ? t("tasks.delivery.fixing.running", {
              attempt: fixing.attempt,
              max: fixing.max,
            })
            : t("tasks.delivery.fixing.done", {
              attempt: fixing.attempt,
              max: fixing.max,
            })}
          title={
            <>
              {t("tasks.delivery.fixing.title")}
              {helpTip("fixing", { max: fixing.max })}
            </>
          }
        />
      )}
    </UI.StepList>
  );
}
