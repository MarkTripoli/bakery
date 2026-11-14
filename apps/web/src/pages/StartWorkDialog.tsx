import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { TicketRequestIntent } from "../api/client.ts";
import { failureStatus } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { issueNumber, type IssueRow, issueSnapshot } from "./issue-state.ts";

/** What a refused start says, from the server's answer. */
export type StartRefusal =
  | "notReady"
  | "changed"
  | "unavailable"
  | "notAllowed"
  | "gone"
  | "failed";

/** Maps a failed start to what the person is told: not ready (409), changed since opened (412), GitHub not answering (503). */
export function startRefusal(error: unknown): StartRefusal {
  const status = failureStatus(error);
  if (status === 409) return "notReady";
  if (status === 412) return "changed";
  if (status === 503) return "unavailable";
  if (status === 403) return "notAllowed";
  if (status === 404) return "gone";
  return "failed";
}

/**
 * The confirmation before work starts on an issue, shared by the list and the
 * issue page. "Start work" runs the standard coding workflow; "Plan first"
 * writes a plan and waits for approval. A second press, or a second person,
 * finds the work already under way and is shown that, not an error.
 */
export function StartWorkDialog(
  { intent, onClose, onDone, onRefused, policyRevision, row }: {
    readonly intent: TicketRequestIntent;
    readonly onClose: () => void;
    /** The request was made, or the issue was already being worked on. */
    readonly onDone: () => void;
    readonly onRefused: (refusal: StartRefusal) => void;
    readonly policyRevision: number | null;
    readonly row: IssueRow;
  },
) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const number = issueNumber(row);
  const { repository } = issueSnapshot(row);
  const start = useMutation({
    mutationKey: ["ticketRequests.create"],
    mutationFn: async () => {
      const result = await api.tickets.request({
        organizationId: scope.organizationId as string,
        id: row.id,
        intent,
        expectedSourcePolicyRevision: policyRevision as number,
        requirementsDigest: row.requirementsDigest,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
      onDone();
    },
    onError: (error) => {
      // Refused: read the issue again, so the page shows what is true now (a
      // second press finds the work already under way).
      void queryClient.invalidateQueries({ queryKey: ["protected"] });
      onRefused(startRefusal(error));
    },
  });
  const plan = intent === "plan";
  return (
    <UI.AlertDialog
      open
      onOpenChange={(open) => !open && !start.isPending && onClose()}
      state={start.isPending ? "confirming" : "open"}
      title={translate("issues.start.title" as never, { number: number ?? "" })}
      cancelAction={
        <UI.Button
          variant="secondary"
          disabled={start.isPending}
          onClick={onClose}
        >
          {translate("core.actions.cancel" as never)}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          variant="primary"
          disabled={start.isPending || policyRevision === null}
          aria-busy={start.isPending || undefined}
          onClick={() => start.mutate()}
        >
          {translate(
            (plan
              ? "issues.start.confirmPlan"
              : "issues.start.confirm") as never,
          )}
        </UI.Button>
      }
    >
      <UI.Text>
        {translate(
          (plan ? "issues.start.bodyPlan" : "issues.start.body") as never,
          { repository },
        )}
      </UI.Text>
    </UI.AlertDialog>
  );
}
