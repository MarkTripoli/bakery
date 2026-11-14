import { useState } from "react";
import * as UI from "@bakery/ui";
import type { WorkflowDefinitionResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { copyName, type CopySource, NAME_LIMIT } from "./copy-workflow.ts";
import { useCreateDraft } from "./use-create-draft.ts";

/**
 * "Make a copy" of a built-in workflow or of a version of the organization's
 * own (design-ux, #66): a name for the copy, a line saying it starts as a
 * draft that nothing uses until it is published, and then the new workflow's
 * page.
 */
export function MakeCopyDialog(
  { onClose, onMade, source }: {
    readonly source: CopySource;
    readonly onClose: () => void;
    /** Called with the new workflow once it has its draft. */
    readonly onMade: (workflow: WorkflowDefinitionResponse) => void;
  },
) {
  const { translate } = useI18n();
  const draft = useCreateDraft();
  const [name, setName] = useState(
    copyName(source.name, translate("library.copy.suffix" as never)),
  );
  const [tried, setTried] = useState(false);

  const empty = name.trim() === "";
  const submit = async () => {
    setTried(true);
    if (empty) return;
    const workflow = await draft.create({
      name: name.trim(),
      description: source.description,
      definition: source.definition,
      ...(source.sourceYaml === undefined
        ? {}
        : { sourceYaml: source.sourceYaml }),
    });
    if (workflow !== null) onMade(workflow);
  };
  const { failure, made } = draft;

  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && !draft.pending && onClose()}
      state={draft.pending ? "submitting" : "open"}
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
              disabled={draft.pending}
              onClick={onClose}
            >
              {translate("core.actions.cancel")}
            </UI.Button>
            <UI.Button
              type="submit"
              variant="primary"
              disabled={draft.pending}
            >
              {translate("library.copy.submit" as never)}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
