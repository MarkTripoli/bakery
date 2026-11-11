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
import { ApplicationSection } from "./ApplicationSection.tsx";
import { RepositoryEditor, RepositorySection } from "./RepositorySection.tsx";
import { ApplicationList, RepositoryList } from "./ProjectsLists.tsx";
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

type DialogName = "application" | "register" | "repository" | "bindings";

export function ProjectsOnboardingScreen(props: ProjectsOnboardingScreenProps) {
  const { labels } = props;
  const viewport = useShellViewport();
  const phone = viewport === "phone";
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
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
  const openApplication = () => setDialog("application");
  const inspector = props.selectedApplication === null
    ? null
    : (
      <RepositoryInspector
        application={props.selectedApplication}
        inspectionContent={props.inspectionContent}
        labels={labels}
        onCreateMapping={() => setDialog("bindings")}
        onEdit={() =>
          setDialog(
            props.selectedRepository === null ? "application" : "repository",
          )}
        onLoadMoreProfiles={props.onLoadMoreProfiles}
        onLoadMoreRoles={props.onLoadMoreRoles}
        onProfileSelect={(id) => {
          props.onProfileSelect(id);
          setSheetOpen(false);
        }}
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
  const createApplication = (
    <UI.Button onClick={openApplication}>
      <UI.IconGlyph name="plus" size="small" />
      {labels.applications.createHeading}
    </UI.Button>
  );
  return (
    <>
      <ShellFlushMain inset="page" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          items={[{ label: props.workspaceLabel }, { label: labels.title }]}
        />
      </ShellSlot>
      {props.scopeAvailable && !phone
        ? <ShellSlot name="actions">{createApplication}</ShellSlot>
        : null}
      {props.scopeAvailable && !phone && inspector !== null
        ? (
          <ShellSlot name="inspector" size="medium">
            {inspector}
          </ShellSlot>
        )
        : null}
      <div data-testid="projects-onboarding-page">
        <UI.PageHeader
          actions={phone && props.scopeAvailable
            ? createApplication
            : undefined}
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
              {phone
                ? (
                  <UI.ListSection
                    title={labels.applications.heading}
                    variant="list"
                  >
                    <ApplicationList
                      applications={props.applications}
                      labels={labels}
                      onLoadMore={props.onLoadMoreApplications}
                      onRetry={props.onRetryApplications}
                      onRetryMore={props.onRetryMoreApplications}
                      onSelect={props.onApplicationChange}
                      phone
                      selectedId={props.selectedApplicationId}
                    />
                  </UI.ListSection>
                )
                : (
                  <ApplicationList
                    applications={props.applications}
                    labels={labels}
                    onLoadMore={props.onLoadMoreApplications}
                    onRetry={props.onRetryApplications}
                    onRetryMore={props.onRetryMoreApplications}
                    onSelect={props.onApplicationChange}
                    phone={false}
                    selectedId={props.selectedApplicationId}
                  />
                )}
              <UI.ListSection
                actions={
                  <UI.Button
                    onClick={() => setDialog("register")}
                    variant={phone ? "text" : "outline"}
                  >
                    {labels.repositories.createHeading}
                  </UI.Button>
                }
                description={phone
                  ? undefined
                  : labels.repositories.description}
                title={labels.repositories.heading}
                variant={phone ? "list" : "table"}
              >
                <RepositoryList
                  labels={labels}
                  onLoadMore={props.onLoadMoreRepositories}
                  onRepositorySelect={(id) => {
                    props.onRepositorySelect(id);
                    if (phone) setSheetOpen(true);
                  }}
                  onRetry={props.onRetryRepositories}
                  onRetryMore={props.onRetryMoreRepositories}
                  phone={phone}
                  repositories={props.repositories}
                  selectedRepositoryId={props.selectedRepository?.id ?? null}
                />
              </UI.ListSection>
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
            </>
          )}
      </div>
      {props.scopeAvailable
        ? (
          <>
            <UI.Dialog
              onOpenChange={(open) => !open && close()}
              open={dialog === "application"}
              title={labels.applications.heading}
              variant="form"
            >
              {dialog === "application"
                ? (
                  <UI.SettingsContent>
                    <ApplicationSection
                      createPending={props.pending}
                      labels={labels}
                      onCreate={async (input) => {
                        await props.onCreateApplication(input);
                        close();
                      }}
                      onUpdate={props.onUpdateApplication}
                      selectedApplication={props.selectedApplication}
                      updatePending={props.pending}
                    />
                  </UI.SettingsContent>
                )
                : null}
            </UI.Dialog>
            <UI.Dialog
              onOpenChange={(open) => !open && close()}
              open={dialog === "register"}
              title={labels.repositories.createHeading}
              variant="form"
            >
              {dialog === "register"
                ? (
                  <UI.SettingsContent>
                    <RepositorySection
                      applications={props.applications}
                      createPending={props.pending}
                      labels={labels}
                      onApplicationChange={props.onApplicationChange}
                      onCreate={async (input) => {
                        await props.onCreateRepository(input);
                        close();
                      }}
                      selectedApplicationId={props.selectedApplicationId}
                    />
                  </UI.SettingsContent>
                )
                : null}
            </UI.Dialog>
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
            {phone && inspector !== null && props.selectedRepository !== null
              ? (
                <UI.Sheet
                  onOpenChange={setSheetOpen}
                  open={sheetOpen}
                  title={`${props.selectedRepository.owner}/${props.selectedRepository.name}`}
                >
                  {inspector}
                </UI.Sheet>
              )
              : null}
          </>
        )
        : null}
    </>
  );
}
