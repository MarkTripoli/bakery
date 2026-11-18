import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import type {
  RepositoryResponse,
  RoleBindingResponse,
} from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  changed,
  EMPTY_NAME,
  isActive,
  nameProblem,
  type NameValues,
  valuesOf,
} from "./names-state.ts";
import { useRepositoryNames } from "./use-repository-names.ts";

/**
 * Change the names of one repository (design-ux, #65): one form to add a name
 * or edit the one chosen, and the list of names with Edit and Archive or
 * Restore. Nothing is deleted: an archived name can be restored.
 */
export function NamesSheet(
  { repository, names, canManage, onClose }: Readonly<{
    repository: RepositoryResponse;
    names: readonly RoleBindingResponse[];
    canManage: boolean;
    onClose: () => void;
  }>,
) {
  const { translate } = useI18n();
  const id = useId();
  const writes = useRepositoryNames(repository.applicationId, repository.id);
  const [editing, setEditing] = useState<RoleBindingResponse | null>(null);
  const [adding, setAdding] = useState(false);
  const [values, setValues] = useState<NameValues>(EMPTY_NAME);
  const [tried, setTried] = useState(false);

  const problem = nameProblem(values);
  const disabled = !canManage || writes.pending;
  const set = (patch: Partial<NameValues>) =>
    setValues({ ...values, ...patch });
  const reset = () => {
    setAdding(false);
    setEditing(null);
    setValues(EMPTY_NAME);
    setTried(false);
    writes.clearFailure();
  };
  const choose = (binding: RoleBindingResponse) => {
    setEditing(binding);
    setValues(valuesOf(binding));
    setTried(false);
    writes.clearFailure();
  };
  const submit = async () => {
    setTried(true);
    if (problem !== null || disabled) return;
    const saved = editing === null
      ? await writes.add(values)
      : await writes.edit(editing, values);
    if (saved) reset();
  };

  return (
    <UI.Sheet
      open
      onOpenChange={(open) => !open && !writes.pending && onClose()}
      state={writes.pending ? "submitting" : "open"}
      title={translate("projects.repository.names.sheet" as never)}
      variant="side"
    >
      <UI.Stack gap="standard">
        <UI.Text variant="muted">
          {translate("projects.repository.names.intro" as never)}
        </UI.Text>
        {!canManage
          ? (
            <UI.InlineNotice tone="information">
              {translate("projects.repository.names.adminOnly" as never)}
            </UI.InlineNotice>
          )
          : null}
        {writes.failure === null ||
            (writes.failure === "conflict" && editing === null)
          ? null
          : (
            <UI.InlineNotice
              role="alert"
              tone={writes.failure === "conflict" ? "warning" : "error"}
            >
              {translate(
                `projects.repository.names.failure.${writes.failure}` as never,
              )}
            </UI.InlineNotice>
          )}
        {names.length === 0 ? null : (
          <UI.Stack
            gap="compact"
            role="list"
            aria-label={translate(
              "projects.repository.names.listLabel" as never,
            )}
          >
            {names.map((binding) => (
              <div key={binding.id} role="listitem">
                <UI.StackedRow
                  flush
                  data-testid={`name-row-${binding.role}`}
                  title={binding.role}
                  status={isActive(binding)
                    ? undefined
                    : (
                      <UI.Badge tone="neutral">
                        {translate(
                          "projects.repository.names.row.archived" as never,
                        )}
                      </UI.Badge>
                    )}
                >
                  {binding.alias === null ? null : (
                    <UI.Text variant="muted">
                      {translate("projects.repository.names.also" as never, {
                        others: binding.alias,
                      })}
                    </UI.Text>
                  )}
                  {binding.provenance === null
                    ? null
                    : <UI.Text variant="muted">{binding.provenance}</UI.Text>}
                  <UI.Inline gap="compact">
                    {isActive(binding)
                      ? (
                        <UI.Button
                          variant="text"
                          disabled={disabled}
                          aria-label={translate(
                            "projects.repository.names.row.edit" as never,
                            { name: binding.role },
                          )}
                          onClick={() => choose(binding)}
                        >
                          {translate(
                            "projects.repository.names.row.editShort" as never,
                          )}
                        </UI.Button>
                      )
                      : null}
                    <UI.Button
                      variant="text"
                      disabled={disabled}
                      aria-label={translate(
                        (isActive(binding)
                          ? "projects.repository.names.row.archive"
                          : "projects.repository.names.row.restore") as never,
                        { name: binding.role },
                      )}
                      onClick={() => void writes.archive(binding)}
                    >
                      {translate(
                        (isActive(binding)
                          ? "projects.repository.names.row.archiveShort"
                          : "projects.repository.names.row.restoreShort") as never,
                      )}
                    </UI.Button>
                  </UI.Inline>
                </UI.StackedRow>
              </div>
            ))}
          </UI.Stack>
        )}
        {canManage && !adding && editing === null
          ? (
            <UI.Inline gap="compact">
              <UI.Button
                variant="secondary"
                disabled={writes.pending}
                onClick={() => {
                  writes.clearFailure();
                  setAdding(true);
                }}
              >
                {translate("projects.repository.names.add" as never)}
              </UI.Button>
            </UI.Inline>
          )
          : null}
        {adding || editing !== null
          ? (
            <UI.Stack gap="standard" data-testid="names-form">
              <UI.Field
                label={translate(
                  "projects.repository.names.form.name" as never,
                )}
                htmlFor={`${id}-name`}
                required
                hint={translate(
                  "projects.repository.names.form.nameHelp" as never,
                )}
                error={writes.failure === "conflict" && editing === null
                  ? translate("projects.repository.names.form.used" as never, {
                    name: values.name.trim(),
                  })
                  : tried && problem === "empty"
                  ? translate("projects.repository.names.form.empty" as never)
                  : tried && problem === "tooLong"
                  ? translate("projects.repository.names.form.tooLong" as never)
                  : undefined}
              >
                <UI.TextInput
                  type="text"
                  id={`${id}-name`}
                  name="name"
                  autoComplete="off"
                  disabled={disabled}
                  invalid={(tried && problem !== null) ||
                    (writes.failure === "conflict" && editing === null)}
                  value={values.name}
                  onChange={(name) => set({ name })}
                />
              </UI.Field>
              <UI.Field
                label={translate(
                  "projects.repository.names.form.others" as never,
                )}
                htmlFor={`${id}-others`}
                hint={translate(
                  "projects.repository.names.form.othersHelp" as never,
                )}
              >
                <UI.TextInput
                  type="text"
                  id={`${id}-others`}
                  name="others"
                  autoComplete="off"
                  disabled={disabled}
                  value={values.others}
                  onChange={(others) => set({ others })}
                />
              </UI.Field>
              <UI.Field
                label={translate(
                  "projects.repository.names.form.note" as never,
                )}
                htmlFor={`${id}-note`}
                hint={translate(
                  "projects.repository.names.form.noteHelp" as never,
                )}
              >
                <UI.TextInput
                  type="text"
                  id={`${id}-note`}
                  name="note"
                  autoComplete="off"
                  disabled={disabled}
                  value={values.note}
                  onChange={(note) => set({ note })}
                />
              </UI.Field>
              <UI.Inline gap="compact">
                <UI.Button
                  variant="primary"
                  disabled={disabled ||
                    (editing !== null && !changed(editing, values))}
                  loading={writes.pending}
                  onClick={() => void submit()}
                >
                  {writes.pending
                    ? translate(
                      "projects.repository.names.form.saving" as never,
                    )
                    : translate(
                      (editing === null
                        ? "projects.repository.names.form.add"
                        : "projects.repository.names.form.save") as never,
                    )}
                </UI.Button>
                <UI.Button
                  variant="secondary"
                  disabled={writes.pending}
                  onClick={reset}
                >
                  {translate("projects.repository.names.form.cancel" as never)}
                </UI.Button>
              </UI.Inline>
            </UI.Stack>
          )
          : null}
        <UI.Button
          variant="secondary"
          onClick={onClose}
          disabled={writes.pending}
        >
          {translate("projects.repository.names.done" as never)}
        </UI.Button>
      </UI.Stack>
    </UI.Sheet>
  );
}
