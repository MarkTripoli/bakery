import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import type { RepositoryResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { useEditRepository } from "./use-edit-repository.ts";

/**
 * Change a repository's default branch (design-ux, #65 slice 3). Save stays
 * disabled until the branch differs from the one loaded; an empty branch says
 * what to enter, and a version that moved says so with a way to reload. The
 * name is not editable: the page title is the GitHub owner/name, and Bakery
 * does not rename the repository on GitHub.
 */
export function EditRepositoryDialog(
  { onClose, onSaved, repository }: {
    readonly repository: RepositoryResponse;
    readonly onClose: () => void;
    readonly onSaved: () => void;
  },
) {
  const { translate } = useI18n();
  const id = useId();
  const change = useEditRepository(repository);
  const [branch, setBranch] = useState(repository.defaultBranch);
  const [tried, setTried] = useState(false);
  const branchError = branch.trim() === "";
  const changed = branch.trim() !== repository.defaultBranch;
  const pending = change.pending;
  const save = () => {
    setTried(true);
    if (branchError || !changed || pending) return;
    void change.run({ defaultBranch: branch.trim() }).then((done) => {
      if (done) onSaved();
    });
  };
  return (
    <UI.AlertDialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      state={pending ? "confirming" : "open"}
      title={translate("projects.repository.edit.title" as never)}
      cancelAction={
        <UI.Button variant="secondary" disabled={pending} onClick={onClose}>
          {translate("core.actions.cancel" as never)}
        </UI.Button>
      }
      confirmAction={
        <UI.Button
          variant="primary"
          disabled={!changed || pending}
          loading={pending}
          onClick={save}
        >
          {translate(
            (pending
              ? "projects.repository.edit.saving"
              : "projects.repository.edit.save") as never,
          )}
        </UI.Button>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={translate("projects.repository.edit.branch" as never)}
            htmlFor={`${id}-branch`}
            required
            hint={translate("projects.repository.edit.branchHelp" as never)}
            error={tried && branchError
              ? translate("projects.repository.edit.branchEmpty" as never)
              : undefined}
          >
            <UI.TextInput
              id={`${id}-branch`}
              name="defaultBranch"
              type="text"
              autoComplete="off"
              value={branch}
              invalid={tried && branchError || undefined}
              onChange={(value) => setBranch(value.slice(0, 255))}
            />
          </UI.Field>
          {change.failure === "conflict"
            ? (
              <UI.InlineNotice
                tone="warning"
                action={
                  <UI.Button variant="quiet" onClick={change.reload}>
                    {translate("projects.repository.edit.reload" as never)}
                  </UI.Button>
                }
              >
                {translate("projects.repository.edit.changed" as never)}
              </UI.InlineNotice>
            )
            : change.failure !== null
            ? (
              <UI.InlineNotice tone="error">
                {translate(
                  `projects.list.failure.${change.failure}` as never,
                )}
              </UI.InlineNotice>
            )
            : null}
        </UI.Stack>
      </form>
    </UI.AlertDialog>
  );
}
