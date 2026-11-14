import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import type { ApplicationResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { APPLICATION_SLUG, deriveSlug } from "./project-state.ts";
import type { ProjectFailure } from "./useProjectMutations.ts";

export type ApplicationDraft = {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
};

/**
 * Creates an application (name, short name, one line about it) or renames one
 * (its name only). The short name follows the name until the person edits it.
 */
export function ApplicationDialog(
  { application, failure, onClose, onSubmit, pending }: {
    /** The application being renamed; null creates a new one. */
    readonly application: ApplicationResponse | null;
    readonly failure: ProjectFailure | null;
    readonly onClose: () => void;
    readonly onSubmit: (draft: ApplicationDraft) => void;
    readonly pending: boolean;
  },
) {
  const { translate } = useI18n();
  const id = useId();
  const [name, setName] = useState(application?.name ?? "");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [tried, setTried] = useState(false);
  const creating = application === null;
  const shownSlug = slugEdited ? slug : deriveSlug(name);
  const nameError = name.trim() === "" ? "empty" : null;
  const slugError = !creating
    ? null
    : shownSlug === ""
    ? "empty"
    : !APPLICATION_SLUG.test(shownSlug)
    ? "invalid"
    : null;
  return (
    <UI.Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      state={pending ? "submitting" : failure ? "error" : "open"}
      title={translate(
        (creating
          ? "projects.list.application.createTitle"
          : "projects.list.application.renameTitle") as never,
      )}
      variant="form"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (nameError !== null || slugError !== null) return;
          onSubmit({ name: name.trim(), slug: shownSlug, description });
        }}
      >
        <UI.Stack gap="standard">
          {creating
            ? (
              <UI.Text variant="muted">
                {translate("projects.list.application.explain" as never)}
              </UI.Text>
            )
            : null}
          <UI.Field
            label={translate("projects.list.application.name" as never)}
            htmlFor={`${id}-name`}
            required
            error={tried && nameError !== null
              ? translate("projects.list.application.nameEmpty" as never)
              : undefined}
          >
            <UI.TextInput
              id={`${id}-name`}
              name="name"
              type="text"
              autoComplete="off"
              value={name}
              invalid={tried && nameError !== null || undefined}
              onChange={(value) => setName(value.slice(0, 200))}
            />
          </UI.Field>
          {creating
            ? (
              <>
                <UI.Field
                  label={translate("projects.list.shortName" as never)}
                  htmlFor={`${id}-slug`}
                  required
                  hint={translate("projects.list.shortNameHelp" as never)}
                  error={tried && slugError !== null
                    ? translate(
                      (slugError === "empty"
                        ? "projects.list.shortNameEmpty"
                        : "projects.list.shortNameInvalid") as never,
                    )
                    : undefined}
                >
                  <UI.TextInput
                    id={`${id}-slug`}
                    name="slug"
                    type="text"
                    autoComplete="off"
                    value={shownSlug}
                    invalid={tried && slugError !== null || undefined}
                    onChange={(value) => {
                      setSlugEdited(true);
                      setSlug(value.slice(0, 100));
                    }}
                  />
                </UI.Field>
                <UI.Field
                  label={translate(
                    "projects.list.application.description" as never,
                  )}
                  htmlFor={`${id}-description`}
                  note={translate("projects.list.optional" as never)}
                >
                  <UI.TextInput
                    id={`${id}-description`}
                    name="description"
                    type="text"
                    autoComplete="off"
                    value={description}
                    onChange={(value) => setDescription(value.slice(0, 2000))}
                  />
                </UI.Field>
              </>
            )
            : null}
          {failure !== null
            ? (
              <UI.InlineNotice tone="error">
                {translate(`projects.list.failure.${failure}` as never)}
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
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {translate(
                (creating
                  ? "projects.list.application.create"
                  : "projects.list.application.rename") as never,
              )}
            </UI.Button>
          </UI.Inline>
        </UI.Stack>
      </form>
    </UI.Dialog>
  );
}
