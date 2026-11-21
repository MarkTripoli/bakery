import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import { routeContinuationsQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { msUntilNextShown, type Offer, shownOffers } from "./model.ts";

/**
 * The offers the task page shows for a run: the choices a step waiting on a
 * model has, once each has waited a minute, oldest first. The run's own
 * `waitingOnModel` is the gate: unless the run says a step waits, nothing is
 * asked and nothing is shown, so a card goes the moment the incident closes. A
 * Viewer is not served the offers; the refused read shows nothing. Any other
 * failed first read is `failed`: the run still waits, so the page keeps its
 * card and offers `retry`.
 */
export function useWaitingOffers(
  { runId, enabled, waitingOnModel }: {
    readonly runId: string;
    readonly enabled: boolean;
    readonly waitingOnModel: boolean | undefined;
  },
): {
  readonly offers: readonly Offer[];
  readonly failed: boolean;
  readonly retrying: boolean;
  readonly retry: () => void;
} {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const gate = enabled && waitingOnModel === true;
  const query = useQuery({
    ...routeContinuationsQueryOptions(api, scope, runId),
    enabled: gate && scope.organizationId !== null,
  });
  const offers = gate ? query.data?.offers : undefined;
  // A tick re-reads the clock when the next hidden card turns a minute old.
  const [tick, setTick] = useState(0);
  const shown = useMemo(
    () => shownOffers(offers ?? [], Date.now()),
    [offers, tick],
  );
  useEffect(() => {
    const wait = msUntilNextShown(offers ?? [], Date.now());
    if (wait === null) return;
    const timer = setTimeout(() => setTick((count) => count + 1), wait + 25);
    return () => clearTimeout(timer);
  }, [offers, tick]);
  const error = query.error;
  const refused = error?.kind === "problem" && error.problem.status === 403;
  const failed = gate && query.data === undefined && error !== null &&
    !refused;
  return {
    offers: shown,
    failed,
    retrying: query.isFetching,
    retry: () => void query.refetch(),
  };
}
