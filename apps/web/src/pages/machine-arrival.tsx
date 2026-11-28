import { useEffect } from "react";
import type { Translator } from "@bakery/i18n";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  workerEnrollmentQueryOptions,
  workerQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { type AddProgress, addProgress } from "./machine-add.ts";
import { machineLine } from "./MachineList.tsx";
import { type CodingAgent, machineReason } from "./machine-state.ts";

export function useMachineArrival(
  enrollmentId: string | null,
  now: number,
  waitingSince: number,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const organizationId = scope.organizationId;
  const status = useQuery({
    ...workerEnrollmentQueryOptions(api, scope, enrollmentId ?? ""),
    enabled: enrollmentId !== null && Boolean(organizationId),
  });
  const hostId = status.data?.workerHostId ?? null;
  const worker = useQuery({
    ...workerQueryOptions(api, scope, hostId ?? ""),
    enabled: hostId !== null && Boolean(organizationId),
    refetchInterval: 3_000,
  });
  const progress = status.data
    ? addProgress({
      enrollment: status.data,
      worker: worker.data ?? null,
      now,
      waitingSince,
    })
    : null;

  useEffect(() => {
    if (progress?.kind !== "checking" && progress?.kind !== "ready") return;
    for (const family of ["workers.list", "workerEnrollments.list"]) {
      void queryClient.invalidateQueries({
        queryKey: [
          "protected",
          scope.sessionGeneration,
          scope.organizationId ?? "none",
          family,
        ],
      });
    }
  }, [
    progress?.kind,
    queryClient,
    scope.organizationId,
    scope.sessionGeneration,
  ]);

  return { status, worker, hostId, progress };
}

export function MachineArrived(
  { arrival, name, agent, translate, onAnother }: {
    arrival: ReturnType<typeof useMachineArrival>;
    name: string;
    agent: CodingAgent | null;
    translate: Translator;
    onAnother: () => void;
  },
) {
  const navigate = useNavigate();
  const { hostId, worker, progress } = arrival;
  const open = (search: { signIn?: CodingAgent }) => {
    if (hostId === null) return;
    void navigate({
      to: "/machines/$machineId",
      params: { machineId: hostId },
      search,
    });
  };
  const agentName = agent ? translate(`machines.agent.${agent}` as never) : "";
  if (progress?.kind === "ready") {
    return (
      <UI.Stack gap="standard">
        <UI.AlertBanner tone="success" role="status">
          {translate("machines.add.ready" as never, {
            name,
            agent: agentName,
          })}
        </UI.AlertBanner>
        <UI.Inline gap="compact">
          <UI.Button
            variant="primary"
            onClick={() => open(agent ? { signIn: agent } : {})}
          >
            {translate("machines.wizard.install.signInButton" as never, {
              agent: agentName,
            })}
          </UI.Button>
          <UI.Button variant="secondary" onClick={onAnother}>
            {translate("machines.add.another" as never)}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    );
  }
  return (
    <UI.Stack gap="standard">
      <UI.AlertBanner tone="warning" role="status">
        {worker.data && machineReason(worker.data) !== null
          ? machineLine(worker.data, translate)
          : translate("machines.add.attention" as never, { name })}
      </UI.AlertBanner>
      <UI.Inline gap="compact">
        <UI.Button variant="primary" onClick={() => open({})}>
          {translate("machines.add.open" as never, { name })}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
}

export function MachineStatusLine(
  { progress, translate }: { progress: AddProgress; translate: Translator },
) {
  return (
    <UI.Inline gap="compact" data-line="status">
      {progress.kind === "waiting" || progress.kind === "checking"
        ? <UI.Spinner />
        : null}
      <UI.Text
        variant="muted"
        role="status"
        aria-live="polite"
        data-testid="machine-add-status"
      >
        {translate(
          `machines.add.line.${
            progress.kind === "waiting" && progress.stillWaiting
              ? "stillWaiting"
              : progress.kind
          }` as never,
        )}
      </UI.Text>
    </UI.Inline>
  );
}
