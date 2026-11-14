import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WorkflowDefinitionResponse,
  WorkflowVersionCreate,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { libraryWorkflowsQueryOptions } from "../../api/query.ts";
import { asyncKindForError } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { uniqueSlug } from "./copy-workflow.ts";

/** Why a new draft workflow could not be made, in the words the dialogs have for it. */
export type DraftFailure = "failed" | "offline" | "stepsFailed";

/**
 * Makes a new workflow of the organization with a draft version: two writes
 * (the workflow, then its steps). When the second fails the workflow exists,
 * so a retry only adds the steps. Nothing runs and nothing is published.
 */
export function useCreateDraft() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const organizationId = scope.organizationId as string;
  const workflows = useQuery(libraryWorkflowsQueryOptions(api, scope));
  // The workflow made by a first attempt whose steps did not save.
  const [made, setMade] = useState<WorkflowDefinitionResponse | null>(null);
  const [failure, setFailure] = useState<DraftFailure | null>(null);

  const mutation = useMutation({
    mutationKey: ["workflows.draft"],
    mutationFn: async (
      draft: {
        readonly name: string;
        readonly description: string;
        readonly definition: WorkflowVersionCreate["definition"];
        readonly sourceYaml?: string;
      },
    ) => {
      let workflow = made;
      if (workflow === null) {
        const taken = new Set(
          (workflows.data?.items ?? []).map((row) => row.slug),
        );
        const created = await api.createWorkflow({
          organizationId,
          input: {
            slug: uniqueSlug(draft.name, taken),
            name: draft.name,
            description: draft.description,
          },
          idempotencyKey: crypto.randomUUID(),
        });
        if (!created.ok) throw created.error;
        workflow = created.data;
        setMade(workflow);
      }
      const version = await api.createWorkflowVersion({
        organizationId,
        workflowId: workflow.id,
        input: {
          definition: draft.definition,
          ...(draft.sourceYaml === undefined
            ? {}
            : { sourceYaml: draft.sourceYaml }),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      if (!version.ok) throw new StepsFailed(version.error);
      return workflow;
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });

  return {
    /** The workflow a first attempt made, whose steps may still be missing. */
    made,
    failure,
    pending: mutation.isPending,
    /** Resolves with the new workflow, or null after setting `failure`. */
    create: async (
      draft: Parameters<typeof mutation.mutateAsync>[0],
    ): Promise<WorkflowDefinitionResponse | null> => {
      setFailure(null);
      try {
        return await mutation.mutateAsync(draft);
      } catch (error) {
        const cause = error instanceof StepsFailed ? error.cause : error;
        setFailure(
          asyncKindForError(cause) === "offline"
            ? "offline"
            : error instanceof StepsFailed
            ? "stepsFailed"
            : "failed",
        );
        return null;
      }
    },
  };
}

class StepsFailed extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("steps");
    this.cause = cause;
  }
}
