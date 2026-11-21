import type { MessageArguments, MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useBakeryApi } from "../api/context.tsx";
import {
  providerRouteHealthQueryOptions,
  providerRoutesListQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { AgentRow } from "./machine-agents.ts";
import { formatMachineDate } from "./MachinesPage.tsx";
import {
  agentOfHarness,
  canSwitch,
  filterModels,
  modelNote,
  modelsEmpty,
  modelsForAgents,
  modelsForMachine,
  modelState,
  modelTone,
  needsFilters,
  needsHealthRead,
  type RouteFacts,
  statusAfterSwitch,
  turnedOffNotice,
  updateRefusal,
} from "./machine-models.ts";
import type { CodingAgent } from "./machine-state.ts";

type Say = (key: string, arguments_?: MessageArguments) => string;

/**
 * The machine page's Models tab (#70 slice 4): every model this machine may use, one state each, and
 * for an administrator a switch that turns one on or off. Work is sent only to the models listed here.
 */
export function MachineModels(
  { machineId, isAdmin, agents, advertised, bindingIds, justAdded, signInHref }:
    {
      readonly machineId: string;
      readonly isAdmin: boolean;
      readonly agents: readonly AgentRow[];
      /** The coding agents the machine advertises, used where its sign-ins cannot be read. */
      readonly advertised: readonly CodingAgent[];
      /** The ids of this machine's own coding-agent sign-ins, or null where they cannot be read. */
      readonly bindingIds: ReadonlySet<string> | null;
      /** True once the page was reached from a saved model, which says so once. */
      readonly justAdded: boolean;
      /** Where the person goes to sign a coding agent in. */
      readonly signInHref: string;
    },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { translate, locale, timeZone } = useI18n();
  const say: Say = (key, arguments_) =>
    translate(key as MessageKey, arguments_);
  const list = useQuery(providerRoutesListQueryOptions(api, scope));
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState<CodingAgent | "all">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<"changed" | "failed" | null>(null);

  const served = (list.data?.items ?? []) as unknown as RouteFacts[];
  const all: RouteFacts[] = bindingIds === null
    ? modelsForAgents(served, advertised)
    : modelsForMachine(served, bindingIds);
  // A reason is read only for a model that is in trouble: the others have nothing to say.
  const troubled = all.filter(needsHealthRead);
  const health = useQueries({
    queries: troubled.map((route) =>
      providerRouteHealthQueryOptions(api, scope, route.id)
    ),
  });
  const healthOf = (id: string) => {
    const index = troubled.findIndex((route) => route.id === id);
    const data = index < 0 ? undefined : health[index]?.data;
    return data === undefined
      ? null
      : { reason: data.reason ?? null, reasonSince: data.reasonSince ?? null };
  };

  const filtering = needsFilters(all.length);
  const shown = filtering
    ? filterModels(all, { search, agent: agentFilter })
    : all;
  const empty = modelsEmpty(agents, all.length);
  const turnedOff = turnedOffNotice(all);
  const time = (value: string) =>
    formatMachineDate(value, locale, timeZone, say("machines.never"));

  const toggle = async (route: RouteFacts) => {
    if (!scope.organizationId) return;
    setBusyId(route.id);
    setProblem(null);
    const result = await api.providerRoutes.update({
      organizationId: scope.organizationId,
      id: route.id,
      input: { status: statusAfterSwitch(route) },
      version: route.version,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setProblem(
        updateRefusal(
          result.error.kind === "problem" ? result.error.problem : null,
        ),
      );
    }
    // Whether it worked or someone else got there first, the list shown is the latest one.
    await queryClient.invalidateQueries({
      queryKey: [
        "protected",
        scope.sessionGeneration,
        scope.organizationId ?? "none",
        "providerRoutes.list",
      ],
    });
    setBusyId(null);
  };

  const add = () =>
    void navigate({
      to: "/machines/$machineId/models/new",
      params: { machineId },
    });

  if (list.isPending) {
    return (
      <UI.AlertBanner tone="information">
        {say("machines.loading")}
      </UI.AlertBanner>
    );
  }
  if (list.isError) {
    return (
      <UI.ErrorState
        title={say("machines.models.loadFailed")}
        description=""
        action={
          <UI.Button
            variant="secondary"
            onClick={() => void list.refetch()}
          >
            {say("machines.models.retry")}
          </UI.Button>
        }
      />
    );
  }

  return (
    <UI.Stack gap="standard" data-testid="machine-models">
      <UI.Text>{say("machines.models.intro")}</UI.Text>
      {justAdded
        ? (
          <UI.InlineNotice tone="success" role="status">
            {say("machines.models.added")}
          </UI.InlineNotice>
        )
        : null}
      {isAdmin && empty === null
        ? (
          <UI.Inline variant="flow">
            <UI.Button variant="primary" onClick={add}>
              {say("machines.models.add")}
            </UI.Button>
          </UI.Inline>
        )
        : null}
      {empty === "none"
        ? (
          <UI.EmptyState
            title={say("machines.models.empty.title")}
            description={say("machines.models.empty.body")}
            action={isAdmin
              ? (
                <UI.Button variant="primary" onClick={add}>
                  {say("machines.models.add")}
                </UI.Button>
              )
              : undefined}
          />
        )
        : empty === "signInFirst"
        ? (
          <UI.EmptyState
            title={say("machines.models.signInFirst.title")}
            description={say("machines.models.signInFirst.body")}
            action={
              <UI.Button
                variant="primary"
                onClick={() => void navigate({ href: signInHref })}
              >
                {say("machines.models.signInFirst.action")}
              </UI.Button>
            }
          />
        )
        : (
          <>
            {filtering
              ? (
                <UI.Inline gap="standard">
                  <UI.SearchField
                    id="machine-models-search"
                    name="machine-models-search"
                    aria-label={say("machines.models.search")}
                    placeholder={say("machines.models.search")}
                    value={search}
                    onChange={(event) => setSearch(event.currentTarget.value)}
                  />
                  <UI.Combobox
                    appearance="filter"
                    label={say("machines.models.filterAgent")}
                    value={agentFilter}
                    onChange={(event) =>
                      setAgentFilter(event.target.value as CodingAgent | "all")}
                    options={[
                      {
                        value: "all",
                        label: say("machines.models.allAgents"),
                      },
                      ...(["claude", "codex", "pi"] as const).map((agent) => ({
                        value: agent,
                        label: say(`machines.agent.${agent}`),
                      })),
                    ]}
                  />
                </UI.Inline>
              )
              : null}
            <UI.DataTable<RouteFacts>
              caption={say("machines.models.caption")}
              captionHidden
              variant="ruled"
              inset="edge"
              rowSize="double"
              rows={shown}
              state="ready"
              emptyMessage={say("machines.models.noMatch")}
              getRowKey={(row) => row.id}
              getRowAttributes={(row) => ({ "data-model-id": row.id })}
              columns={[
                {
                  id: "model",
                  header: say("machines.models.col.model"),
                  cell: (row) => (
                    <UI.CellStack
                      title={row.model}
                      detail={noteLine(row, healthOf(row.id), say, time)}
                    />
                  ),
                },
                {
                  id: "provider",
                  header: say("machines.models.col.provider"),
                  cell: (row) => row.provider,
                },
                {
                  id: "agent",
                  header: say("machines.models.col.agent"),
                  cell: (row) => {
                    const agent = agentOfHarness(row.harness);
                    return agent === null
                      ? row.harness
                      : say(`machines.agent.${agent}`);
                  },
                },
                {
                  id: "payment",
                  header: say("machines.models.col.payment"),
                  cell: (row) =>
                    say(
                      `machines.models.payment.${
                        row.billingRoute === "api_metered"
                          ? "apiKey"
                          : row.billingRoute === "local"
                          ? "local"
                          : "subscription"
                      }`,
                    ),
                },
                {
                  id: "state",
                  header: say("machines.models.col.state"),
                  cell: (row) => {
                    const state = modelState(row);
                    return (
                      <UI.Badge tone={modelTone(state)}>
                        {say(`machines.models.state.${state}`)}
                      </UI.Badge>
                    );
                  },
                },
                ...(isAdmin
                  ? [{
                    id: "inUse",
                    align: "end" as const,
                    header: say("machines.models.col.inUse"),
                    cell: (row: RouteFacts) => (
                      <UI.Switch
                        checked={row.status === "active"}
                        disabled={!canSwitch(row, isAdmin) || busyId !== null}
                        pending={busyId === row.id}
                        onChange={() => void toggle(row)}
                      >
                        <UI.VisuallyHidden>
                          {say("machines.models.use", { model: row.model })}
                        </UI.VisuallyHidden>
                      </UI.Switch>
                    ),
                  }]
                  : []),
              ]}
            />
            {turnedOff
              ? (
                <UI.InlineNotice tone="neutral">
                  {say("machines.models.turnedOffNotice", {
                    model: turnedOff.model,
                  })}
                </UI.InlineNotice>
              )
              : null}
            {problem === "changed"
              ? (
                <UI.InlineNotice tone="warning" role="status">
                  {say("machines.models.changed")}
                </UI.InlineNotice>
              )
              : problem === "failed"
              ? (
                <UI.InlineNotice tone="error" role="alert">
                  {say("machines.models.switchFailed")}
                </UI.InlineNotice>
              )
              : null}
            {!isAdmin
              ? (
                <UI.Text variant="muted">
                  {say("machines.models.adminOnly")}
                </UI.Text>
              )
              : null}
          </>
        )}
    </UI.Stack>
  );
}

/** The muted line under a model's name: why it is in trouble, or when it last answered. */
function noteLine(
  route: RouteFacts,
  health: { reason: string | null; reasonSince: string | null } | null,
  say: Say,
  time: (value: string) => string,
): string | undefined {
  const note = modelNote(route, health);
  if (note.kind === "answered") {
    return say("machines.models.note.answered", {
      time: time(note.at),
    });
  }
  if (note.kind === "trouble") {
    const reason = say(`machines.models.reason.${note.reason}`);
    return note.since === null
      ? say("machines.models.note.troubleNoTime", { reason })
      : say("machines.models.note.trouble", {
        reason,
        time: time(note.since),
      });
  }
  return undefined;
}
