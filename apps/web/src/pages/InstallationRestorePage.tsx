import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { InstallationRestoreStep } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { installationRestoreQueryOptions } from "../api/query.ts";
import { isForbiddenFailure } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  InstallationRestoreScreen,
  type RestoreProblem,
  type RestoreScreenState,
} from "../screens/InstallationRestoreScreen.tsx";

/**
 * Finish the restore (#64 E3, design-ux): reads the restore that holds the
 * installation and takes its three steps in order. A retry of the same step
 * with the same typed name sends the same Idempotency-Key, so a step that was
 * answered but not seen is never taken twice.
 */
export function InstallationRestorePage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const options = installationRestoreQueryOptions(api, scope);
  const read = useQuery(options);
  const [busyStep, setBusyStep] = useState<InstallationRestoreStep | null>(
    null,
  );
  const [problem, setProblem] = useState<RestoreProblem>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const restore = read.data ?? null;
  const forbidden = read.isError && isForbiddenFailure(read.error as never);
  const state: RestoreScreenState = forbidden
    ? "forbidden"
    : read.isLoading
    ? "loading"
    : read.isError
    ? "error"
    : restore === null
    ? "notHeld"
    : restore.releasedAt !== null
    ? "finished"
    : "ready";

  const take = async (step: InstallationRestoreStep, confirmation: string) => {
    if (busyStep !== null) return;
    const signature = `${step}:${confirmation}`;
    if (attempt.current?.signature !== signature) {
      attempt.current = { signature, key: crypto.randomUUID() };
    }
    setBusyStep(step);
    setProblem(null);
    const result = await api.installationRestore.step({
      step,
      confirmation,
      idempotencyKey: attempt.current.key,
    });
    setBusyStep(null);
    if (result.ok) {
      attempt.current = null;
      // The answer is the restore as it now stands: show it without a second read.
      queryClient.setQueryData(options.queryKey, result.data);
      return;
    }
    const code = result.error.kind === "problem"
      ? result.error.problem.code
      : null;
    const kind = code === "RESTORE_CONFIRMATION_MISMATCH"
      ? "mismatch"
      : code === "RESTORE_STEP_ALREADY_TAKEN"
      ? "alreadyTaken"
      : code === "RESTORE_STEP_OUT_OF_ORDER"
      ? "outOfOrder"
      : code === "RESTORE_NOT_HELD"
      ? "notHeld"
      : "failed";
    setProblem({ step, kind });
    // Someone else moved the restore on: read it again so the page is current.
    if (
      kind === "alreadyTaken" || kind === "outOfOrder" || kind === "notHeld"
    ) {
      void queryClient.invalidateQueries({ queryKey: options.queryKey });
    }
  };

  return (
    <InstallationRestoreScreen
      busyStep={busyStep}
      onOpenAudit={() => void navigate({ to: "/installation/audit" })}
      onRetry={() => void read.refetch()}
      onTakeStep={(step, confirmation) => void take(step, confirmation)}
      problem={problem}
      restore={restore}
      state={state}
    />
  );
}
