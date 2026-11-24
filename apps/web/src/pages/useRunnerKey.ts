import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import { backupStatusQueryOptions } from "../api/query.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import type { RunnerKeyView } from "../screens/backups/RunnerKeyDialog.tsx";

export type IssuedKey = {
  readonly generation: number;
  readonly issuedAt: string;
};

const IDLE: RunnerKeyView = { phase: "idle", credential: null };

export function useRunnerKey() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [runnerKey, setRunnerKey] = useState<RunnerKeyView>(IDLE);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  useEffect(() => {
    setRunnerKey(IDLE);
    setIssued(null);
  }, [scope.sessionGeneration]);
  const [issuing, issue] = useSingleFlightSubmit(async () => {
    setRunnerKey({ phase: "issuing", credential: null });
    const started = scope.sessionGeneration;
    const result = await api.backups.issueRunnerCredential();
    if (started !== scope.sessionGeneration) return;
    if (result.ok) {
      setIssued({
        generation: result.data.generation,
        issuedAt: result.data.issuedAt,
      });
      setRunnerKey({ phase: "shown", credential: result.data.credential });
      return;
    }
    setRunnerKey({ phase: "failed", credential: null });
  });
  const done = () => {
    setRunnerKey(IDLE);
    void queryClient.invalidateQueries({
      queryKey: backupStatusQueryOptions(api, scope).queryKey,
    });
  };
  return { runnerKey, issued, issuing, issue, done };
}
