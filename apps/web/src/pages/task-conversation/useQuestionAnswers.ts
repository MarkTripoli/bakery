import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import { commandFailure } from "./model.ts";
import type { QuestionPhase } from "./QuestionAnswer.tsx";

/** Query names a task read refreshes after a command settles. */
export const TASK_READS = new Set([
  "conversationParticipants.list",
  "coordinationPlans.list",
  "messages.list",
  "conversationTurns.list",
  "planRevisions.list",
  "approvals.list",
  "questions.list",
  "tasks.get",
  "tasks.list",
]);

type PendingAnswer = {
  key: string;
  input: { optionId?: string; text?: string };
};

/**
 * Answer durable questions through `questions.answer`. One idempotency key is
 * kept per question until the request settles, so an uncertain retry resends
 * the same command. Shared by the conversation page and the work queue
 * inspector; both re-read the task reads afterwards.
 */
export function useQuestionAnswers(
  organizationId: string | null,
  refresh?: () => void | Promise<unknown>,
) {
  const api = useBakeryApi();
  const cache = useQueryClient();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [phases, setPhases] = useState<Record<string, QuestionPhase>>({});
  const pending = useRef<Record<string, PendingAnswer>>({});
  const reread = () =>
    refresh?.() ?? cache.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === "protected" && queryKey[2] === organizationId &&
        TASK_READS.has(String(queryKey[3])),
    });
  const answer = async (
    id: string,
    input: { optionId?: string; text?: string },
  ) => {
    if (organizationId === null) return;
    const next = pending.current[id] ?? { key: crypto.randomUUID(), input };
    pending.current[id] = next;
    setPhases((current) => ({ ...current, [id]: "sending" }));
    const result = await api.answerQuestion({
      organizationId,
      questionId: id,
      idempotencyKey: next.key,
      input: { answer: next.input },
    });
    if (!alive.current) return;
    if (result.ok) {
      delete pending.current[id];
      setPhases((current) => ({ ...current, [id]: "idle" }));
      void reread();
      return;
    }
    const failure = commandFailure(result.error);
    if (failure === "unknown") {
      return setPhases((current) => ({ ...current, [id]: "unknown" }));
    }
    delete pending.current[id];
    setPhases((current) => ({
      ...current,
      [id]: failure === "conflict"
        ? "conflict"
        : failure === "forbidden"
        ? "forbidden"
        : "error",
    }));
    void reread();
  };
  const retry = (id: string) => {
    const waiting = pending.current[id];
    if (waiting) void answer(id, waiting.input);
  };
  return { phases, answer, retry };
}
