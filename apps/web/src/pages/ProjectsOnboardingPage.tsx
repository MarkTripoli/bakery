import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import {
  type ApiFailure,
  type ApiResult,
  type ApplicationResponse,
  authProblemCode,
  type RepositoryOnboardingResponse,
  type RepositoryProfileResponse,
  type RepositoryResponse,
  type RoleBindingResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  applicationQueryOptions,
  applicationsListQueryOptions,
  repositoriesListQueryOptions,
  repositoryProfilesListQueryOptions,
  repositoryQueryOptions,
  repositoryRolesListQueryOptions,
} from "../api/query.ts";
import {
  ORGANIZATIONS_PATH,
  RECOVERY_CODE_PATH,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { rememberDestination } from "../app/auth-return.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import {
  useProtectedScope,
  useQueryScopeController,
} from "../app/query-scope-context.tsx";
import {
  ProjectsOnboardingScreen,
  type ProjectsOnboardingScreenProps,
} from "./projects-onboarding/ProjectsOnboardingScreen.tsx";
import type { ProjectsOnboardingLabels } from "./projects-onboarding/labels.ts";
import {
  findExactById,
  mergeCursorItems,
  type ProjectsOnboardingSelection,
  validatedProjectsOnboardingSelection,
} from "./projects-onboarding/identity.ts";
import { useCursorPages } from "./projects-onboarding/useCursorPages.ts";
import { RepositoryInspectionSection } from "./projects-onboarding/RepositoryInspectionSection.tsx";

export type ProjectsOnboardingPageProps = Readonly<{
  labels: ProjectsOnboardingLabels;
  /** Design fixtures only: an inspection already started for its repository. */
  initialInspection?: RepositoryOnboardingResponse;
  /** The workspace name shown in the breadcrumb; defaults to "Workspace". */
  workspaceName?: string;
}>;

export function ProjectsOnboardingPage(
  { labels, initialInspection, workspaceName }: ProjectsOnboardingPageProps,
) {
  const scope = useProtectedScope();
  const api = useBakeryApi();
  const queryScope = useQueryScopeController();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  const { translate } = useI18n();
  const locationToken =
    `${location.pathname}${location.searchStr}#${location.hash}`;
  const locationRef = useRef(locationToken);
  locationRef.current = locationToken;
  const scoped = scope.organizationId !== null;
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<unknown>(null);
  // Layout cleanup cancels the old destination before late resolution can
  // publish scope. The shared resolver independently rejects replaced identity.
  useLayoutEffect(() => {
    setFailure(null);
    if (scoped || location.pathname !== "/projects/onboarding") return;
    const initialScope = queryScope.getSnapshot();
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted &&
      queryScope.getSnapshot() === initialScope &&
      locationRef.current === locationToken;
    void (async () => {
      try {
        const outcome = await organizationSelection.resolve(
          api,
          queryScope,
          undefined,
          controller.signal,
        );
        if (!current() || outcome !== "choose") return;
        rememberDestination(location);
        await navigate({ to: ORGANIZATIONS_PATH });
      } catch (error) {
        if (!current()) return;
        setFailure(error);
      }
    })();
    return () => controller.abort();
  }, [
    api,
    attempt,
    location,
    locationToken,
    navigate,
    queryScope,
    scoped,
    scope.sessionGeneration,
  ]);
  const selection = validatedProjectsOnboardingSelection(location.search);
  const updateSelection = useCallback(
    (next: ProjectsOnboardingSelection) =>
      navigate({
        to: "/projects/onboarding",
        search: {
          application: next.application,
          repository: next.repository,
          profile: next.profile,
        },
        replace: true,
        // Selection changes stay in this page, including a stale-profile reset.
        resetScroll: false,
      }),
    [navigate],
  );

  if (!scoped) {
    const code = authProblemCode(failure);
    const forbidden = code === "AUTH_FORBIDDEN";
    const authRequired = code !== null && !forbidden;
    const offline = typeof failure === "object" && failure !== null &&
      "kind" in failure && failure.kind === "network";
    const recover = (
      to:
        | typeof SIGN_IN_PATH
        | typeof TWO_FACTOR_PATH
        | typeof RECOVERY_CODE_PATH
        | typeof ORGANIZATIONS_PATH,
    ) => {
      if (
        queryScope.getSnapshot() !== scope ||
        locationRef.current !== locationToken
      ) return;
      rememberDestination(location);
      if (forbidden) organizationSelection.handleForbidden(queryScope);
      void navigate({
        to,
        ...(forbidden
          ? { search: { reason: "forbidden" } }
          : code === "AUTH_EXPIRED" || code === "AUTH_INVALID"
          ? { search: { reason: "expired" } }
          : {}),
      });
    };
    const action = forbidden
      ? (
        <UI.Button onClick={() => recover(ORGANIZATIONS_PATH)}>
          {translate("auth.organizations.title")}
        </UI.Button>
      )
      : authRequired
      ? code === "AUTH_FACTOR_REQUIRED"
        ? (
          <UI.Inline gap="compact" variant="actions">
            <UI.Button onClick={() => recover(TWO_FACTOR_PATH)}>
              {translate("auth.twoFactor.verify")}
            </UI.Button>
            <UI.Link
              href={RECOVERY_CODE_PATH}
              onClick={(event) => {
                event.preventDefault();
                recover(RECOVERY_CODE_PATH);
              }}
            >
              {translate("auth.twoFactor.useBackupCode")}
            </UI.Link>
          </UI.Inline>
        )
        : (
          <UI.Button onClick={() => recover(SIGN_IN_PATH)}>
            {translate("auth.signIn.submit")}
          </UI.Button>
        )
      : (
        <UI.Button onClick={() => setAttempt((value) => value + 1)}>
          {labels.errors.retry}
        </UI.Button>
      );
    return (
      <UI.SettingsContent>
        <UI.Stack gap="spacious">
          <header>
            <UI.Heading level="page" tabIndex={-1}>{labels.title}</UI.Heading>
            <p>{labels.description}</p>
          </header>
          {failure === null ? <UI.Skeleton shape="surface" /> : (
            <UI.ErrorState
              data-testid="projects-scope-error"
              title={forbidden
                ? translate("shell.states.forbiddenTitle")
                : authRequired
                ? translate("shell.states.authRequiredTitle")
                : offline
                ? translate("shell.states.offlineTitle")
                : labels.errors.load}
              description={forbidden
                ? translate("shell.states.forbiddenDescription")
                : authRequired
                ? translate("shell.states.authRequiredDescription")
                : offline
                ? translate("shell.states.offlineDescription")
                : labels.errors.load}
              action={action}
            />
          )}
        </UI.Stack>
      </UI.SettingsContent>
    );
  }
  return (
    <TenantProjects
      key={`${scope.sessionGeneration}:${scope.organizationId ?? "none"}`}
      labels={labels}
      initialInspection={initialInspection}
      workspaceName={workspaceName}
      selection={selection}
      onSelectionChange={updateSelection}
    />
  );
}

type TenantProjectsProps =
  & ProjectsOnboardingPageProps
  & Readonly<{
    selection: ProjectsOnboardingSelection;
    onSelectionChange: (selection: ProjectsOnboardingSelection) => void;
  }>;

function TenantProjects(
  { labels, initialInspection, workspaceName, selection, onSelectionChange }:
    TenantProjectsProps,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [applicationId, setApplicationId] = useState(
    selection.application ?? "",
  );
  const [repositoryId, setRepositoryId] = useState<string | null>(
    selection.repository ?? null,
  );
  const [profileId, setProfileId] = useState<string | null>(
    selection.profile ?? null,
  );
  useEffect(() => {
    setApplicationId(selection.application ?? "");
    setRepositoryId(selection.repository ?? null);
    setProfileId(selection.profile ?? null);
  }, [selection.application, selection.profile, selection.repository]);
  const applications = useQuery({
    ...applicationsListQueryOptions(api, scope),
    enabled: scope.organizationId !== null,
  });
  const repositories = useQuery({
    ...repositoriesListQueryOptions(api, scope),
    enabled: scope.organizationId !== null,
  });
  const resetKey = `${scope.sessionGeneration}:${
    scope.organizationId ?? "none"
  }`;
  const applicationPages = useCursorPages<ApplicationResponse>(
    applications,
    resetKey,
    useCallback((cursor) =>
      queryClient.fetchQuery(
        applicationsListQueryOptions(api, scope, { cursor }),
      ), [api, queryClient, scope]),
  );
  const repositoryPages = useCursorPages<RepositoryResponse>(
    repositories,
    resetKey,
    useCallback((cursor) =>
      queryClient.fetchQuery(
        repositoriesListQueryOptions(api, scope, { cursor }),
      ), [api, queryClient, scope]),
  );
  const selectApplication = (id: string) => {
    if (id !== "" && findExactById(applicationPages.items, id) === null) return;
    setApplicationId(id);
    setRepositoryId(null);
    setProfileId(null);
    onSelectionChange(id === "" ? {} : { application: id });
  };
  const selectRepository = (id: string) => {
    const repository = findExactById(repositoryPages.items, id);
    if (repository === null) return;
    setApplicationId(repository.applicationId);
    setRepositoryId(id);
    setProfileId(null);
    onSelectionChange({
      application: repository.applicationId,
      repository: id,
    });
  };
  const selectProfile = (id: string | null) => {
    setProfileId(id);
    onSelectionChange({
      ...(applicationId === "" ? {} : { application: applicationId }),
      ...(repositoryId === null ? {} : { repository: repositoryId }),
      ...(id === null ? {} : { profile: id }),
    });
  };
  return (
    <SelectionProjects
      key={`${applicationId}:${repositoryId ?? "none"}`}
      labels={labels}
      initialInspection={initialInspection}
      workspaceName={workspaceName}
      applicationId={applicationId}
      repositoryId={repositoryId}
      profileId={profileId}
      applications={applicationPages}
      repositories={repositoryPages}
      repositoryDataUpdatedAt={repositories.dataUpdatedAt}
      onApplicationChange={selectApplication}
      onRepositorySelect={selectRepository}
      onProfileSelect={selectProfile}
      onRetryApplications={() => void applications.refetch()}
      onLoadMoreApplications={applicationPages.loadMore}
      onRetryMoreApplications={applicationPages.retryMore}
      onRetryRepositories={() => void repositories.refetch()}
      onLoadMoreRepositories={repositoryPages.loadMore}
      onRetryMoreRepositories={repositoryPages.retryMore}
    />
  );
}

type SelectionProps =
  & Pick<
    ProjectsOnboardingScreenProps,
    | "labels"
    | "applications"
    | "repositories"
    | "onApplicationChange"
    | "onRepositorySelect"
    | "onRetryApplications"
    | "onLoadMoreApplications"
    | "onRetryMoreApplications"
    | "onRetryRepositories"
    | "onLoadMoreRepositories"
    | "onRetryMoreRepositories"
  >
  & {
    applicationId: string;
    repositoryId: string | null;
    profileId: string | null;
    repositoryDataUpdatedAt: number;
    initialInspection?: RepositoryOnboardingResponse;
    workspaceName?: string;
    onProfileSelect: (id: string | null) => void;
  };

function SelectionProjects(props: SelectionProps) {
  const { labels, applicationId, repositoryId, profileId } = props;
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  // A selection/session remount aborts reads and mutations and discards their feedback.
  const [controller] = useState(() => ({ current: new AbortController() }));
  useEffect(() => {
    if (controller.current.signal.aborted) {
      controller.current = new AbortController();
    }
    const mountedController = controller.current;
    return () => mountedController.abort();
  }, [controller]);
  const detail = useQuery({
    ...repositoryQueryOptions(api, scope, repositoryId ?? ""),
    enabled: scope.organizationId !== null && repositoryId !== null,
  });
  const selectedRepository = detail.data?.id === repositoryId &&
      detail.data.applicationId === applicationId && !detail.isError
    ? detail.data
    : null;
  const applicationDetail = useQuery({
    ...applicationQueryOptions(api, scope, applicationId),
    enabled: scope.organizationId !== null && applicationId !== "",
  });
  const selectedApplication =
    applicationDetail.data?.id === applicationId && !applicationDetail.isError
      ? applicationDetail.data
      : null;
  useEffect(() => {
    if (applicationId === "" || applicationDetail.isPending) return;
    if (
      (applicationDetail.isError && isNotFound(applicationDetail.error)) ||
      (applicationDetail.data !== undefined && selectedApplication === null)
    ) props.onApplicationChange("");
  }, [
    applicationDetail.data,
    applicationDetail.error,
    applicationDetail.isError,
    applicationDetail.isPending,
    applicationId,
    props.onApplicationChange,
    selectedApplication,
  ]);
  useEffect(() => {
    if (repositoryId === null || detail.isPending) return;
    if (
      (detail.isError && isNotFound(detail.error)) ||
      (detail.data !== undefined && selectedRepository === null)
    ) props.onApplicationChange("");
  }, [
    detail.data,
    detail.error,
    detail.isError,
    detail.isPending,
    props.onApplicationChange,
    repositoryId,
    selectedRepository,
  ]);
  const profilesQuery = useQuery({
    ...repositoryProfilesListQueryOptions(api, scope, repositoryId ?? ""),
    enabled: scope.organizationId !== null && selectedRepository !== null,
  });
  const rolesQuery = useQuery({
    ...repositoryRolesListQueryOptions(api, scope, applicationId),
    enabled: scope.organizationId !== null && applicationId !== "",
  });
  const resetKey = `${scope.sessionGeneration}:${
    scope.organizationId ?? "none"
  }:${applicationId}:${repositoryId ?? "none"}`;
  const profiles = useCursorPages<RepositoryProfileResponse>(
    profilesQuery,
    resetKey,
    useCallback((cursor) =>
      queryClient.fetchQuery(
        repositoryProfilesListQueryOptions(api, scope, repositoryId ?? "", {
          cursor,
        }),
      ), [api, queryClient, scope, repositoryId]),
  );
  const roles = useCursorPages<RoleBindingResponse>(
    rolesQuery,
    resetKey,
    useCallback((cursor) =>
      queryClient.fetchQuery(
        repositoryRolesListQueryOptions(api, scope, applicationId, { cursor }),
      ), [api, queryClient, scope, applicationId]),
  );
  const selectedProfile = selectedRepository === null
    ? null
    : findExactById(profiles.items, profileId);
  const confirmedProfile = selectedRepository !== null &&
      selectedProfile?.repositoryId === selectedRepository.id &&
      selectedRepository.activeProfileId === profileId
    ? selectedProfile
    : null;
  useEffect(() => {
    if (
      profileId !== null && profiles.state === "ready" &&
      confirmedProfile === null
    ) props.onProfileSelect(null);
  }, [confirmedProfile, profileId, profiles.state, props.onProfileSelect]);
  // One hook runs every onboarding step, because the steps share this pending
  // and error state. The name is therefore the runner, not the step: a report
  // says which surface failed, and the stack says which step.
  const mutation = useMutation<void, ApiFailure, () => Promise<void>>({
    mutationKey: ["projectsOnboarding.run"],
    mutationFn: (action) => action(),
  });
  const accept = async <T,>(
    result: Promise<ApiResult<T>>,
    valid: (data: T) => boolean,
  ): Promise<T> => {
    const signal = controller.current.signal;
    if (signal.aborted || scope.organizationId === null) throw invalidScope();
    const response = await result;
    if (signal.aborted) throw invalidScope();
    if (!response.ok) throw response.error;
    if (!valid(response.data)) throw invalidScope();
    return response.data;
  };
  const refresh = async () => {
    if (controller.current.signal.aborted) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: applicationsListQueryOptions(api, scope).queryKey.slice(
          0,
          -1,
        ),
      }),
      queryClient.invalidateQueries({
        queryKey: applicationQueryOptions(api, scope, applicationId).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: repositoriesListQueryOptions(api, scope).queryKey.slice(
          0,
          -1,
        ),
      }),
      queryClient.invalidateQueries({
        queryKey:
          repositoryQueryOptions(api, scope, repositoryId ?? "").queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: repositoryProfilesListQueryOptions(
          api,
          scope,
          repositoryId ?? "",
        ).queryKey.slice(0, -1),
      }),
      queryClient.invalidateQueries({
        queryKey: repositoryRolesListQueryOptions(api, scope, applicationId)
          .queryKey.slice(0, -1),
      }),
    ]);
    if (controller.current.signal.aborted) throw invalidScope();
  };
  const run = (action: () => Promise<void>) =>
    mutation.mutateAsync(async () => {
      if (controller.current.signal.aborted || scope.organizationId === null) {
        throw invalidScope();
      }
      try {
        await action();
        await refresh();
      } catch (cause) {
        const failure = cause as ApiFailure;
        if (
          !controller.current.signal.aborted && failure.kind === "problem" &&
          (failure.problem.status === 409 || failure.problem.status === 412)
        ) {
          await refresh();
        }
        throw cause;
      }
    });
  const options = {
    organizationId: scope.organizationId ?? "",
    get signal() {
      return controller.current.signal;
    },
  };
  const roleAuthorized = (role: RoleBindingResponse) =>
    role.organizationId === scope.organizationId &&
    role.applicationId === applicationId;
  const callbacks: Pick<
    ProjectsOnboardingScreenProps,
    | "onCreateApplication"
    | "onUpdateApplication"
    | "onCreateRepository"
    | "onUpdateRepository"
    | "onCreateProfile"
    | "onCreateRole"
    | "onUpdateRole"
    | "onResolve"
  > = {
    onCreateApplication: (input) =>
      run(async () => {
        await accept(
          api.createApplication({
            ...options,
            input,
            idempotencyKey: crypto.randomUUID(),
          }),
          (data) => data.slug === input.slug,
        );
      }),
    onUpdateApplication: (id, input, ifMatch) =>
      run(async () => {
        if (selectedApplication?.id !== id) throw invalidScope();
        await accept(
          api.updateApplication({
            ...options,
            id,
            input,
            ifMatch,
            idempotencyKey: crypto.randomUUID(),
          }),
          (data) => data.id === id,
        );
      }),
    onCreateRepository: (input) =>
      run(async () => {
        if (
          selectedApplication?.id !== input.applicationId ||
          selectedApplication.archivedAt !== null
        ) throw invalidScope();
        await accept(
          api.createRepository({
            ...options,
            input,
            idempotencyKey: crypto.randomUUID(),
          }),
          (data) => data.applicationId === input.applicationId,
        );
      }),
    onUpdateRepository: (id, input, ifMatch) =>
      run(async () => {
        if (selectedRepository?.id !== id) throw invalidScope();
        await accept(
          api.updateRepository({
            ...options,
            id,
            input,
            ifMatch,
            idempotencyKey: crypto.randomUUID(),
          }),
          (data) => data.id === id && data.applicationId === applicationId,
        );
      }),
    onCreateProfile: (id, input) =>
      run(async () => {
        if (selectedRepository?.id !== id) throw invalidScope();
        await accept(
          api.createRepositoryProfile({
            ...options,
            repositoryId: id,
            input,
            idempotencyKey: crypto.randomUUID(),
          }),
          (data) =>
            data.repositoryId === id && data.revision === input.revision &&
            data.digest === input.digest,
        );
      }),
    onCreateRole: (input) =>
      run(async () => {
        if (
          input.applicationId !== applicationId ||
          selectedApplication?.archivedAt !== null
        ) throw invalidScope();
        await accept(
          api.createRepositoryRole({
            ...options,
            input,
            idempotencyKey: crypto.randomUUID(),
          }),
          roleAuthorized,
        );
      }),
    onUpdateRole: (id, input) =>
      run(async () => {
        if (
          !roles.items.some((role) => role.id === id && roleAuthorized(role))
        ) throw invalidScope();
        await accept(
          api.updateRepositoryRole({
            ...options,
            applicationId,
            roleId: id,
            input,
            idempotencyKey: crypto.randomUUID(),
          }),
          (data) => data.id === id && roleAuthorized(data),
        );
      }),
    onResolve: async (input) => {
      if (
        controller.current.signal.aborted || scope.organizationId === null ||
        applicationId === ""
      ) throw invalidScope();
      return await accept(
        api.resolveRepositoryRole({ ...options, applicationId, input }),
        (data) => {
          if (data.status === "resolved") {
            const binding = data.binding;
            const hasProfile = binding.repositoryProfileId !== null;
            return binding.organizationId === scope.organizationId &&
              binding.applicationId === applicationId &&
              (!("repositoryId" in input) ||
                binding.repositoryId === input.repositoryId) &&
              (binding.repositoryProfileRevision !== null) === hasProfile &&
              (binding.repositoryProfileDigest !== null) === hasProfile &&
              binding.observationId === null &&
              binding.observationDigest === null && binding.baseSha === null;
          }
          if (data.status === "ambiguous") {
            const ids = data.candidates.map((candidate) =>
              candidate.repositoryId
            );
            return ids.length >= 2 && ids.length <= 32 &&
              new Set(ids).size === ids.length &&
              ids.every((id, index) => index === 0 || ids[index - 1] < id) &&
              typeof data.truncated === "boolean" &&
              (!data.truncated || ids.length === 32) &&
              data.candidates.every((candidate) =>
                candidate.hasEligibleObservation === false
              );
          }
          return data.status === "unavailable" &&
            (data.reason === "no_matching_binding" ||
              data.reason === "repository_not_found" ||
              data.reason === "repository_archived");
        },
      );
    },
  };
  return (
    <>
      {mutation.isError
        ? (
          <UI.InlineNotice role="alert" tone="error">
            {mutation.error.kind === "problem" &&
                (mutation.error.problem.status === 409 ||
                  mutation.error.problem.status === 412)
              ? labels.errors.conflict
              : labels.errors.mutation}
          </UI.InlineNotice>
        )
        : null}
      {applicationId !== "" && applicationDetail.isPending
        ? <UI.Skeleton shape="row" />
        : null}
      {applicationId !== "" && applicationDetail.isError
        ? (
          <UI.ErrorState
            title={labels.errors.load}
            description={labels.errors.load}
            action={
              <UI.Button onClick={() => void applicationDetail.refetch()}>
                {labels.errors.retry}
              </UI.Button>
            }
          />
        )
        : null}
      {repositoryId !== null && detail.isPending
        ? <UI.Skeleton shape="row" />
        : null}
      {repositoryId !== null &&
          (detail.isError ||
            (detail.data !== undefined && selectedRepository === null))
        ? (
          <UI.ErrorState
            title={labels.errors.load}
            description={labels.errors.load}
            action={
              <UI.Button onClick={() => void detail.refetch()}>
                {labels.errors.retry}
              </UI.Button>
            }
          />
        )
        : null}
      <ProjectsOnboardingScreen
        {...props}
        {...callbacks}
        applications={{
          ...props.applications,
          items: mergeCursorItems([
            selectedApplication === null ? [] : [selectedApplication],
            props.applications.items,
          ]),
        }}
        repositories={{
          ...props.repositories,
          items: mergeCursorItems([
            selectedRepository === null ? [] : [selectedRepository],
            props.repositories.items,
          ]),
        }}
        scopeAvailable={scope.organizationId !== null}
        workspaceLabel={props.workspaceName ??
          translate("shell.navigation.workspace")}
        selectedApplicationId={applicationId}
        selectedApplication={selectedApplication}
        selectedRepository={selectedRepository}
        selectedProfile={confirmedProfile}
        profiles={selectedRepository === null ? null : profiles}
        onStaleProfileSelection={async () => {
          props.onProfileSelect(null);
          await refresh();
        }}
        inspectionContent={selectedRepository !== null &&
            selectedApplication !== null
          ? (
            <RepositoryInspectionSection
              key={resetKey}
              repository={selectedRepository}
              applicationArchived={selectedApplication.archivedAt !== null}
              initialInspection={props.initialInspection}
              lifecyclePending={mutation.isPending}
              labels={labels}
            />
          )
          : null}
        roles={roles}
        resolutionKey={`${mutation.isPending}:${props.repositoryDataUpdatedAt}:${props.repositories.state}:${applicationDetail.dataUpdatedAt}:${applicationDetail.status}:${detail.dataUpdatedAt}:${detail.status}:${rolesQuery.dataUpdatedAt}:${roles.state}`}
        onRetryProfiles={() => void profilesQuery.refetch()}
        onLoadMoreProfiles={profiles.loadMore}
        onRetryMoreProfiles={profiles.retryMore}
        onRetryRoles={() => void rolesQuery.refetch()}
        onLoadMoreRoles={roles.loadMore}
        onRetryMoreRoles={roles.retryMore}
        pending={mutation.isPending}
      />
    </>
  );
}

function isNotFound(error: unknown): boolean {
  const failure = error as ApiFailure;
  return failure?.kind === "problem" && failure.problem.status === 404;
}

function invalidScope(): ApiFailure {
  return { kind: "invalid-response", status: 0 };
}
