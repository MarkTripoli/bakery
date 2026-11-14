import { useId, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import type { ApplicationResponse } from "../../api/client.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  addRepositoryErrors,
  APPLICATION_SLUG,
  type Candidate,
  deriveSlug,
  matching,
} from "./project-state.ts";
import type { ProjectFailure } from "./useProjectMutations.ts";

const NEW_APPLICATION = "__new__";

export type AddRepositoryDraft = {
  readonly candidate: Candidate;
  readonly slug: string;
  readonly branch: string;
  /** An existing application's id, or a new application to create first. */
  readonly application:
    | { readonly id: string }
    | {
      readonly create: {
        readonly name: string;
        readonly slug: string;
      };
    };
};

/**
 * Add a repository in two steps: pick one the GitHub connection offers (ones
 * already added are shown and cannot be picked), then say which application it
 * belongs to, its default branch and its short name. Nothing is typed that can
 * be picked.
 */
export function AddRepositoryDialog(
  {
    applications,
    candidates,
    failure,
    loadFailed,
    loading,
    onClose,
    onSubmit,
    pending,
  }: {
    readonly applications: readonly ApplicationResponse[];
    readonly candidates: readonly Candidate[];
    readonly failure: ProjectFailure | "already" | null;
    readonly loadFailed: boolean;
    readonly loading: boolean;
    readonly onClose: () => void;
    readonly onSubmit: (draft: AddRepositoryDraft) => void;
    readonly pending: boolean;
  },
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const id = useId();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Candidate | null>(null);
  // Nothing to choose from: a new application; one application: that one.
  const [applicationId, setApplicationId] = useState(() => {
    const open = applications.filter((application) =>
      application.archivedAt === null
    );
    return open.length === 0
      ? NEW_APPLICATION
      : open.length === 1
      ? open[0]!.id
      : "";
  });
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newSlugEdited, setNewSlugEdited] = useState(false);
  const [branch, setBranch] = useState("main");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [tried, setTried] = useState(false);
  const active = applications.filter((application) =>
    application.archivedAt === null
  );
  const shown = useMemo(() => matching(candidates, query), [candidates, query]);
  const creatingApplication = applicationId === NEW_APPLICATION;
  const shownSlug = slugEdited ? slug : deriveSlug(picked?.name ?? "", 200);
  const shownNewSlug = newSlugEdited ? newSlug : deriveSlug(newName);
  const errors = addRepositoryErrors({
    slug: shownSlug,
    branch,
    applicationId: creatingApplication
      ? (newName.trim() !== "" && APPLICATION_SLUG.test(shownNewSlug)
        ? NEW_APPLICATION
        : "")
      : applicationId,
  });
  const failureKey = failure === null
    ? null
    : failure === "already"
    ? "projects.list.add.already"
    : failure === "conflict"
    ? "projects.list.add.conflict"
    : `projects.list.failure.${failure}`;

  return (
    <UI.Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      state={pending ? "submitting" : failure ? "error" : "open"}
      title={translate("projects.list.add.title" as never)}
      variant="form"
    >
      {picked === null
        ? (
          <UI.Stack gap="standard">
            <UI.Text variant="muted">
              {translate("projects.list.add.pickIntro" as never)}
            </UI.Text>
            {candidates.length > 0
              ? (
                <UI.SearchField
                  aria-label={translate("projects.list.add.search" as never)}
                  placeholder={translate("projects.list.add.search" as never)}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              )
              : null}
            {loading
              ? (
                <UI.Text variant="muted" role="status">
                  {translate("projects.list.add.loading" as never)}
                </UI.Text>
              )
              : loadFailed
              ? (
                <UI.InlineNotice tone="error">
                  {translate("projects.list.add.loadFailed" as never)}
                </UI.InlineNotice>
              )
              : candidates.length === 0
              ? (
                <UI.Stack gap="compact">
                  <UI.Text>
                    {translate("projects.list.add.noneOffered" as never)}
                  </UI.Text>
                  <UI.Button
                    variant="secondary"
                    onClick={() =>
                      void navigate({
                        to: "/settings/organization/integrations",
                      })}
                  >
                    {translate("projects.list.openIntegrations" as never)}
                  </UI.Button>
                </UI.Stack>
              )
              : candidates.every((item) => item.alreadyAdded)
              ? (
                <UI.Stack gap="compact">
                  <UI.Text>
                    {translate("projects.list.add.allAdded" as never)}
                  </UI.Text>
                  <UI.Button
                    variant="secondary"
                    onClick={() =>
                      void navigate({
                        to: "/settings/organization/integrations",
                      })}
                  >
                    {translate("projects.list.openIntegrations" as never)}
                  </UI.Button>
                </UI.Stack>
              )
              : shown.length === 0
              ? (
                <UI.Text variant="muted">
                  {translate("projects.list.add.noMatch" as never)}
                </UI.Text>
              )
              : (
                <UI.DescriptionList>
                  {shown.map((item) => (
                    <UI.DescriptionItem
                      key={item.resource.id}
                      title={`${item.owner}/${item.name}`}
                      description={item.alreadyAdded
                        ? translate("projects.list.add.alreadyAdded" as never)
                        : undefined}
                      onSelect={item.alreadyAdded ? undefined : () => {
                        setPicked(item);
                        setTried(false);
                      }}
                      action={item.alreadyAdded
                        ? undefined
                        : <UI.IconGlyph name="arrow" size="large" />}
                    />
                  ))}
                </UI.DescriptionList>
              )}
            <UI.Inline gap="compact">
              <UI.Button variant="secondary" onClick={onClose}>
                {translate("core.actions.cancel" as never)}
              </UI.Button>
            </UI.Inline>
          </UI.Stack>
        )
        : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setTried(true);
              if (Object.keys(errors).length > 0) return;
              onSubmit({
                candidate: picked,
                slug: shownSlug,
                branch: branch.trim(),
                application: creatingApplication
                  ? { create: { name: newName.trim(), slug: shownNewSlug } }
                  : { id: applicationId },
              });
            }}
          >
            <UI.Stack gap="standard">
              <UI.Text>
                {translate("projects.list.add.chosen" as never, {
                  repository: `${picked.owner}/${picked.name}`,
                })}
              </UI.Text>
              <UI.Combobox
                label={translate("projects.list.add.application" as never)}
                value={applicationId}
                required
                onChange={(event) => setApplicationId(event.target.value)}
                options={[
                  {
                    value: "",
                    label: translate(
                      "projects.list.add.chooseApplication" as never,
                    ),
                    disabled: true,
                  },
                  ...active.map((application) => ({
                    value: application.id,
                    label: application.name,
                  })),
                  {
                    value: NEW_APPLICATION,
                    label: translate(
                      "projects.list.add.newApplication" as never,
                    ),
                  },
                ]}
              />
              {tried && errors.application !== undefined && !creatingApplication
                ? (
                  <UI.InlineNotice tone="error">
                    {translate("projects.list.add.applicationEmpty" as never)}
                  </UI.InlineNotice>
                )
                : null}
              {creatingApplication
                ? (
                  <>
                    <UI.Field
                      label={translate(
                        "projects.list.application.name" as never,
                      )}
                      htmlFor={`${id}-app-name`}
                      required
                      error={tried && newName.trim() === ""
                        ? translate(
                          "projects.list.application.nameEmpty" as never,
                        )
                        : undefined}
                    >
                      <UI.TextInput
                        id={`${id}-app-name`}
                        name="applicationName"
                        type="text"
                        autoComplete="off"
                        value={newName}
                        onChange={(value) => setNewName(value.slice(0, 200))}
                      />
                    </UI.Field>
                    <UI.Field
                      label={translate("projects.list.shortName" as never)}
                      htmlFor={`${id}-app-slug`}
                      required
                      hint={translate("projects.list.shortNameHelp" as never)}
                      error={tried && shownNewSlug !== "" &&
                          !APPLICATION_SLUG.test(shownNewSlug)
                        ? translate("projects.list.shortNameInvalid" as never)
                        : undefined}
                    >
                      <UI.TextInput
                        id={`${id}-app-slug`}
                        name="applicationSlug"
                        type="text"
                        autoComplete="off"
                        value={shownNewSlug}
                        onChange={(value) => {
                          setNewSlugEdited(true);
                          setNewSlug(value.slice(0, 100));
                        }}
                      />
                    </UI.Field>
                  </>
                )
                : null}
              <UI.Field
                label={translate("projects.list.add.branch" as never)}
                htmlFor={`${id}-branch`}
                required
                hint={translate("projects.list.add.branchHelp" as never)}
                error={tried && errors.branch !== undefined
                  ? translate(
                    (errors.branch === "empty"
                      ? "projects.list.add.branchEmpty"
                      : "projects.list.add.branchInvalid") as never,
                  )
                  : undefined}
              >
                <UI.TextInput
                  id={`${id}-branch`}
                  name="defaultBranch"
                  type="text"
                  autoComplete="off"
                  value={branch}
                  invalid={tried && errors.branch !== undefined ||
                    undefined}
                  onChange={(value) => setBranch(value.slice(0, 255))}
                />
              </UI.Field>
              <UI.Field
                label={translate("projects.list.shortName" as never)}
                htmlFor={`${id}-slug`}
                required
                hint={translate("projects.list.shortNameHelp" as never)}
                error={tried && errors.slug !== undefined
                  ? translate(
                    (errors.slug === "empty"
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
                  invalid={tried && errors.slug !== undefined || undefined}
                  onChange={(value) => {
                    setSlugEdited(true);
                    setSlug(value.slice(0, 200));
                  }}
                />
              </UI.Field>
              {failureKey !== null
                ? (
                  <UI.InlineNotice tone="error">
                    {translate(failureKey as never)}
                  </UI.InlineNotice>
                )
                : null}
              <UI.Inline gap="compact">
                <UI.Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => setPicked(null)}
                >
                  {translate("projects.list.add.back" as never)}
                </UI.Button>
                <UI.Button
                  variant="primary"
                  type="submit"
                  disabled={pending}
                  aria-busy={pending || undefined}
                >
                  {translate("projects.list.add.submit" as never)}
                </UI.Button>
              </UI.Inline>
            </UI.Stack>
          </form>
        )}
    </UI.Dialog>
  );
}
