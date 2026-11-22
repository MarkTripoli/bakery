import { useCallback, useEffect, useRef, useState } from "react";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { commandFailure } from "../task-conversation/model.ts";
import type { MergeTarget } from "./merge-copy.ts";
import { type MergePhase, queueFailure } from "./merge-refusal.ts";
import { shortSha } from "./model.ts";
import type { MergeView } from "./model.ts";

export type { MergePhase } from "./merge-refusal.ts";
/**
 * Sends the person's request to merge, and the request to check an unknown
 * outcome again. A merge is queued, not sent: Bakery checks that nothing
 * changed since the review, then merges. A repeat of a request whose answer was
 * lost carries the same key, so it can only ever name the same entry; "Check
 * again" only reads GitHub and settles the attempt. `refresh` reads the pull
 * request, its attempts and its queued merges back before a result is reported,
 * so what the page says is always what the server holds. The page sends the
 * pull request's own head and base and never chooses either.
 */
export function useMerge(refresh: () => Promise<void>) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const organizationId = scope.organizationId;
  const [phase, setPhase] = useState<MergePhase>("idle");
  // The branch and commit a refusal's sentence names, kept from the request.
  const [target, setTarget] = useState<MergeTarget | null>(null);
  // The key of a request whose answer was lost, so asking again replays it.
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Resolves to how it ended: `idle` when it was accepted. */
  const merge = useCallback(
    async (view: MergeView): Promise<MergePhase> => {
      if (organizationId === null || view.request === null) return "error";
      setPhase("working");
      setTarget({ branch: view.targetBranch, head: shortSha(view.headSha) });
      const request = view.request;
      const signature = [
        view.pullRequestId,
        view.headSha,
        request.expectedBaseSha,
        request.reviewCycleId,
        ...request.checkRunIds,
      ].join(":");
      if (pending.current?.signature !== signature) {
        pending.current = { signature, key: crypto.randomUUID() };
      }
      const result = await api.createMergeEntry({
        organizationId,
        idempotencyKey: pending.current.key,
        input: {
          pullRequestId: view.pullRequestId,
          repositoryId: request.repositoryId,
          targetBranch: request.targetBranch,
          expectedHeadSha: view.headSha,
          expectedBaseSha: request.expectedBaseSha,
          runId: request.runId,
          policyDigest: request.policyDigest,
          reviewCycleId: request.reviewCycleId,
          checkRunIds: [...request.checkRunIds],
        },
      });
      if (!alive.current) return "idle";
      if (result.ok) {
        pending.current = null;
        // Queued, checking or settled, the entry is read back before the page
        // says anything about it.
        await refresh();
        if (!alive.current) return "idle";
        setPhase("idle");
        return "idle";
      }
      const ended = queueFailure(result.error);
      // Only an answer that never arrived keeps its key: the entry may exist,
      // and asking again must name that same entry. Any answer is final.
      if (ended !== "noAnswer") pending.current = null;
      // Reading it back shows what Bakery recorded, never a second merge.
      void refresh();
      setPhase(ended);
      return ended;
    },
    [api, organizationId, refresh],
  );

  /** Reads GitHub again for an unknown attempt; never sends a second merge. */
  const checkAgain = useCallback(
    async (pullRequestId: string): Promise<MergePhase> => {
      if (organizationId === null) return "error";
      setPhase("working");
      const result = await api.reconcileMergeAttempts({
        organizationId,
        pullRequestId,
      });
      if (!alive.current) return "idle";
      if (!result.ok) {
        const failure = commandFailure(result.error);
        const ended: MergePhase = failure === "unknown" || failure === "error"
          ? "unreachable"
          : failure;
        setPhase(ended);
        return ended;
      }
      await refresh();
      if (!alive.current) return "idle";
      // Settled as merged moves the step on its own; settled as not merged says
      // so once, and the merge can be asked for again.
      const ended: MergePhase = result.data.refused > 0 &&
          result.data.merged === 0
        ? "notMerged"
        : "idle";
      setPhase(ended);
      return ended;
    },
    [api, organizationId, refresh],
  );

  const clear = useCallback(() => setPhase("idle"), []);
  return { phase, target, merge, checkAgain, clear };
}
