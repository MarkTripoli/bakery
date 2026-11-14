import { type ReactNode, useState } from "react";
import * as UI from "@bakery/ui";
import type {
  ApplicationCreate,
  ApplicationResponse,
  ApplicationUpdate,
  RepositoryBindingResolution,
  RepositoryBindingSelector,
  RepositoryCreate,
  RepositoryProfileCreate,
  RepositoryProfileResponse,
  RepositoryResponse,
  RepositoryUpdate,
  RoleBindingCreate,
  RoleBindingResponse,
  RoleBindingUpdate,
} from "../../api/client.ts";
import { RepositoryEditor } from "./RepositorySection.tsx";
import { RepositoryInspector } from "./RepositoryInspector.tsx";
import { useShellViewport } from "../../app/responsive.ts";
import { ShellFlushMain, ShellSlot } from "../../shell/shell-slots.tsx";
import { BindingSection } from "./BindingSection.tsx";
import { ProfileBoundary, ProfileSection } from "./ProfileSection.tsx";
import { TaskScopeSection } from "./TaskScopeSection.tsx";
import type { ProjectsOnboardingLabels } from "./labels.ts";
import type { CursorCollection } from "./useCursorPages.ts";

export type ProjectsOnboardingScreenProps = Readonly<{
  scopeAvailable: boolean;
  workspaceLabel: string;
  labels: ProjectsOnboardingLabels;
  applications: CursorCollection<ApplicationResponse>;
  repositories: CursorCollection<RepositoryResponse>;
  profiles: CursorCollection<RepositoryProfileResponse> | null;
  roles: CursorCollection<RoleBindingResponse>;
  resolutionKey: string;
  selectedApplicationId: string;
  selectedApplication: ApplicationResponse | null;
  selectedRepository: RepositoryResponse | null;
  selectedProfile: RepositoryProfileResponse | null;
  onApplicationChange: (id: string) => void;
  onRepositorySelect: (id: string) => void;
  onProfileSelect: (id: string | null) => void;
  onStaleProfileSelection: () => Promise<void>;
  onCreateApplication: (input: ApplicationCreate) => Promise<void>;
  onUpdateApplication: (
    id: string,
    input: ApplicationUpdate,
    ifMatch: string,
  ) => Promise<void>;
  onCreateRepository: (input: RepositoryCreate) => Promise<void>;
  onUpdateRepository: (
    id: string,
    input: RepositoryUpdate,
    ifMatch: string,
  ) => Promise<void>;
  onCreateProfile: (
    id: string,
    input: RepositoryProfileCreate,
  ) => Promise<void>;
  onCreateRole: (input: RoleBindingCreate) => Promise<void>;
  onUpdateRole: (id: string, input: RoleBindingUpdate) => Promise<void>;
  onResolve: (
    input: RepositoryBindingSelector,
  ) => Promise<RepositoryBindingResolution>;
  onRetryApplications: () => void;
  onLoadMoreApplications: () => void;
  onRetryMoreApplications: () => void;
  onRetryRepositories: () => void;
  onLoadMoreRepositories: () => void;
  onRetryMoreRepositories: () => void;
  onRetryProfiles: () => void;
  onLoadMoreProfiles: () => void;
  onRetryMoreProfiles: () => void;
  onRetryRoles: () => void;
  onLoadMoreRoles: () => void;
  onRetryMoreRoles: () => void;
  pending: boolean;
  inspectionContent?: ReactNode;
}>;

type DialogName = "repository" | "bindings";

export function ProjectsOnboardingScreen(props: ProjectsOnboardingScreenProps) {
  const { labels } = props;
  const viewport = useShellViewport();
  const phone = viewport === "phone";
  const [dialog, setDialog] = useState<DialogName | null>(null);
  // The task scope stays for a repository once its profile was reviewed, so a
  // conflict that clears the profile pin keeps the preserved draft visible.
  const [reviewedRepository, setReviewedRepository] = useState<string | null>(
    null,
  );
  if (
    props.selectedProfile !== null && props.selectedRepository !== null &&
    reviewedRepository !== props.selectedRepository.id
  ) setReviewedRepository(props.selectedRepository.id);
  const close = () => setDialog(null);
  const inspector = props.selectedApplication === null
    ? null
    : (
      <RepositoryInspector
        application={props.selectedApplication}
        inspectionContent={props.inspectionContent}
        labels={labels}
        onCreateMapping={() => setDialog("bindings")}
        onEdit={() => setDialog("repository")}
        onLoadMoreProfiles={props.onLoadMoreProfiles}
        onLoadMoreRoles={props.onLoadMoreRoles}
        onProfileSelect={props.onProfileSelect}
        onRetryMoreProfiles={props.onRetryMoreProfiles}
        onRetryMoreRoles={props.onRetryMoreRoles}
        onRetryProfiles={props.onRetryProfiles}
        onRetryRoles={props.onRetryRoles}
        profiles={props.profiles}
        repository={props.selectedRepository}
        roles={props.roles}
        selectedProfileId={props.selectedProfile?.id ?? null}
        variant={viewport === "desktop" ? "column" : "stacked"}
      />
    );
  return (
    <>
      <ShellFlushMain inset="page" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          items={[
            { href: "/tasks", label: props.workspaceLabel },
            { href: "/projects", label: labels.projectsList },
            ...(props.selectedRepository === null ? [] : [{
              label:
                `${props.selectedRepository.owner}/${props.selectedRepository.name}`,
            }]),
          ]}
        />
      </ShellSlot>
      {props.scopeAvailable && !phone && inspector !== null
        ? (
          <ShellSlot name="inspector" size="medium">
            {inspector}
          </ShellSlot>
        )
        : null}
      <div data-testid="projects-onboarding-page">
        <UI.PageHeader
          subtitle={<p>{labels.description}</p>}
          title={labels.title}
          variant="list"
        />
        {!props.scopeAvailable
          ? (
            <UI.PaneSection>
              <UI.InlineNotice tone="warning">
                {labels.scopeRequired}
              </UI.InlineNotice>
            </UI.PaneSection>
          )
          : (
            <>
              {props.selectedRepository !== null &&
                  props.selectedApplication !== null &&
                  (props.selectedProfile !== null ||
                    reviewedRepository === props.selectedRepository.id)
                ? (
                  <UI.PaneSection data-testid="projects-onboarding-details">
                    <UI.SettingsContent>
                      {props.selectedProfile === null ? null : (
                        <ProfileBoundary
                          labels={labels}
                          repository={props.selectedRepository}
                          selectedProfile={props.selectedProfile}
                        />
                      )}
                      <TaskScopeSection
                        key={props.selectedRepository.id}
                        application={props.selectedApplication}
                        repository={props.selectedRepository}
                        profile={props.selectedProfile}
                        labels={labels}
                        onStaleSelection={props.onStaleProfileSelection}
                      />
                    </UI.SettingsContent>
                  </UI.PaneSection>
                )
                : null}
              {phone && inspector !== null && props.selectedRepository !== null
                ? (
                  <div data-testid="projects-onboarding-inspector">
                    {inspector}
                  </div>
                )
                : null}
            </>
          )}
      </div>
      {props.scopeAvailable
        ? (
          <>
            <UI.Dialog
              onOpenChange={(open) => !open && close()}
              open={dialog === "repository" &&
                props.selectedRepository !== null}
              title={labels.repositories.editHeading}
              variant="form"
            >
              {dialog === "repository" && props.selectedRepository !== null
                ? (
                  <UI.SettingsContent>
                    <RepositoryEditor
                      key={`${props.selectedRepository.id}:${props.selectedRepository.version}`}
                      labels={labels}
                      onLoadMoreProfiles={props.onLoadMoreProfiles}
                      onRetryMoreProfiles={props.onRetryMoreProfiles}
                      onRetryProfiles={props.onRetryProfiles}
                      onUpdate={props.onUpdateRepository}
                      profiles={props.profiles}
                      repository={props.selectedRepository}
                      updatePending={props.pending}
                    />
                    {props.profiles?.state === "ready"
                      ? (
                        <ProfileSection
                          key={props.selectedRepository.id}
                          repository={props.selectedRepository}
                          profiles={props.profiles}
                          selectedProfile={props.selectedProfile}
                          labels={labels}
                          pending={props.pending}
                          onCreate={props.onCreateProfile}
                          onUpdate={props.onUpdateRepository}
                          onSelect={(id) => {
                            props.onProfileSelect(id);
                            close();
                          }}
                        />
                      )
                      : null}
                  </UI.SettingsContent>
                )
                : null}
            </UI.Dialog>
            <UI.Dialog
              onOpenChange={(open) => !open && close()}
              open={dialog === "bindings"}
              title={labels.bindings.heading}
              variant="form"
            >
              {dialog === "bindings"
                ? (
                  <UI.SettingsContent>
                    <BindingSection
                      applicationId={props.selectedApplicationId}
                      labels={labels}
                      repositories={props.repositories.items}
                      roles={props.roles}
                      resolutionKey={props.resolutionKey}
                      pending={props.pending}
                      onCreate={props.onCreateRole}
                      onUpdate={props.onUpdateRole}
                      onResolve={props.onResolve}
                      onRetry={props.onRetryRoles}
                      onLoadMore={props.onLoadMoreRoles}
                      onRetryMore={props.onRetryMoreRoles}
                    />
                  </UI.SettingsContent>
                )
                : null}
            </UI.Dialog>
          </>
        )
        : null}
    </>
  );
}
