import { useCallback, useEffect, useRef, useState } from "react";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { commandFailure } from "../task-conversation/model.ts";

export type MoreTriesPhase =
  | "idle"
  | "working"
  | "tooMany"
  | "notStopped"
  | "forbidden"
  | "error"
  | "noAnswer";

export function moreTriesFailure(failure: {
  kind: string;
  problem?: {
    status: number;
    retryable: boolean;
    code?: string;
    reason?: string;
  };
}): Exclude<MoreTriesPhase, "idle" | "working"> {
  const ended = commandFailure(failure);
  if (ended === "unknown") return "noAnswer";
  if (ended === "forbidden") return "forbidden";
  if (ended !== "conflict") return "error";
  return failure.problem?.reason === "allowance_exceeds_workflow_maximum"
    ? "tooMany"
    : "notStopped";
}

type Held = Readonly<{ key: string; runId: string; tries: number }>;

export function useMoreTries(runId: string, refresh: () => Promise<void>) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const organizationId = scope.organizationId;
  const [phase, setPhase] = useState<MoreTriesPhase>("idle");
  const alive = useRef(true);
  const held = useRef<Held | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const allow = useCallback(
    async (
      tries: number,
      stillOffered?: () => Promise<boolean>,
    ): Promise<MoreTriesPhase> => {
      if (organizationId === null) return "error";
      const current = held.current;
      const next: Held =
        current !== null && current.runId === runId && current.tries === tries
          ? current
          : { key: crypto.randomUUID(), runId, tries };
      held.current = next;
      setPhase("working");
      if (next !== current && stillOffered && !(await stillOffered())) {
        held.current = null;
        setPhase("notStopped");
        void refresh();
        return "notStopped";
      }
      const result = await api.allowMoreRepairTries({
        organizationId,
        runId,
        tries,
        idempotencyKey: next.key,
      });
      if (!alive.current) return "idle";
      if (result.ok) {
        held.current = null;
        await refresh();
        if (!alive.current) return "idle";
        const ended = result.data.addedTries === tries ? "idle" : "notStopped";
        setPhase(ended);
        return ended;
      }
      const failure = moreTriesFailure(result.error);
      if (failure !== "noAnswer") held.current = null;
      setPhase(failure);
      void refresh();
      return failure;
    },
    [api, organizationId, refresh, runId],
  );

  const clear = useCallback(() => setPhase("idle"), []);
  return { phase, allow, clear };
}
