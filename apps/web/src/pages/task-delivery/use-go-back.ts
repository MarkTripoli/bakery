import { useCallback, useEffect, useRef, useState } from "react";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { commandFailure } from "../task-conversation/model.ts";

export type GoBackPhase =
  | "idle"
  | "working"
  | "notCurrent"
  | "outcomeUnknown"
  | "forbidden"
  | "error"
  | "noAnswer";

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
