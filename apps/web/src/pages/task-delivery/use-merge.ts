import { useCallback, useEffect, useRef, useState } from "react";
import { useBakeryApi } from "../../api/context.tsx";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { commandFailure } from "../task-conversation/model.ts";
import type { MergeView } from "./model.ts";

/**
 * Where a request to merge, or to check an unknown merge again, stands:
 * - `working`: sent, not answered yet;
 * - `conflict`: the pull request moved or someone else started it (409/412);
 * - `forbidden`: this person may not merge here;
 * - `error`: refused for another reason, nothing was started;
 * - `unreachable`: Bakery could not reach GitHub to check, so the outcome is
 *   still unknown;
 * - `notMerged`: a check settled the attempt as not merged, so a merge can be
 *   asked for again;
 * - `noAnswer`: the answer never arrived (a lost connection or a server error),
 *   so the merge may or may not have started. The page says so and reads back
 *   what Bakery recorded; it never says "nothing changed".
 */
export type MergePhase =
  | "idle"
  | "working"
  | "conflict"
  | "forbidden"
  | "error"
  | "unreachable"
  | "notMerged"
  | "noAnswer";

/**
 * Sends the person's request to merge, and the request to check an unknown
 * outcome again. Both are naturally idempotent on the server, so neither can
 * send a second merge: "Check again" only reads GitHub and settles the attempt.
 * `refresh` reads the pull request and its attempts back before a result is
 * reported, so what the page says is always what the server holds. The page
 * sends the pull request's own head and method and never chooses either.
 */
export function useMerge(refresh: () => Promise<void>) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const organizationId = scope.organizationId;
  const [phase, setPhase] = useState<MergePhase>("idle");
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
      if (organizationId === null) return "error";
      setPhase("working");
      const result = await api.mergePullRequest({
        organizationId,
        pullRequestId: view.pullRequestId,
        expectedHeadSha: view.headSha,
        mergeMethod: view.method,
      });
      if (!alive.current) return "idle";
      if (result.ok) {
        // Merged, refused or unknown, the attempt is read back before the page
        // says anything about it.
        await refresh();
        if (!alive.current) return "idle";
        setPhase("idle");
        return "idle";
      }
      const failure = commandFailure(result.error);
      // An answer that never arrived is an unknown outcome: the attempt may
      // exist. Reading it back shows what Bakery recorded, never a second merge.
      const ended: MergePhase = failure === "unknown" ? "noAnswer" : failure;
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
  return { phase, merge, checkAgain, clear };
}
