import { useEffect, useState } from "react";
import * as UI from "@bakery/ui";
import type {
  ApplicationResponse,
  RepositoryCreate,
  RepositoryProfileResponse,
  RepositoryResponse,
  RepositoryUpdate,
} from "../../api/client.ts";
import type { CursorCollection } from "./useCursorPages.ts";
import type { ProjectsOnboardingLabels } from "./labels.ts";
import {
  EMPTY_REPOSITORY_FORM,
  type FieldErrors,
  repositoryCreateInput,
  type RepositoryEditValues,
  type RepositoryFormValues,
  repositoryUpdateInput,
  validateRepositoryEdit,
  validateRepositoryForm,
} from "./validation.ts";
import { readOnlyProfileHistoryRows } from "./identity.ts";

type RepositorySectionProps = Readonly<{
  labels: ProjectsOnboardingLabels;
  applications: CursorCollection<ApplicationResponse>;
  selectedApplicationId: string;
  onApplicationChange: (applicationId: string) => void;
  onCreate: (input: RepositoryCreate) => Promise<void>;
  createPending: boolean;
}>;

type RepositoryField = keyof RepositoryFormValues;
type RepositoryEditField = keyof RepositoryEditValues;

export function RepositorySection({
  applications,
  createPending,
  labels,
  onApplicationChange,
  onCreate,
  selectedApplicationId,
}: RepositorySectionProps) {
  const [values, setValues] = useState<RepositoryFormValues>(
    EMPTY_REPOSITORY_FORM,
  );
  const [errors, setErrors] = useState<FieldErrors<RepositoryField>>({});
  const [submitError, setSubmitError] = useState(false);

  const submit = async () => {
    const submittedValues = { ...values, applicationId: selectedApplicationId };
    const nextErrors = validateRepositoryForm(submittedValues);
    setErrors(nextErrors);
    setSubmitError(false);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      await onCreate(repositoryCreateInput(submittedValues));
      setValues(EMPTY_REPOSITORY_FORM);
      setErrors({});
    } catch {
      setSubmitError(true);
    }
  };

  const error = (field: RepositoryField) => {
    const code = errors[field];
    return code === undefined ? undefined : labels.validation[code];
  };

  return (
    <>
      <UI.Stack data-testid="projects-onboarding-repositories" gap="spacious">
        <p>{labels.repositories.description}</p>
        <UI.SettingsSection
          title={labels.repositories.createHeading}
          variant="stack"
        >
          {submitError
            ? (
              <UI.InlineNotice tone="error">
                {labels.errors.mutation}
              </UI.InlineNotice>
            )
            : null}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <UI.Stack gap="standard">
              <UI.Combobox
                label={labels.repositories.fields.application}
                name="applicationId"
                onChange={(event) => {
                  const applicationId = event.target.value;
                  onApplicationChange(applicationId);
                  setValues((current) => ({ ...current, applicationId }));
                }}
                options={[
                  {
                    disabled: true,
                    label: labels.repositories.fields.application,
                    value: "",
                  },
                  ...applications.items.map((application) => ({
                    label: `${application.name} (${application.slug})`,
                    value: application.id,
                  })),
                ]}
                value={selectedApplicationId}
              />
              {errors.applicationId
                ? (
                  <UI.InlineNotice tone="error">
                    {labels.validation[errors.applicationId]}
                  </UI.InlineNotice>
                )
                : null}
              <RepositoryInput
                autoComplete="off"
                error={error("slug")}
                id="projects-onboarding-repository-slug"
                label={labels.repositories.fields.slug}
                name="slug"
                onChange={(slug) =>
                  setValues((current) => ({ ...current, slug }))}
                value={values.slug}
              />
              <RepositoryInput
                autoComplete="off"
                error={error("integrationConnectionId")}
                id="projects-onboarding-repository-connection"
                label={labels.repositories.fields.integrationConnectionId}
                name="integrationConnectionId"
                onChange={(integrationConnectionId) =>
                  setValues((current) => ({
                    ...current,
                    integrationConnectionId,
                  }))}
                value={values.integrationConnectionId}
              />
              <RepositoryInput
                autoComplete="off"
                error={error("providerRepoId")}
                id="projects-onboarding-repository-provider-id"
                label={labels.repositories.fields.providerRepoId}
                name="providerRepoId"
                onChange={(providerRepoId) =>
                  setValues((current) => ({ ...current, providerRepoId }))}
                value={values.providerRepoId}
              />
              <RepositoryInput
                autoComplete="off"
                error={error("owner")}
                id="projects-onboarding-repository-owner"
                label={labels.repositories.fields.owner}
                name="owner"
                onChange={(owner) =>
                  setValues((current) => ({ ...current, owner }))}
                value={values.owner}
              />
              <RepositoryInput
                autoComplete="off"
                error={error("name")}
                id="projects-onboarding-repository-name"
                label={labels.repositories.fields.name}
                name="name"
                onChange={(name) =>
                  setValues((current) => ({ ...current, name }))}
                value={values.name}
              />
              <RepositoryInput
                autoComplete="off"
                error={error("defaultBranch")}
                id="projects-onboarding-repository-default-branch"
                label={labels.repositories.fields.defaultBranch}
                name="defaultBranch"
                onChange={(defaultBranch) =>
                  setValues((current) => ({ ...current, defaultBranch }))}
                value={values.defaultBranch}
              />
              <UI.Button
                disabled={createPending ||
                  !applications.items.some((application) =>
                    application.id === selectedApplicationId &&
                    application.archivedAt === null
                  )}
                loading={createPending}
                type="submit"
              >
                {createPending
                  ? labels.repositories.actions.creating
                  : labels.repositories.actions.create}
              </UI.Button>
            </UI.Stack>
          </form>
        </UI.SettingsSection>
      </UI.Stack>
    </>
  );
}

function RepositoryInput({
  autoComplete,
  error,
  id,
  label,
  name,
  onChange,
  value,
}: Readonly<{
  autoComplete: string;
  error: string | undefined;
  id: string;
  label: string;
  name: string;
  onChange: (value: string) => void;
  value: string;
}>) {
  return (
    <UI.Field error={error} htmlFor={id} label={label} required>
      <UI.TextInput
        autoComplete={autoComplete}
        id={id}
        invalid={error !== undefined}
        name={name}
        onChange={onChange}
        required
        type="text"
        value={value}
      />
    </UI.Field>
  );
}

export function RepositoryEditor({
  labels,
  onLoadMoreProfiles,
  onRetryMoreProfiles,
  onRetryProfiles,
  onUpdate,
  profiles,
  repository,
  updatePending,
}: Readonly<{
  labels: ProjectsOnboardingLabels;
  onLoadMoreProfiles: () => void;
  onRetryMoreProfiles: () => void;
  onRetryProfiles: () => void;
  onUpdate: (
    repositoryId: string,
    input: RepositoryUpdate,
    ifMatch: string,
  ) => Promise<void>;
  profiles: CursorCollection<RepositoryProfileResponse> | null;
  repository: RepositoryResponse;
  updatePending: boolean;
}>) {
  const [values, setValues] = useState<RepositoryEditValues>({
    defaultBranch: repository.defaultBranch,
    name: repository.name,
  });
  const [errors, setErrors] = useState<FieldErrors<RepositoryEditField>>({});
  const [submitError, setSubmitError] = useState(false);
  const [archiveError, setArchiveError] = useState(false);

  useEffect(() => {
    setValues({
      defaultBranch: repository.defaultBranch,
      name: repository.name,
    });
    setErrors({});
    setSubmitError(false);
    setArchiveError(false);
  }, [repository.id, repository.name, repository.defaultBranch]);

  const save = async () => {
    const nextErrors = validateRepositoryEdit(values);
    setErrors(nextErrors);
    setSubmitError(false);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      await onUpdate(
        repository.id,
        repositoryUpdateInput(values),
        etag(repository),
      );
    } catch {
      setSubmitError(true);
    }
  };

  const setArchived = async (archived: boolean) => {
    setArchiveError(false);
    try {
      await onUpdate(
        repository.id,
        { archivedAt: archived ? new Date().toISOString() : null },
        etag(repository),
      );
    } catch {
      setArchiveError(true);
    }
  };

  const error = (field: RepositoryEditField) => {
    const code = errors[field];
    return code === undefined ? undefined : labels.validation[code];
  };

  return (
    <UI.SettingsSection
      data-testid="projects-onboarding-repository-editor"
      title={labels.repositories.editHeading}
      variant="stack"
    >
      <p>{repository.owner}/{repository.name}</p>
      {submitError || archiveError
        ? (
          <UI.InlineNotice tone="error">
            {labels.errors.mutation}
          </UI.InlineNotice>
        )
        : null}
      <UI.Stack gap="standard">
        <UI.Field
          error={error("name")}
          htmlFor="projects-onboarding-repository-edit-name"
          label={labels.repositories.fields.name}
          required
        >
          <UI.TextInput
            autoComplete="off"
            id="projects-onboarding-repository-edit-name"
            invalid={errors.name !== undefined}
            name="name"
            onChange={(name) => setValues((current) => ({ ...current, name }))}
            required
            type="text"
            value={values.name}
          />
        </UI.Field>
        <UI.Field
          error={error("defaultBranch")}
          htmlFor="projects-onboarding-repository-edit-branch"
          label={labels.repositories.fields.defaultBranch}
          required
        >
          <UI.TextInput
            autoComplete="off"
            id="projects-onboarding-repository-edit-branch"
            invalid={errors.defaultBranch !== undefined}
            name="defaultBranch"
            onChange={(defaultBranch) =>
              setValues((current) => ({ ...current, defaultBranch }))}
            required
            type="text"
            value={values.defaultBranch}
          />
        </UI.Field>
        <UI.Inline gap="compact">
          <UI.Button
            disabled={updatePending}
            loading={updatePending}
            onClick={() => void save()}
          >
            {updatePending
              ? labels.repositories.actions.saving
              : labels.repositories.actions.save}
          </UI.Button>
          <UI.Button
            disabled={updatePending}
            loading={updatePending}
            onClick={() => void setArchived(repository.archivedAt === null)}
            variant="secondary"
          >
            {repository.archivedAt === null
              ? labels.repositories.actions.archive
              : labels.repositories.actions.reactivate}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
      <ProfileHistory
        labels={labels}
        activeProfileId={repository.activeProfileId}
        repositoryId={repository.id}
        onLoadMore={onLoadMoreProfiles}
        onRetry={onRetryProfiles}
        onRetryMore={onRetryMoreProfiles}
        profiles={profiles}
      />
    </UI.SettingsSection>
  );
}

function ProfileHistory({
  activeProfileId,
  labels,
  onLoadMore,
  onRetry,
  onRetryMore,
  repositoryId,
  profiles,
}: Readonly<{
  activeProfileId: string | null;
  repositoryId: string;
  labels: ProjectsOnboardingLabels;
  onLoadMore: () => void;
  onRetry: () => void;
  onRetryMore: () => void;
  profiles: CursorCollection<RepositoryProfileResponse> | null;
}>) {
  if (profiles === null) {
    return (
      <UI.InlineNotice tone="information">
        {labels.profiles.repositoryRequired}
      </UI.InlineNotice>
    );
  }
  if (profiles.state === "loading") {
    return (
      <UI.Stack
        data-testid="projects-onboarding-profiles-loading"
        gap="compact"
      >
        <UI.Skeleton shape="row" />
      </UI.Stack>
    );
  }
  if (profiles.state === "error") {
    return (
      <UI.ErrorState
        action={<UI.Button onClick={onRetry}>{labels.errors.retry}</UI.Button>}
        data-testid="projects-onboarding-profiles-error"
        description={labels.errors.load}
        title={labels.errors.load}
      />
    );
  }
  const rows = readOnlyProfileHistoryRows(
    repositoryId,
    activeProfileId,
    profiles.items,
  );
  if (rows.length === 0) {
    return (
      <UI.EmptyState
        data-testid="projects-onboarding-profiles-empty"
        description={labels.profiles.description}
        title={labels.profiles.empty}
      />
    );
  }
  return (
    <UI.Stack gap="compact">
      <UI.Heading level="subsection">{labels.profiles.heading}</UI.Heading>
      <p>{labels.profiles.description}</p>
      <UI.DataTable
        caption={labels.profiles.listCaption}
        columns={[
          {
            cell: (row) => row.profile.revision,
            header: labels.profiles.revision,
            id: "revision",
          },
          {
            cell: (row) => labels.profileStates[row.state],
            header: labels.profiles.state,
            id: "state",
          },
          {
            cell: (row) => row.profile.createdAt,
            header: labels.profiles.created,
            id: "created",
          },
          {
            cell: (row) => row.profile.digest,
            header: labels.profiles.digest,
            id: "digest",
          },
          {
            cell: (row) =>
              row.active && row.state === "legacy-v1"
                ? <UI.Badge tone="success">{labels.profiles.active}</UI.Badge>
                : labels.profiles.readOnly,
            header: labels.profiles.active,
            id: "status",
          },
        ]}
        getRowKey={(row) => row.profile.id}
        rows={[...rows]}
        variant="sheetList"
      />
      {profiles.hasNext || profiles.moreError
        ? (
          <UI.CursorControls
            hasNext={profiles.hasNext}
            labels={labels.pagination}
            onNext={onLoadMore}
            onRetry={onRetryMore}
            state={profiles.moreError
              ? "error"
              : profiles.loadingMore
              ? "loading"
              : "ready"}
          />
        )
        : null}
    </UI.Stack>
  );
}

function etag(repository: RepositoryResponse): string {
  return `"${repository.version}"`;
}
