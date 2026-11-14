import { useCallback, useEffect, useRef, useState } from "react";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { commandFailure } from "../task-conversation/model.ts";
import type { ApprovalChoice } from "./model.ts";

/**
 * Where a decision on the candidate approval stands:
 * - `deciding`: sent, not answered yet;
 * - `conflict`: someone else decided, or the changes were updated (409/412);
 * - `forbidden`: this person is not allowed to decide it;
 * - `error`: refused for another reason, nothing was recorded;
 * - `unknown`: the answer never arrived, so the server may have applied it.
 */
export type DecisionPhase =
  | "idle"
  | "deciding"
  | "conflict"
  | "forbidden"
  | "error"
  | "unknown";

type Held = Readonly<{
  key: string;
  approvalId: string;
  version: number;
  decision: ApprovalChoice;
  comment: string;
}>;

/**
 * Sends the person's decision on the run's open approval. A retry of the very
 * same decision on the same approval reuses its idempotency key, so a decision
 * whose answer was lost is never recorded twice; any other decision gets a new
 * key. `refresh` reads the approval and the decisions back before a success is
 * reported, so "approved" on screen is always what the server holds.
 */
export function useApprovalDecision(
  approval: Readonly<{ id: string; version: number }> | null,
  refresh: () => Promise<void>,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const organizationId = scope.organizationId;
  const [phase, setPhase] = useState<DecisionPhase>("idle");
  const alive = useRef(true);
  const held = useRef<Held | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const decide = useCallback(
    async (decision: ApprovalChoice, comment: string): Promise<void> => {
      if (organizationId === null || approval === null) return;
      const current = held.current;
      const next: Held =
        current !== null && current.approvalId === approval.id &&
          current.decision === decision && current.comment === comment
          ? current
          : {
            key: crypto.randomUUID(),
            approvalId: approval.id,
            version: approval.version,
            decision,
            comment,
          };
      held.current = next;
      setPhase("deciding");
      const result = await api.decideApproval({
        organizationId,
        approvalId: next.approvalId,
        idempotencyKey: next.key,
        input: {
          decision,
          ...(comment === "" ? {} : { comment }),
          expectedVersion: next.version,
        },
      });
      if (!alive.current) return;
      if (result.ok) {
        held.current = null;
        await refresh();
        if (!alive.current) return;
        setPhase("idle");
        return;
      }
      const failure = commandFailure(result.error);
      if (failure === "unknown") {
        // The server may have applied it: keep the key for a retry and read
        // the current state.
        setPhase("unknown");
        void refresh();
        return;
      }
      held.current = null;
      setPhase(failure);
      void refresh();
    },
    [api, approval, organizationId, refresh],
  );

  return { phase, decide };
}
