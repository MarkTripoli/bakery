import { useEffect, useState } from "react";
import * as UI from "@bakery/ui";
import type {
  RepositoryProfileResponse,
  RepositoryResponse,
  RepositoryUpdate,
} from "../../api/client.ts";
import type { CursorCollection } from "./useCursorPages.ts";
import type { ProjectsOnboardingLabels } from "./labels.ts";
import {
  type FieldErrors,
  type RepositoryEditValues,
  type RepositoryFormValues,
  repositoryUpdateInput,
  validateRepositoryEdit,
} from "./validation.ts";
import { readOnlyProfileHistoryRows } from "./identity.ts";

type RepositoryField = keyof RepositoryFormValues;
type RepositoryEditField = keyof RepositoryEditValues;

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
