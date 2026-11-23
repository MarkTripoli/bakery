import { useCallback, useEffect, useRef, useState } from "react";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { commandFailure } from "../task-conversation/model.ts";

/**
 * Where a request to go back to the last release stands:
 * - `working`: sent, not answered yet;
 * - `notCurrent`: a newer release replaced this one (`not_current_release`);
 * - `outcomeUnknown`: Bakery cannot tell whether the release finished
 *   (`outcome_unknown`), so it cannot go back yet;
 * - `forbidden`: this person may not deploy this repository;
 * - `error`: refused for another reason, nothing was started;
 * - `noAnswer`: the answer never arrived, so going back may have started.
 */
export type GoBackPhase =
  | "idle"
  | "working"
  | "notCurrent"
  | "outcomeUnknown"
  | "forbidden"
  | "error"
  | "noAnswer";

/** How a refused or failed request to go back reads. */
export function goBackFailure(failure: {
  kind: string;
  problem?: {
    status: number;
    retryable: boolean;
    code?: string;
    reason?: string;
  };
}): Exclude<GoBackPhase, "idle" | "working"> {
  const ended = commandFailure(failure);
  if (ended === "unknown") return "noAnswer";
  if (ended === "forbidden") return "forbidden";
  if (ended !== "conflict") return "error";
  const reason = failure.problem?.reason;
  return reason === "not_current_release"
    ? "notCurrent"
    : reason === "outcome_unknown"
    ? "outcomeUnknown"
    : "error";
}

type Held = Readonly<{ key: string; deploymentId: string; reason: string }>;

/**
 * Asks Bakery to put the environment back on the release before this one. A
 * retry of the same request reuses its idempotency key, so one whose answer
 * was lost is never sent twice. `refresh` reads the releases back before a
 * success is reported. It resolves to how the request ended: `idle` when it was
 * accepted, else the failure, so the dialog can stay open for a retry.
 */
export function useGoBack(refresh: () => Promise<void>) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const organizationId = scope.organizationId;
  const [phase, setPhase] = useState<GoBackPhase>("idle");
  const alive = useRef(true);
  const held = useRef<Held | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const goBack = useCallback(
    async (deploymentId: string, reason: string): Promise<GoBackPhase> => {
      if (organizationId === null) return "error";
      const current = held.current;
      const next: Held =
        current !== null && current.deploymentId === deploymentId &&
          current.reason === reason
          ? current
          : { key: crypto.randomUUID(), deploymentId, reason };
      held.current = next;
      setPhase("working");
      const result = await api.rollbackDeployment({
        organizationId,
        deploymentId,
        reason,
        idempotencyKey: next.key,
      });
      if (!alive.current) return "idle";
      if (result.ok) {
        held.current = null;
        await refresh();
        if (!alive.current) return "idle";
        setPhase("idle");
        return "idle";
      }
      const failure = goBackFailure(result.error);
      // An answer that never arrived keeps its key, so a retry is the same request.
      if (failure !== "noAnswer") held.current = null;
      setPhase(failure);
      void refresh();
      return failure;
    },
    [api, organizationId, refresh],
  );

  const clear = useCallback(() => setPhase("idle"), []);
  return { phase, goBack, clear };
}
