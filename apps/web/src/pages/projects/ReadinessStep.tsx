import { Fragment, type ReactNode } from "react";
import * as UI from "@bakery/ui";
import type {
  RepositoryProfileResponse,
  RepositoryResponse,
} from "../../api/client.ts";
import { useConnectivity } from "../../app/connectivity.ts";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  CHECK_NAME_KEYS,
  CHECK_REASON_KEYS,
  type CheckOutcome,
  type CheckResult,
  isBlocking,
  missingTools,
} from "./check-state.ts";
import type { CheckInfo } from "./use-check-view.ts";
import { useStartCheck } from "./use-readiness-check.ts";

/**
 * The readiness check, step 3 of a repository's setup (design-ux, #65): run
 * it, see it progress, and read what did not pass and what to do about it. The
 * check shown is the one the address names (`?check=`); the page knows of no
 * other, and says "not checked yet" rather than guess.
 */
export function ReadinessStep(
  { repository, info, profiles, active, canManage, onStarted }: Readonly<{
    repository: RepositoryResponse;
    /** Every version of the settings, to tell whether the checked one was saved by the check. */
    profiles: readonly RepositoryProfileResponse[];
    /** What is known about the check the address names (shared with the page header). */
    info: CheckInfo;
    active: RepositoryProfileResponse | null;
    canManage: boolean;
    onStarted: (checkId: string) => void;
  }>,
) {
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const offline = useConnectivity() === "offline";
  const archived = repository.archivedAt !== null;
  const starter = useStartCheck(repository, onStarted);
  const { view } = info;
  // A version created after the check began was saved by it (the server saves
  // the next version when a check runs, and puts it in use if the check passes).
  const checked = info.observedRevision === null
    ? undefined
    : profiles.find((profile) => profile.revision === info.observedRevision);
  const savedByCheck = checked !== undefined && info.checkCreatedAt !== null &&
    Date.parse(checked.createdAt) >= Date.parse(info.checkCreatedAt);

  const when = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  const machine = (outcome: CheckOutcome) =>
    translate("projects.repository.check.machine" as never, {
      system: translate(
        `projects.repository.check.system.${outcome.host.os}` as never,
      ),
      architecture: outcome.host.architecture,
    });

  const inFlight = view.kind === "waiting" || view.kind === "running";
  const canStart = canManage && !offline && !archived && active !== null &&
    !inFlight && !starter.pending;
  // The check's action is a button at the end of the step's line, label-wide;
  // full width in the step's detail only on a phone.
  const run = (label: string, primary: boolean) => (
    <UI.Button
      variant={primary ? "primary" : "text"}
      disabled={!canStart}
      loading={starter.pending}
      onClick={() => void starter.start()}
    >
      {starter.pending
        ? translate("projects.repository.check.starting" as never)
        : label}
    </UI.Button>
  );
  const again = translate("projects.repository.check.again" as never);

  const status = (
    value: "done" | "todo" | "unknown",
  ) => translate(`projects.repository.status.${value}` as never);

  const nameOf = (result: CheckResult) =>
    translate(
      `projects.repository.check.name.${
        CHECK_NAME_KEYS[result.template]
      }` as never,
    );
  const reasonOf = (result: CheckResult, outcome: CheckOutcome) => {
    const sentence = result.reason === "tool_missing"
      ? (() => {
        const tools = missingTools(outcome.host);
        return tools.length === 0
          ? translate(
            "projects.repository.check.reason.toolMissingUnknown" as never,
          )
          : translate("projects.repository.check.reason.toolMissing" as never, {
            tools: tools.join(", "),
          });
      })()
      : translate(
        `projects.repository.check.reason.${
          CHECK_REASON_KEYS[result.reason]
        }` as never,
      );
    // An optional check that did not pass says what that costs: nothing.
    return result.required
      ? sentence
      : `${sentence} ${
        translate("projects.repository.check.reason.optionalSuffix" as never)
      }`;
  };
  const failedList = (outcome: CheckOutcome): ReactNode => {
    const rows = outcome.checks.filter((result) => result.status !== "passed")
      .sort((a, b) => Number(isBlocking(b)) - Number(isBlocking(a)));
    if (rows.length === 0) return undefined;
    return (
      <UI.Stack
        gap="compact"
        role="list"
        aria-label={translate(
          "projects.repository.check.resultsLabel" as never,
        )}
        data-testid="check-results"
      >
        {rows.map((result) => (
          <div key={result.id} role="listitem" data-check-id={result.id}>
            <UI.Stack gap="compact">
              <UI.Inline gap="compact">
                <UI.Text variant="strong">{nameOf(result)}</UI.Text>
                <UI.Badge tone="neutral">
                  {translate(
                    (result.required
                      ? "projects.repository.check.required"
                      : "projects.repository.check.optional") as never,
                  )}
                </UI.Badge>
                <UI.Badge tone={isBlocking(result) ? "danger" : "warning"}>
                  {translate(
                    `projects.repository.check.outcome.${result.status}` as never,
                  )}
                </UI.Badge>
              </UI.Inline>
              <UI.Text variant="muted">{reasonOf(result, outcome)}</UI.Text>
            </UI.Stack>
          </div>
        ))}
      </UI.Stack>
    );
  };

  // What the step says and does, by what is known about the check.
  let stepStatus: "done" | "failed" | "running" | "upcoming" | "unknown" =
    "upcoming";
  let label = status("todo");
  let summary: ReactNode;
  let detail: ReactNode;
  let next: ReactNode; // the primary action, placed by `phone`
  let quiet: ReactNode; // a text action at the end of the line
  const notice = starter.failure === null
    ? null
    : (
      <UI.InlineNotice role="alert" tone="error">
        {translate(
          `projects.repository.check.startFailure.${starter.failure}` as never,
        )}
      </UI.InlineNotice>
    );

  if (active === null) {
    summary = translate("projects.repository.step.check.blocked" as never);
  } else if (view.kind === "none") {
    stepStatus = "running";
    summary = translate("projects.repository.step.check.todo" as never);
    next = canManage
      ? run(translate("projects.repository.check.run" as never), true)
      : undefined;
    detail = canManage ? undefined : (
      <UI.Text variant="muted">
        {translate("projects.repository.check.adminOnly" as never)}
      </UI.Text>
    );
  } else if (view.kind === "waiting" || view.kind === "running") {
    stepStatus = "running";
    summary = view.kind === "waiting"
      ? translate("projects.repository.check.queued" as never)
      : translate("projects.repository.check.running" as never, {
        when: when(view.startedAt),
      });
  } else if (view.kind === "loading") {
    stepStatus = "running";
    summary = translate("projects.repository.check.loading" as never);
  } else if (view.kind === "unreadable") {
    stepStatus = "unknown";
    label = status("unknown");
    summary = translate("projects.repository.check.unreadable" as never);
    quiet = (
      <UI.Button
        variant="text"
        onClick={info.refetch}
      >
        {translate("projects.repository.check.retry" as never)}
      </UI.Button>
    );
  } else if (view.kind === "unavailable") {
    stepStatus = "unknown";
    label = status("unknown");
    summary = translate("projects.repository.check.unavailable" as never);
    next = run(again, true);
  } else if (view.kind === "failed" || view.kind === "canceled") {
    stepStatus = "failed";
    summary = translate(
      (view.kind === "failed"
        ? "projects.repository.check.failed"
        : "projects.repository.check.canceled") as never,
    );
    next = run(again, true);
  } else if (
    info.observedRevision !== null && info.observedRevision < active.revision
  ) {
    // The result is for an older version of the settings than the one in use.
    stepStatus = "unknown";
    label = status("unknown");
    summary = translate("projects.repository.check.otherVersion" as never, {
      checked: info.observedRevision,
      current: active.revision,
    });
    next = run(again, true);
  } else if (view.kind === "result") {
    const { outcome } = view;
    let note: ReactNode;
    if (outcome.ready) {
      stepStatus = "done";
      label = status("done");
      summary = translate("projects.repository.check.passed" as never, {
        count: outcome.required,
        when: when(outcome.observedAt),
        machine: machine(outcome),
      });
      quiet = run(again, false);
      note = savedByCheck && info.observedRevision === active.revision
        ? (
          <UI.Text variant="muted" data-testid="check-saved">
            {translate("projects.repository.check.savedInUse" as never, {
              version: active.revision,
            })}
          </UI.Text>
        )
        : undefined;
    } else {
      stepStatus = "failed";
      summary = translate("projects.repository.check.notReady" as never, {
        blocking: outcome.blocking,
        required: outcome.required,
        when: when(outcome.observedAt),
        machine: machine(outcome),
      });
      next = run(again, true);
    }
    const list = failedList(outcome);
    // A check that did not pass publishes the version it checked and leaves the
    // one in use alone; say so, so a newer version number is not a surprise.
    const notInUse = info.observedRevision !== null &&
        info.observedRevision > active.revision
      ? (
        <UI.Text variant="muted" data-testid="check-not-in-use">
          {translate(
            (savedByCheck
              ? "projects.repository.check.notInUse"
              : "projects.repository.check.notInUseBare") as never,
            { checked: info.observedRevision, current: active.revision },
          )}
        </UI.Text>
      )
      : null;
    const parts = [notInUse, note, list].filter((part) =>
      part !== undefined && part !== null
    );
    detail = parts.length === 0
      ? undefined
      : parts.length === 1
      ? parts[0]
      : (
        <UI.Stack gap="compact">
          {parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)}
        </UI.Stack>
      );
  }

  const body = [phone ? next : undefined, notice, detail].filter((part) =>
    part !== undefined && part !== null && part !== false
  );
  return (
    <UI.StepItem
      data-testid="setup-check"
      status={stepStatus}
      statusLabel={label}
      title={translate("projects.repository.step.check.title" as never)}
      summary={summary}
      action={phone ? quiet : next ?? quiet}
    >
      {body.length === 0 ? undefined : (
        body.map((part, index) => <Fragment key={index}>{part}</Fragment>)
      )}
    </UI.StepItem>
  );
}
