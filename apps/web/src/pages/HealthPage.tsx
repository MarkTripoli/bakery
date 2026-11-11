import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { ApiFailure } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { readinessQueryOptions } from "../api/query.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function HealthPage() {
  const client = useBakeryApi();
  const { translate } = useI18n();
  const readiness = useQuery(readinessQueryOptions(client));

  if (readiness.isPending) {
    return (
      <UI.Stack
        aria-label={translate("shell.health.checking")}
        data-testid="health-loading"
        gap="spacious"
      >
        <UI.Heading level="page" tabIndex={-1}>
          {translate("shell.health.title")}
        </UI.Heading>
        <UI.Skeleton shape="text" />
        <UI.Skeleton shape="surface" />
      </UI.Stack>
    );
  }

  if (readiness.isError) {
    const failure = readiness.error as ApiFailure;
    const description = failure.kind === "network"
      ? translate("shell.health.offline")
      : failure.kind === "invalid-response"
      ? translate("shell.health.invalidResponse")
      : translate("problems.UNKNOWN.description");
    return (
      <UI.ErrorState
        action={
          <UI.Button
            busy={readiness.isFetching}
            onClick={() => void readiness.refetch()}
          >
            {translate("core.actions.checkAgain")}
          </UI.Button>
        }
        data-testid="health-error"
        description={
          <UI.Stack gap="compact">
            <UI.Text>{description}</UI.Text>
            {failure.kind === "problem"
              ? (
                <>
                  <UI.DataText>
                    {translate("problems.UNKNOWN.requestId", {
                      requestId: failure.problem.requestId,
                    })}
                  </UI.DataText>
                  <UI.DataText>
                    {translate("problems.UNKNOWN.traceId", {
                      traceId: failure.problem.traceId,
                    })}
                  </UI.DataText>
                </>
              )
              : null}
          </UI.Stack>
        }
        state={readiness.isFetching ? "retrying" : "default"}
        title={failure.kind === "network"
          ? translate("shell.states.offlineTitle")
          : translate("shell.states.errorTitle")}
        variant="page"
      />
    );
  }

  const state = readiness.data.state;
  const status = state === "ok"
    ? "healthy"
    : state === "degraded"
    ? "degraded"
    : "disconnected";
  return (
    <UI.Stack data-testid="health-ready" gap="spacious">
      <UI.Heading level="page" tabIndex={-1}>
        {translate("shell.health.title")}
      </UI.Heading>
      <UI.Text>{translate("shell.health.description")}</UI.Text>
      {state === "unavailable"
        ? (
          <UI.AlertBanner tone="error">
            {translate("shell.health.unavailable")}
          </UI.AlertBanner>
        )
        : null}
      {readiness.isFetching
        ? (
          <UI.InlineNotice tone="information">
            {translate("shell.states.reconnectingDescription")}
          </UI.InlineNotice>
        )
        : null}
      <UI.StatusLabel status={status}>
        {translate(
          state === "ok"
            ? "shell.health.ready"
            : state === "degraded"
            ? "shell.health.degraded"
            : "shell.health.unavailable",
        )}
      </UI.StatusLabel>
      <UI.DataText>
        {translate("shell.health.version", { version: readiness.data.version })}
      </UI.DataText>
      {readiness.data.dependencies.length
        ? (
          <UI.Stack gap="compact">
            <UI.Heading level="section">
              {translate("shell.health.dependencies")}
            </UI.Heading>
            {readiness.data.dependencies.map((dependency) => (
              <UI.Inline key={dependency.name}>
                <UI.DataText>{dependency.name}</UI.DataText>
                <UI.StatusLabel
                  status={dependency.state === "ok"
                    ? "healthy"
                    : dependency.state === "degraded"
                    ? "degraded"
                    : "disconnected"}
                >
                  {dependency.state}
                </UI.StatusLabel>
                <UI.DataText>{dependency.reason}</UI.DataText>
              </UI.Inline>
            ))}
          </UI.Stack>
        )
        : null}
    </UI.Stack>
  );
}
