import type { MessageArguments, MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useBakeryApi } from "../api/context.tsx";
import {
  machineModelsQueryOptions,
  providerRouteHealthQueryOptions,
  providerRoutesListQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useShellViewport } from "../app/responsive.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { AgentRow } from "./machine-agents.ts";
import { formatMachineDate } from "./MachinesPage.tsx";
import {
  agentOfHarness,
  filterModels,
  modelMuted,
  modelNote,
  modelsEmpty,
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

/** What is known of this machine's sign-ins: still being read, could not be read, or read. */
export type MachineBindings =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "failed" }>
  | Readonly<{ state: "ready"; ids: ReadonlySet<string> }>;

/**
 * The machine page's Models tab (#70 slice 4): every model this machine may use, one state each, and
 * for an administrator a switch that turns one on or off. Work is sent only to the models listed here.
 */
export function MachineModels(
  {
    machineId,
    isAdmin,
    agents,
    bindings,
    retryBindings,
    justAdded,
    signInHref,
  }: {
    readonly machineId: string;
    readonly isAdmin: boolean;
    readonly agents: readonly AgentRow[];
    /**
     * This machine's own coding-agent sign-ins, which are what tie a model to it. Only an
     * administrator can read them; until they are read no list is drawn, never a guess.
     */
    readonly bindings: MachineBindings;
    /** Reads the sign-ins again after they failed to load. */
    readonly retryBindings: () => void;
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
  const phone = useShellViewport() === "phone";
  const list = useQuery({
    ...providerRoutesListQueryOptions(api, scope),
    enabled: isAdmin,
  });
  const own = useQuery({
    ...machineModelsQueryOptions(api, scope, machineId),
    enabled: !isAdmin && Boolean(scope.organizationId),
  });
  const [search, setSearch] = useState("");
  const [agentFilter, setAgentFilter] = useState<CodingAgent | "all">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<"changed" | "failed" | null>(null);

  const served: readonly RouteFacts[] = list.data?.items ?? [];
  const all: RouteFacts[] = !isAdmin
    ? (own.data?.items ?? []).map((model) => ({
      ...model,
      workerBindingId: null,
      version: 0,
    }))
    : bindings.state === "ready"
    ? modelsForMachine(served, bindings.ids)
    : [];
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
  const empty = isAdmin ? modelsEmpty(agents, all.length) : null;
  const read = isAdmin ? list : own;
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

  if (read.isPending || isAdmin && bindings.state === "loading") {
    return (
      <UI.AlertBanner tone="information">
        {say("machines.loading")}
      </UI.AlertBanner>
    );
  }
  if (read.isError || isAdmin && bindings.state === "failed") {
    return (
      <UI.ErrorState
        title={say("machines.models.loadFailed")}
        description=""
        action={
          <UI.Button
            variant="secondary"
            onClick={() => {
              void read.refetch();
              if (isAdmin) retryBindings();
            }}
          >
            {say("machines.models.retry")}
          </UI.Button>
        }
      />
    );
  }

  const stateBadge = (row: RouteFacts) => {
    const state = modelState(row);
    return (
      <UI.Badge tone={modelTone(state)}>
        {say(`machines.models.state.${state}`)}
      </UI.Badge>
    );
  };
  const inUse = (row: RouteFacts) =>
    row.status === "revoked" ? null : (
      <UI.Switch
        checked={row.status === "active"}
        disabled={busyId !== null}
        pending={busyId === row.id}
        onChange={() => void toggle(row)}
      >
        <UI.VisuallyHidden>
          {say("machines.models.use", { model: row.model })}
        </UI.VisuallyHidden>
      </UI.Switch>
    );
  // A model that is not in use is quiet.
  const quiet = (row: RouteFacts, content: ReactNode) =>
    modelMuted(row) ? <UI.Text variant="muted">{content}</UI.Text> : content;
  const agentName = (row: RouteFacts) => {
    const agent = agentOfHarness(row.harness);
    return agent === null ? row.harness : say(`machines.agent.${agent}`);
  };
  const paymentName = (row: RouteFacts) =>
    say(
      `machines.models.payment.${
        row.billingRoute === "api_metered"
          ? "apiKey"
          : row.billingRoute === "local"
          ? "local"
          : "subscription"
      }`,
    );

  return (
    <UI.Stack gap="standard" data-testid="machine-models">
      <UI.Inline variant="between">
        <UI.Text>{say("machines.models.intro")}</UI.Text>
        {isAdmin && empty === null
          ? (
            <UI.Button variant="primary" onClick={add}>
              {say("machines.models.add")}
            </UI.Button>
          )
          : null}
      </UI.Inline>
      {isAdmin ? null : (
        <UI.Text variant="muted">
          {say("machines.models.adminChangeOnly")}
        </UI.Text>
      )}
      {!isAdmin && all.length === 0
        ? (
          <UI.EmptyState
            span="column"
            title={say("machines.models.empty.title")}
            description=""
          />
        )
        : empty === "none"
        ? (
          <UI.EmptyState
            span="column"
            title={say("machines.models.empty.title")}
            description={say("machines.models.empty.body")}
            action={
              <UI.Button variant="primary" onClick={add}>
                {say("machines.models.add")}
              </UI.Button>
            }
          />
        )
        : empty === "signInFirst"
        ? (
          <UI.EmptyState
            span="column"
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
                <FilterRow phone={phone}>
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
                </FilterRow>
              )
              : null}
            {phone
              ? (
                <UI.Stack
                  gap="none"
                  role="list"
                  aria-label={say("machines.models.caption")}
                >
                  {shown.length === 0
                    ? (
                      <UI.Text variant="muted">
                        {say("machines.models.noMatch")}
                      </UI.Text>
                    )
                    : shown.map((row) => {
                      const note = noteLine(row, healthOf(row.id), say, time);
                      return (
                        <div
                          key={row.id}
                          role="listitem"
                          data-model-id={row.id}
                        >
                          <UI.StackedRow
                            title={quiet(row, row.model)}
                            status={
                              <UI.Stack gap="compact">
                                {stateBadge(row)}
                                {isAdmin
                                  ? (
                                    <UI.Inline variant="end">
                                      {inUse(row)}
                                    </UI.Inline>
                                  )
                                  : null}
                              </UI.Stack>
                            }
                          >
                            <UI.Text variant="caption">
                              {say("machines.models.line", {
                                provider: row.provider,
                                agent: agentName(row),
                                payment: paymentName(row),
                              })}
                            </UI.Text>
                            {note
                              ? <UI.Text variant="caption">{note}</UI.Text>
                              : null}
                          </UI.StackedRow>
                        </div>
                      );
                    })}
                </UI.Stack>
              )
              : (
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
                  getRowAttributes={(row) => ({
                    "data-model-id": row.id,
                    "data-muted": String(modelMuted(row)),
                  })}
                  columns={[
                    {
                      id: "model",
                      header: say("machines.models.col.model"),
                      cell: (row) => {
                        const note = noteLine(row, healthOf(row.id), say, time);
                        // A quiet row greys its name too, which the cell's own title cannot do.
                        return modelMuted(row)
                          ? (
                            <UI.Stack gap="none">
                              <UI.Text variant="muted">{row.model}</UI.Text>
                              {note
                                ? <UI.Text variant="caption">{note}</UI.Text>
                                : null}
                            </UI.Stack>
                          )
                          : <UI.CellStack title={row.model} detail={note} />;
                      },
                    },
                    {
                      id: "provider",
                      width: "12%",
                      header: say("machines.models.col.provider"),
                      cell: (row) => quiet(row, row.provider),
                    },
                    {
                      id: "agent",
                      width: "13%",
                      header: say("machines.models.col.agent"),
                      cell: (row) => quiet(row, agentName(row)),
                    },
                    {
                      id: "payment",
                      width: "17%",
                      header: say("machines.models.col.payment"),
                      cell: (row) => quiet(row, paymentName(row)),
                    },
                    {
                      id: "state",
                      width: "17%",
                      header: say("machines.models.col.state"),
                      cell: (row) => stateBadge(row),
                    },
                    ...(isAdmin
                      ? [{
                        id: "inUse",
                        width: "8%",
                        align: "end" as const,
                        header: say("machines.models.col.inUse"),
                        cell: (row: RouteFacts) => inUse(row),
                      }]
                      : []),
                  ]}
                />
              )}
            {turnedOff
              ? (
                <UI.InlineNotice tone="neutral">
                  {say("machines.models.turnedOffNotice", {
                    model: turnedOff.model,
                  })}
                </UI.InlineNotice>
              )
              : null}
            {/* "Added." sits under the list with the other notices. */}
            {justAdded
              ? (
                <UI.InlineNotice tone="success" role="status">
                  {say("machines.models.added")}
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
          </>
        )}
    </UI.Stack>
  );
}

/** The search and the filter: one row on a desktop; on a phone each has the whole column, like every field. */
function FilterRow(
  { phone, children }: {
    readonly phone: boolean;
    readonly children: ReactNode;
  },
) {
  return phone
    ? (
      <UI.Stack gap="standard" data-testid="machine-models-filters">
        {children}
      </UI.Stack>
    )
    : <UI.Inline gap="standard">{children}</UI.Inline>;
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
  if (note.kind === "revoked") return say("machines.models.note.revoked");
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
