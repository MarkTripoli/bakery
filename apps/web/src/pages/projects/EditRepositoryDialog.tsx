import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import type { RepositoryResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  type RepositoryEdit,
  useEditRepository,
} from "./use-edit-repository.ts";

/**
 * Edit a repository's display name and default branch. Save stays disabled
 * until a value differs from what was loaded; each field says what is wrong
 * with it, and a version that moved says so with a way to reload.
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
  const [name, setName] = useState(repository.name);
  const [branch, setBranch] = useState(repository.defaultBranch);
  const [tried, setTried] = useState(false);
  const nameError = name.trim() === "";
  const branchError = branch.trim() === "";
  const edit: RepositoryEdit = {
    name: name.trim(),
    defaultBranch: branch.trim(),
  };
  const changed = edit.name !== repository.name ||
    edit.defaultBranch !== repository.defaultBranch;
  const pending = change.pending;
  return (
    <UI.Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      state={pending ? "submitting" : change.failure ? "error" : "open"}
      title={translate("projects.repository.edit.title" as never, {
        name: `${repository.owner}/${repository.name}`,
      })}
      variant="form"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (nameError || branchError || !changed || pending) return;
          void change.run(edit).then((done) => {
            if (done) onSaved();
          });
        }}
      >
        <UI.Stack gap="standard">
          <UI.Field
            label={translate("projects.repository.edit.name" as never)}
            htmlFor={`${id}-name`}
            required
            hint={translate("projects.repository.edit.nameHelp" as never)}
            error={tried && nameError
              ? translate("projects.repository.edit.nameEmpty" as never)
              : undefined}
          >
            <UI.TextInput
              id={`${id}-name`}
              name="name"
              type="text"
              autoComplete="off"
              value={name}
              invalid={tried && nameError || undefined}
              onChange={(value) => setName(value.slice(0, 200))}
            />
          </UI.Field>
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
          <UI.Inline gap="compact">
            <UI.Button variant="secondary" disabled={pending} onClick={onClose}>
              {translate("core.actions.cancel" as never)}
            </UI.Button>
            <UI.Button
              variant="primary"
              type="submit"
              disabled={!changed || pending}
              aria-busy={pending || undefined}
            >
              {translate(
                (pending
                  ? "projects.repository.edit.saving"
                  : "projects.repository.edit.save") as never,
              )}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
