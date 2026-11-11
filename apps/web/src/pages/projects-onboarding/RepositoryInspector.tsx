import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import type {
  ApplicationResponse,
  RepositoryProfileResponse,
  RepositoryResponse,
  RoleBindingResponse,
} from "../../api/client.ts";
import { type ProjectsOnboardingLabels } from "./labels.ts";
import { readOnlyProfileHistoryRows } from "./identity.ts";
import { useProfileDate } from "./ProjectsLists.tsx";
import type { CursorCollection } from "./useCursorPages.ts";

type Props = Readonly<{
  application: ApplicationResponse;
  repository: RepositoryResponse | null;
  labels: ProjectsOnboardingLabels;
  profiles: CursorCollection<RepositoryProfileResponse> | null;
  selectedProfileId: string | null;
  roles: CursorCollection<RoleBindingResponse>;
  inspectionContent: ReactNode;
  variant: "column" | "stacked";
  onEdit: () => void;
  onProfileSelect: (id: string) => void;
  onCreateMapping: () => void;
  onRetryProfiles: () => void;
  onLoadMoreProfiles: () => void;
  onRetryMoreProfiles: () => void;
  onRetryRoles: () => void;
  onLoadMoreRoles: () => void;
  onRetryMoreRoles: () => void;
}>;

const shortDigest = (digest: string) =>
  `sha256:${digest.slice(0, 4)}…${digest.slice(-4)}`;

/** The selected repository (or application) beside the lists: profiles, inspection and roles. */
export function RepositoryInspector(props: Props) {
  const { application, labels, repository } = props;
  const formatDate = useProfileDate();
  const heading = repository === null
    ? application.name
    : `${repository.owner}/${repository.name}`;
  return (
    <UI.InspectorPanel
      header={
        <>
          <UI.Text variant="strong">{heading}</UI.Text>
          <UI.Button onClick={props.onEdit} variant="text">
            {repository === null
              ? labels.applications.editHeading
              : labels.repositories.editHeading}
          </UI.Button>
        </>
      }
      label={heading}
      variant={props.variant === "column" ? "sections" : "stacked"}
    >
      {repository === null ? null : (
        <UI.PaneSection
          heading="strong"
          ruled
          title={labels.profiles.heading}
        >
          <UI.Text variant="hint">{labels.profiles.description}</UI.Text>
          {props.profiles === null
            ? (
              <UI.Text variant="hint">
                {labels.profiles.repositoryRequired}
              </UI.Text>
            )
            : props.profiles.state === "loading"
            ? <UI.Skeleton shape="row" />
            : props.profiles.state === "error"
            ? (
              <UI.ErrorState
                action={
                  <UI.Button onClick={props.onRetryProfiles}>
                    {labels.errors.retry}
                  </UI.Button>
                }
                description={labels.errors.load}
                title={labels.errors.load}
              />
            )
            : (
              <>
                {readOnlyProfileHistoryRows(
                  repository.id,
                  repository.activeProfileId,
                  props.profiles.items,
                ).map((row) => {
                  const revision = labels.profiles.revisionNumber(
                    row.profile.revision,
                  );
                  const selectable = row.active &&
                    row.state === "legacy-v1" &&
                    repository.archivedAt === null;
                  return (
                    <UI.RevisionRow
                      controlLabel={selectable
                        ? `${labels.profiles.select}: ${revision}`
                        : undefined}
                      detail={shortDigest(row.profile.digest)}
                      key={row.profile.id}
                      onSelect={selectable
                        ? () => props.onProfileSelect(row.profile.id)
                        : undefined}
                      selected={props.selectedProfileId === row.profile.id}
                      title={revision}
                      trailing={row.active
                        ? (
                          <UI.StatusDot size="small" tone="success">
                            {labels.profiles.active}
                          </UI.StatusDot>
                        )
                        : formatDate(row.profile.createdAt)}
                    />
                  );
                })}
                {props.profiles.items.length === 0
                  ? <UI.Text variant="hint">{labels.profiles.empty}</UI.Text>
                  : null}
                {props.profiles.hasNext || props.profiles.moreError
                  ? (
                    <UI.CursorControls
                      hasNext={props.profiles.hasNext}
                      labels={labels.pagination}
                      onNext={props.onLoadMoreProfiles}
                      onRetry={props.onRetryMoreProfiles}
                      state={props.profiles.moreError
                        ? "error"
                        : props.profiles.loadingMore
                        ? "loading"
                        : "ready"}
                    />
                  )
                  : null}
              </>
            )}
        </UI.PaneSection>
      )}
      {props.inspectionContent}
      <RolesSummary {...props} />
    </UI.InspectorPanel>
  );
}

function RolesSummary(props: Props) {
  const { labels, repository, roles } = props;
  const relevant = roles.items.filter((role) =>
    repository === null || role.repositoryId === repository.id
  );
  const unique = (values: readonly (string | null)[]) =>
    [...new Set(values.filter((value): value is string => value !== null))]
      .join(", ");
  const active = relevant.some((role) => role.archivedAt === null);
  return (
    <UI.PaneSection heading="strong" title={labels.bindings.heading}>
      {roles.state === "loading"
        ? <UI.Skeleton shape="row" />
        : roles.state === "error"
        ? (
          <UI.ErrorState
            action={
              <UI.Button onClick={props.onRetryRoles}>
                {labels.errors.retry}
              </UI.Button>
            }
            description={labels.errors.load}
            title={labels.errors.load}
          />
        )
        : relevant.length === 0
        ? <UI.Text variant="hint">{labels.bindings.empty}</UI.Text>
        : (
          <>
            <UI.DetailRow label={labels.bindings.role} tone="code">
              {unique(relevant.map((role) => role.role))}
            </UI.DetailRow>
            <UI.DetailRow label={labels.bindings.aliasShort} tone="code">
              {unique(relevant.map((role) => role.alias)) || "—"}
            </UI.DetailRow>
            <UI.DetailRow
              label={labels.bindings.status}
              tone={active ? "positive" : "default"}
            >
              {active ? labels.bindings.active : labels.bindings.archived}
            </UI.DetailRow>
          </>
        )}
      {roles.hasNext || roles.moreError
        ? (
          <UI.CursorControls
            hasNext={roles.hasNext}
            labels={labels.pagination}
            onNext={props.onLoadMoreRoles}
            onRetry={props.onRetryMoreRoles}
            state={roles.moreError
              ? "error"
              : roles.loadingMore
              ? "loading"
              : "ready"}
          />
        )
        : null}
      <UI.Button onClick={props.onCreateMapping} variant="text">
        {labels.bindings.create}
      </UI.Button>
    </UI.PaneSection>
  );
}
