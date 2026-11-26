import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import type { TicketRequestIntent } from "../api/client.ts";
import { failureStatus } from "../app/async-state.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { issueNumber, type IssueRow, issueSnapshot } from "./issue-state.ts";
import { SOURCE_WORKFLOW_CHOICE, TICKET_PRESETS } from "./issue-sources.ts";
import { presetCopy } from "./task-composer-labels.ts";
import { WorkflowChoice } from "./WorkflowChoice.tsx";
import { useSourceWorkflow } from "./issues/use-source-workflow.ts";

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
 * issue page. It names the built-in workflow the repository runs and lets the
 * person run the other one for this issue only; "Plan first" writes a plan and
 * waits for approval. A second press, or a second person, finds the work
 * already under way and is shown that, not an error.
 */
export function StartWorkDialog(
  { intent, onClose, onDone, onRefused, policyRevision, row, sourcePolicy }: {
    readonly intent: TicketRequestIntent;
    readonly onClose: () => void;
    /** The request was made, or the issue was already being worked on. */
    readonly onDone: () => void;
    readonly onRefused: (refusal: StartRefusal) => void;
    readonly policyRevision: number | null;
    readonly row: IssueRow;
    readonly sourcePolicy: unknown;
  },
) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const number = issueNumber(row);
  const { repository } = issueSnapshot(row);
  const source = useSourceWorkflow(sourcePolicy);
  const sourceChoice = source.kind === "builtIn"
    ? source.preset
    : source.kind === "written"
    ? SOURCE_WORKFLOW_CHOICE
    : null;
  const [choice, setChoice] = useState<string | null>(sourceChoice);
  const preset = TICKET_PRESETS.find((id) => id === choice) ?? null;
  const [attempts, setAttempts] = useState(0);
  const tried = attempts > 0;
  const fieldId = useId();
  useEffect(() => {
    if (attempts === 0) return;
    document.getElementById(fieldId)?.focus();
  }, [attempts, fieldId]);
  const start = useMutation({
    mutationKey: ["ticketRequests.create"],
    mutationFn: async () => {
      if (choice === null) throw new Error("no workflow chosen");
      const result = await api.tickets.request({
        organizationId: scope.organizationId as string,
        id: row.id,
        intent,
        expectedSourcePolicyRevision: policyRevision as number,
        requirementsDigest: row.requirementsDigest,
        ...(choice === sourceChoice || preset === null ? {} : { preset }),
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
          onClick={() => {
            if (choice === null) {
              setAttempts((count) => count + 1);
              return;
            }
            start.mutate();
          }}
        >
          {translate(
            (plan
              ? "issues.start.confirmPlan"
              : "issues.start.confirm") as never,
          )}
        </UI.Button>
      }
    >
      <UI.Stack gap="standard">
        <UI.Text>
          {translate(
            (plan ? "issues.start.bodyPlan" : "issues.start.body") as never,
            { repository },
          )}
        </UI.Text>
        <UI.Stack gap="compact" data-testid="start-work-workflow">
          <WorkflowChoice
            disabled={start.isPending}
            error={tried && choice === null
              ? translate("issues.start.workflowRequired" as never)
              : undefined}
            id={fieldId}
            items={[
              ...(source.kind === "written"
                ? [{
                  id: SOURCE_WORKFLOW_CHOICE,
                  title: source.name,
                  description: source.description,
                }]
                : []),
              ...TICKET_PRESETS.map((id) => ({
                id,
                title: presetCopy(translate, id).title,
                description: presetCopy(translate, id).description,
              })),
            ]}
            label={translate("issues.start.workflow" as never)}
            onChange={(id) => setChoice(id === "" ? null : id)}
            placeholder={translate("issues.start.workflowPlaceholder" as never)}
            value={choice ?? ""}
          />
          <UI.Text variant="caption">
            {source.kind === "none"
              ? translate("issues.start.workflowUnsetHelp" as never, {
                repository,
              })
              : translate("issues.start.workflowHelp" as never, {
                repository,
                workflow: source.name,
              })}
          </UI.Text>
        </UI.Stack>
      </UI.Stack>
    </UI.AlertDialog>
  );
}
