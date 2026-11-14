import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WorkflowDefinitionResponse,
  WorkflowVersionCreate,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { libraryWorkflowsQueryOptions } from "../../api/query.ts";
import { asyncKindForError, failureStatus } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { uniqueSlug } from "./copy-workflow.ts";

/**
 * Why a new draft workflow could not be made, so a dialog can say what to do:
 * not allowed, the name is taken or not accepted (both are the name field's),
 * the server is busy or failing, there was no answer, or the workflow was
 * made but its steps were not.
 */
export type DraftFailure =
  | "forbidden"
  | "nameTaken"
  | "nameRejected"
  | "busy"
  | "offline"
  | "stepsFailed";

/** The failure of the first write (the workflow) in the words a person can act on. */
export function firstWriteFailure(error: unknown): DraftFailure {
  if (asyncKindForError(error) === "offline") return "offline";
  switch (failureStatus(error)) {
    case 403:
      return "forbidden";
    case 409:
      return "nameTaken";
    case 422:
      return "nameRejected";
    default:
      return "busy";
  }
}

/**
 * Whether the server may have done the write although the answer was lost: no
 * answer at all, or a server fault. A definite refusal (a 4xx) did not happen,
 * so the retry is a new intent and takes a new key.
 */
export function outcomeUnknown(error: unknown): boolean {
  const status = failureStatus(error);
  return status === null || status >= 500;
}

/** The write a retry repeats: its idempotency key, kept until the write is answered. */
type Intent = { readonly signature: string; readonly key: string };

/**
 * Makes a new workflow of the organization with a draft version: two writes
 * (the workflow, then its steps). When the second fails the workflow exists,
 * so a retry only adds the steps. Each write keeps one idempotency key for as
 * long as its outcome is unknown, so a retry after a lost answer cannot make a
 * second workflow or a second draft. Nothing runs and nothing is published.
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
  const workflowIntent = useRef<(Intent & { readonly slug: string }) | null>(
    null,
  );
  const versionIntent = useRef<Intent | null>(null);

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
        // The same name and description are the same intent: the same key
        // and the same address, even if the list has changed meanwhile.
        const signature = JSON.stringify([draft.name, draft.description]);
        if (workflowIntent.current?.signature !== signature) {
          const taken = new Set(
            (workflows.data?.items ?? []).map((row) => row.slug),
          );
          workflowIntent.current = {
            signature,
            key: crypto.randomUUID(),
            slug: uniqueSlug(draft.name, taken),
          };
        }
        const intent = workflowIntent.current;
        const created = await api.createWorkflow({
          organizationId,
          input: {
            slug: intent.slug,
            name: draft.name,
            description: draft.description,
          },
          idempotencyKey: intent.key,
        });
        if (!created.ok) {
          if (!outcomeUnknown(created.error)) workflowIntent.current = null;
          throw new FirstWriteFailed(created.error);
        }
        workflowIntent.current = null;
        workflow = created.data;
        setMade(workflow);
      }
      const signature = JSON.stringify([draft.definition, draft.sourceYaml]);
      if (versionIntent.current?.signature !== signature) {
        versionIntent.current = { signature, key: crypto.randomUUID() };
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
        idempotencyKey: versionIntent.current.key,
      });
      if (!version.ok) {
        if (!outcomeUnknown(version.error)) versionIntent.current = null;
        throw new StepsFailed(version.error);
      }
      versionIntent.current = null;
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
        if (error instanceof StepsFailed) {
          setFailure(
            asyncKindForError(error.cause) === "offline"
              ? "offline"
              : "stepsFailed",
          );
        } else {
          setFailure(
            firstWriteFailure(
              error instanceof FirstWriteFailed ? error.cause : error,
            ),
          );
        }
        return null;
      }
    },
    /** Clears the failure, as when the person edits the name that was refused. */
    clearFailure: () => setFailure(null),
  };
}

class StepsFailed extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("steps");
    this.cause = cause;
  }
}

class FirstWriteFailed extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("workflow");
    this.cause = cause;
  }
}
