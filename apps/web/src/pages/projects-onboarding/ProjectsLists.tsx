import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  ApplicationResponse,
  RepositoryResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import { repositoryProfilesListQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { ProjectsOnboardingLabels } from "./labels.ts";
import type { CursorCollection } from "./useCursorPages.ts";

function Cursor<Item>(
  { collection, labels, onLoadMore, onRetryMore }: Readonly<{
    collection: CursorCollection<Item>;
    labels: ProjectsOnboardingLabels;
    onLoadMore: () => void;
    onRetryMore: () => void;
  }>,
) {
  if (!collection.hasNext && !collection.moreError) return null;
  return (
    <UI.CursorControls
      hasNext={collection.hasNext}
      labels={labels.pagination}
      onNext={onLoadMore}
      onRetry={onRetryMore}
      state={collection.moreError
        ? "error"
        : collection.loadingMore
        ? "loading"
        : "ready"}
    />
  );
}

function ApplicationStatus(
  { application, labels }: Readonly<{
    application: ApplicationResponse;
    labels: ProjectsOnboardingLabels;
  }>,
) {
  const active = application.archivedAt === null;
  return (
    <UI.StatusDot size="small" tone={active ? "success" : "neutral"}>
      {active
        ? labels.applications.status.active
        : labels.applications.status.archived}
    </UI.StatusDot>
  );
}

export function ApplicationList(
  {
    applications,
    labels,
    onLoadMore,
    onRetry,
    onRetryMore,
    onSelect,
    phone,
    selectedId,
  }: Readonly<{
    applications: CursorCollection<ApplicationResponse>;
    labels: ProjectsOnboardingLabels;
    onLoadMore: () => void;
    onRetry: () => void;
    onRetryMore: () => void;
    onSelect: (id: string) => void;
    phone: boolean;
    selectedId: string;
  }>,
) {
  if (applications.state === "loading") {
    return (
      <UI.Stack
        data-testid="projects-onboarding-applications-loading"
        gap="compact"
      >
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    );
  }
  if (applications.state === "error") {
    return (
      <UI.ErrorState
        action={<UI.Button onClick={onRetry}>{labels.errors.retry}</UI.Button>}
        data-testid="projects-onboarding-applications-error"
        description={labels.errors.load}
        title={labels.errors.load}
      />
    );
  }
  if (applications.items.length === 0) {
    return (
      <UI.EmptyState
        data-testid="projects-onboarding-applications-empty"
        description={labels.applications.description}
        title={labels.applications.empty}
      />
    );
  }
  return (
    <>
      {phone
        ? (
          <div role="list" aria-label={labels.applications.listCaption}>
            {applications.items.map((application) => (
              <div key={application.id} role="listitem">
                <UI.ListRow
                  detail={application.slug}
                  detailTone="code"
                  onSelect={() =>
                    onSelect(application.id)}
                  selected={selectedId === application.id}
                  size="tall"
                  title={application.name}
                  trailing={
                    <ApplicationStatus
                      application={application}
                      labels={labels}
                    />
                  }
                />
              </div>
            ))}
          </div>
        )
        : (
          <UI.DataTable
            caption={labels.applications.listCaption}
            columns={[
              {
                cell: (application) => (
                  <UI.CellStack
                    detail={application.description}
                    icon={<UI.IconGlyph name="applications" size="medium" />}
                    title={application.name}
                  />
                ),
                header: labels.applications.heading,
                id: "name",
              },
              {
                cell: (application) => (
                  <UI.DataText variant="code">{application.slug}</UI.DataText>
                ),
                header: labels.applications.fields.slug,
                id: "slug",
                width: "136px",
              },
              {
                cell: (application) => (
                  <ApplicationStatus
                    application={application}
                    labels={labels}
                  />
                ),
                header: labels.applications.columnStatus,
                id: "status",
                width: "128px",
              },
            ]}
            getRowKey={(application) => application.id}
            inset="edge"
            onSelectRow={(application) => onSelect(application.id)}
            rowSize="double"
            rows={[...applications.items]}
            selectedRowKey={selectedId === "" ? null : selectedId}
            variant="ruled"
          />
        )}
      <Cursor
        collection={applications}
        labels={labels}
        onLoadMore={onLoadMore}
        onRetryMore={onRetryMore}
      />
    </>
  );
}

/** Revision number of a repository's active profile, read from its list. */
function useActiveRevision(repository: RepositoryResponse): number | null {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const profiles = useQuery({
    ...repositoryProfilesListQueryOptions(api, scope, repository.id),
    enabled: scope.organizationId !== null &&
      repository.activeProfileId !== null,
  });
  const active = profiles.data?.items.find((profile) =>
    profile.id === repository.activeProfileId &&
    profile.repositoryId === repository.id
  );
  return active?.revision ?? null;
}

function ProfileSummary(
  { labels, repository }: Readonly<{
    labels: ProjectsOnboardingLabels;
    repository: RepositoryResponse;
  }>,
) {
  const revision = useActiveRevision(repository);
  if (repository.archivedAt !== null) {
    return (
      <UI.StatusDot size="small" tone="neutral">
        {labels.repositories.status.archived}
      </UI.StatusDot>
    );
  }
  if (repository.activeProfileId === null) {
    return (
      <UI.StatusDot size="small" tone="warning">
        {labels.repositories.status.noActiveProfile}
      </UI.StatusDot>
    );
  }
  return (
    <UI.Text variant="hintInk">
      {revision === null
        ? labels.profiles.active
        : labels.profiles.revisionNumber(revision)}
    </UI.Text>
  );
}

function PhoneRepositoryDetail(
  { labels, repository }: Readonly<{
    labels: ProjectsOnboardingLabels;
    repository: RepositoryResponse;
  }>,
) {
  const revision = useActiveRevision(repository);
  const profile = repository.archivedAt !== null
    ? labels.repositories.status.archived
    : repository.activeProfileId === null
    ? labels.repositories.status.noActiveProfile
    : revision === null
    ? labels.profiles.active
    : labels.profiles.revisionNumber(revision);
  return <>{`${repository.defaultBranch} · ${profile}`}</>;
}

export function RepositoryList(
  {
    labels,
    onLoadMore,
    onRepositorySelect,
    onRetry,
    onRetryMore,
    phone,
    repositories,
    selectedRepositoryId,
  }: Readonly<{
    labels: ProjectsOnboardingLabels;
    onLoadMore: () => void;
    onRepositorySelect: (repositoryId: string) => void;
    onRetry: () => void;
    onRetryMore: () => void;
    phone: boolean;
    repositories: CursorCollection<RepositoryResponse>;
    selectedRepositoryId: string | null;
  }>,
) {
  if (repositories.state === "loading") {
    return (
      <UI.Stack
        data-testid="projects-onboarding-repositories-loading"
        gap="compact"
      >
        <UI.Skeleton shape="row" />
        <UI.Skeleton shape="row" />
      </UI.Stack>
    );
  }
  if (repositories.state === "error") {
    return (
      <UI.ErrorState
        action={<UI.Button onClick={onRetry}>{labels.errors.retry}</UI.Button>}
        data-testid="projects-onboarding-repositories-error"
        description={labels.errors.load}
        title={labels.errors.load}
      />
    );
  }
  if (repositories.items.length === 0) {
    return (
      <UI.EmptyState
        data-testid="projects-onboarding-repositories-empty"
        description={labels.repositories.description}
        title={labels.repositories.empty}
      />
    );
  }
  return (
    <>
      {phone
        ? (
          <div role="list" aria-label={labels.repositories.listCaption}>
            {repositories.items.map((repository) => (
              <div key={repository.id} role="listitem">
                <UI.ListRow
                  detail={
                    <PhoneRepositoryDetail
                      labels={labels}
                      repository={repository}
                    />
                  }
                  detailTone={repository.activeProfileId === null &&
                      repository.archivedAt === null
                    ? "warning"
                    : "default"}
                  onSelect={() =>
                    onRepositorySelect(repository.id)}
                  selected={selectedRepositoryId === repository.id}
                  title={`${repository.owner}/${repository.name}`}
                  trailing={<UI.IconGlyph name="chevron-right" size="small" />}
                />
              </div>
            ))}
          </div>
        )
        : (
          <UI.DataTable
            caption={labels.repositories.listCaption}
            columns={[
              {
                cell: (repository) => (
                  <UI.CellStack
                    title={`${repository.owner}/${repository.name}`}
                  />
                ),
                header: labels.repositories.listCaption,
                id: "identity",
              },
              {
                cell: (repository) => (
                  <UI.DataText variant="code">
                    {repository.defaultBranch}
                  </UI.DataText>
                ),
                header: labels.repositories.fields.defaultBranch,
                id: "defaultBranch",
                width: "128px",
              },
              {
                cell: (repository) => (
                  <ProfileSummary labels={labels} repository={repository} />
                ),
                header: labels.profiles.active,
                id: "activeProfile",
                width: "182px",
              },
            ]}
            getRowKey={(repository) => repository.id}
            inset="edge"
            onSelectRow={(repository) => onRepositorySelect(repository.id)}
            rows={[...repositories.items]}
            selectedRowKey={selectedRepositoryId}
            variant="ruled"
          />
        )}
      <Cursor
        collection={repositories}
        labels={labels}
        onLoadMore={onLoadMore}
        onRetryMore={onRetryMore}
      />
    </>
  );
}

/** Formats a profile creation time as the Paper date, e.g. "Oct 9, 2026". */
export function useProfileDate(): (value: string) => string {
  const { locale, timeZone } = useI18n();
  return (value) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone })
      .format(new Date(value));
}
