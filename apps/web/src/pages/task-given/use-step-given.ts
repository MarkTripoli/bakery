import { useQueries } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import { stepGivenQueryOptions } from "../../api/query.ts";
import { failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";

export type GivenStep = Readonly<{
  id: string;
  stepKey: string;
  status: string;
  startedAt: string | null;
}>;

const AGENT_SESSION_POLL_MS = 5_000;

export function useStepGiven(runId: string, steps: readonly GivenStep[]) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const started = steps.filter((step) => step.startedAt !== null);
  const reads = useQueries({
    queries: started.map((step) => ({
      ...stepGivenQueryOptions(api, scope, {
        runId,
        stepId: step.id,
        stepKey: step.stepKey,
      }),
      refetchInterval: (query: { state: { data?: { ranAnAgent: boolean } } }) =>
        step.status === "running" && query.state.data?.ranAnAgent === false
          ? AGENT_SESSION_POLL_MS
          : false,
    })),
  });
  return new Map(
    started.flatMap((step, index) => {
      const read = reads[index]!;
      const thisPass = read.data?.ranAnAgent === true &&
        read.data.startedAt === step.startedAt;
      const unread = read.isError && read.data === undefined &&
        ![403, 404].includes(failureStatus(read.error) ?? 0);
      return thisPass || unread ? [[step.id, { step, read }] as const] : [];
    }),
  );
}

export type StepGivenOffer = NonNullable<
  ReturnType<ReturnType<typeof useStepGiven>["get"]>
>;
