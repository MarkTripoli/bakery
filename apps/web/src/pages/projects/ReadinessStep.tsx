import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  RepositoryProfileResponse,
  RepositoryResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  repositoryCheckQueryOptions,
  repositoryProfileObservationQueryOptions,
} from "../../api/query.ts";
import { useConnectivity } from "../../app/connectivity.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  CHECK_NAME_KEYS,
  CHECK_REASON_KEYS,
  type CheckOutcome,
  type CheckResult,
  checkView,
  isBlocking,
  missingTools,
} from "./check-state.ts";
import { useStartCheck } from "./use-readiness-check.ts";

/**
 * The readiness check, step 3 of a repository's setup (design-ux, #65): run
 * it, see it progress, and read what did not pass and what to do about it. The
 * check shown is the one the address names (`?check=`); the page knows of no
 * other, and says "not checked yet" rather than guess.
 */
export function ReadinessStep(
  { repository, applicationId, active, canManage, checkId, onStarted }:
    Readonly<{
      repository: RepositoryResponse;
      applicationId: string;
      active: RepositoryProfileResponse | null;
      canManage: boolean;
      checkId: string | null;
      onStarted: (checkId: string) => void;
    }>,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { translate, locale, timeZone } = useI18n();
  const phone = useShellViewport() === "phone";
  const offline = useConnectivity() === "offline";
  const archived = repository.archivedAt !== null;
  const starter = useStartCheck(repository, onStarted);

  const check = useQuery({
    ...repositoryCheckQueryOptions(api, scope, repository.id, checkId ?? ""),
    enabled: scope.organizationId !== null && checkId !== null,
  });
  const finished = check.data?.status === "completed" && !check.isError
    ? check.data
    : null;
  const observation = useQuery({
    ...repositoryProfileObservationQueryOptions(
      api,
      scope,
      applicationId,
      finished,
    ),
    enabled: scope.organizationId !== null && finished?.observationId != null &&
      finished.profileId !== null,
  });
  const view = checkView({
    known: checkId !== null,
    onboarding: check.data ?? null,
    readFailed: check.isError,
    observation: observation.data ?? null,
    observationFailed: observation.isError,
  });

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
    if (result.reason === "tool_missing") {
      const tools = missingTools(outcome.host);
      return tools.length === 0
        ? translate(
          "projects.repository.check.reason.toolMissingUnknown" as never,
        )
        : translate("projects.repository.check.reason.toolMissing" as never, {
          tools: tools.join(", "),
        });
    }
    if (result.reason === "unsupported_command" && !result.required) {
      return translate(
        "projects.repository.check.reason.unsupportedCommandOptional" as never,
      );
    }
    return translate(
      `projects.repository.check.reason.${
        CHECK_REASON_KEYS[result.reason]
      }` as never,
    );
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
        onClick={() => {
          void check.refetch();
          void observation.refetch();
        }}
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
    observation.data !== undefined && observation.data.profileId !== active.id
  ) {
    // The result is for another version of the settings than the one in use.
    stepStatus = "unknown";
    label = status("unknown");
    summary = translate("projects.repository.check.otherVersion" as never, {
      checked: observation.data.profileRevision,
      current: active.revision,
    });
    next = run(again, true);
  } else if (view.kind === "result") {
    const { outcome } = view;
    if (outcome.ready) {
      stepStatus = "done";
      label = status("done");
      summary = translate("projects.repository.check.passed" as never, {
        count: outcome.required,
        when: when(outcome.observedAt),
        machine: machine(outcome),
      });
      quiet = run(again, false);
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
    detail = failedList(outcome);
  }

  return (
    <UI.StepItem
      data-testid="setup-check"
      status={stepStatus}
      statusLabel={label}
      title={translate("projects.repository.step.check.title" as never)}
      summary={summary}
      action={phone ? quiet : next ?? quiet}
    >
      {phone ? next : undefined}
      {notice}
      {detail}
    </UI.StepItem>
  );
}
