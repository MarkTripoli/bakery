import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { WorkflowDefinitionResponse } from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { libraryWorkflowsQueryOptions } from "../../api/query.ts";
import { asyncKindForError } from "../../app/async-state.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  copyName,
  type CopySource,
  NAME_LIMIT,
  uniqueSlug,
} from "./copy-workflow.ts";

/**
 * "Make a copy" of a built-in workflow or of a version of the organization's
 * own (design-ux, #66): a name for the copy, a line saying it starts as a
 * draft that nothing uses until it is published, and then the new workflow's
 * page. The copy is two writes (the workflow, then its draft version); when
 * the second fails the workflow exists, so a retry only adds the steps.
 */
export function MakeCopyDialog(
  { onClose, onMade, source }: {
    readonly source: CopySource;
    readonly onClose: () => void;
    /** Called with the new workflow once it has its draft. */
    readonly onMade: (workflow: WorkflowDefinitionResponse) => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const organizationId = scope.organizationId as string;
  const workflows = useQuery(libraryWorkflowsQueryOptions(api, scope));
  const [name, setName] = useState(
    copyName(source.name, translate("library.copy.suffix" as never)),
  );
  const [tried, setTried] = useState(false);
  // The workflow made by a first attempt whose steps did not save.
  const [made, setMade] = useState<WorkflowDefinitionResponse | null>(null);
  const [failure, setFailure] = useState<
    "failed" | "offline" | "stepsFailed" | null
  >(null);

  const copy = useMutation({
    mutationKey: ["workflows.copy"],
    mutationFn: async () => {
      let workflow = made;
      if (workflow === null) {
        const taken = new Set(
          (workflows.data?.items ?? []).map((row) => row.slug),
        );
        const created = await api.createWorkflow({
          organizationId,
          input: {
            slug: uniqueSlug(name, taken),
            name: name.trim(),
            description: source.description,
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
          definition: source.definition,
          ...(source.sourceYaml === undefined
            ? {}
            : { sourceYaml: source.sourceYaml }),
        },
        idempotencyKey: crypto.randomUUID(),
      });
      if (!version.ok) {
        const error = new Error("version");
        (error as Error & { cause?: unknown }).cause = version.error;
        throw error;
      }
      return workflow;
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["protected"] }),
  });

  const empty = name.trim() === "";
  const submit = async () => {
    setTried(true);
    if (empty) return;
    setFailure(null);
    try {
      onMade(await copy.mutateAsync());
    } catch (error) {
      const cause = error instanceof Error && error.message === "version"
        ? (error as Error & { cause?: unknown }).cause
        : error;
      setFailure(
        asyncKindForError(cause) === "offline"
          ? "offline"
          : error instanceof Error && error.message === "version"
          ? "stepsFailed"
          : "failed",
      );
    }
  };

  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && !copy.isPending && onClose()}
      state={copy.isPending ? "submitting" : "open"}
      title={translate("library.copy.title" as never)}
      variant="form"
    >
      <form
        noValidate
        data-testid="make-copy-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={translate("library.copy.name" as never)}
            htmlFor="workflow-copy-name"
            hint={made !== null
              ? translate("library.copy.locked" as never)
              : undefined}
            required
            error={tried && empty
              ? translate("library.copy.empty" as never)
              : undefined}
          >
            <UI.TextInput
              id="workflow-copy-name"
              name="name"
              type="text"
              autoComplete="off"
              value={name}
              disabled={made !== null}
              invalid={tried && empty || undefined}
              onChange={(value) => setName(value.slice(0, NAME_LIMIT))}
            />
          </UI.Field>
          <UI.Text variant="muted">
            {translate("library.copy.note" as never, {
              version: source.revision,
            })}
          </UI.Text>
          {failure === null ? null : (
            <UI.InlineNotice tone="error">
              {translate(
                (failure === "stepsFailed"
                  ? "library.copy.stepsFailed"
                  : failure === "offline"
                  ? "library.copy.offline"
                  : "library.copy.failed") as never,
                { name: made?.name ?? name.trim() },
              )}
            </UI.InlineNotice>
          )}
          <UI.Inline gap="compact">
            <UI.Button
              variant="secondary"
              disabled={copy.isPending}
              onClick={onClose}
            >
              {translate("core.actions.cancel")}
            </UI.Button>
            <UI.Button
              type="submit"
              variant="primary"
              disabled={copy.isPending}
            >
              {translate(
                (made !== null
                  ? "library.copy.retry"
                  : "library.copy.submit") as never,
              )}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
