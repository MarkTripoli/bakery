import { useRouterState } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  type ShellFixtureState,
  shellFixtureStates,
} from "../routes/route-states.ts";

function currentFixtureState(pathname: string): ShellFixtureState {
  const state = pathname.split("/").at(-1);
  return shellFixtureStates.includes(state as ShellFixtureState)
    ? state as ShellFixtureState
    : "error";
}

export function ShellStateFixture() {
  const { translate } = useI18n();
  const state = useRouterState({
    select: (routerState) => currentFixtureState(routerState.location.pathname),
  });
  const title = state === "loading"
    ? translate("shell.states.loadingTitle")
    : state === "empty"
    ? translate("shell.states.emptyTitle")
    : state === "forbidden"
    ? translate("shell.states.forbiddenTitle")
    : state === "conflict"
    ? translate("shell.states.conflictTitle")
    : state === "stale"
    ? translate("shell.states.staleTitle")
    : state === "offline"
    ? translate("shell.states.offlineTitle")
    : state === "reconnecting"
    ? translate("shell.states.reconnectingTitle")
    : state === "busy"
    ? translate("shell.states.busyTitle")
    : state === "long-copy"
    ? translate("shell.states.worstCaseTitle")
    : translate("shell.states.errorTitle");

  return (
    <UI.Stack data-testid="synthetic-fixture" gap="spacious">
      <UI.StatusLabel status="queued">
        {translate("shell.states.fixtureLabel")}
      </UI.StatusLabel>
      <UI.Heading level="page" tabIndex={-1}>{title}</UI.Heading>
      {state === "loading"
        ? (
          <>
            <UI.Skeleton shape="text" />
            <UI.Skeleton shape="surface" />
          </>
        )
        : state === "empty"
        ? (
          <UI.EmptyState
            description={translate("shell.states.emptyDescription")}
            title={translate("shell.states.emptyTitle")}
          />
        )
        : state === "error"
        ? (
          <UI.ErrorState
            description={translate("shell.states.errorDescription")}
            title={translate("shell.states.errorTitle")}
          />
        )
        : state === "forbidden"
        ? (
          <UI.ErrorState
            description={translate("shell.states.forbiddenDescription")}
            title={translate("shell.states.forbiddenTitle")}
          />
        )
        : state === "conflict"
        ? (
          <UI.AlertBanner
            action={<UI.Button>{translate("core.actions.retry")}</UI.Button>}
            tone="warning"
          >
            {translate("shell.states.conflictDescription")}
          </UI.AlertBanner>
        )
        : state === "stale"
        ? (
          <UI.InlineNotice tone="warning">
            {translate("shell.states.staleDescription")}
          </UI.InlineNotice>
        )
        : state === "offline"
        ? (
          <UI.AlertBanner tone="error">
            {translate("shell.states.offlineDescription")}
          </UI.AlertBanner>
        )
        : state === "reconnecting"
        ? (
          <UI.InlineNotice tone="information">
            {translate("shell.states.reconnectingDescription")}
          </UI.InlineNotice>
        )
        : state === "busy"
        ? <UI.Button busy>{translate("core.actions.open")}</UI.Button>
        : state === "long-copy"
        ? <UI.Text>{translate("shell.states.worstCaseDescription")}</UI.Text>
        : <UI.Text>{translate("shell.states.errorDescription")}</UI.Text>}
    </UI.Stack>
  );
}
