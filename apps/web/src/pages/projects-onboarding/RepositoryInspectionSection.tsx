import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type {
  ApiFailure,
  RepositoryOnboardingResponse,
  RepositoryResponse,
} from "../../api/client.ts";
import { useBakeryApi } from "../../api/context.tsx";
import {
  repositoriesListQueryOptions,
  repositoryOnboardingQueryOptions,
  repositoryProfileObservationQueryOptions,
  repositoryProfilesListQueryOptions,
  repositoryQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { InspectionStatus, inspectionTone } from "./InspectionStatus.tsx";
import { RepositoryObservation } from "./RepositoryObservation.tsx";
import type { ProjectsOnboardingLabels } from "./labels.ts";

export function RepositoryInspectionSection(
  {
    repository,
    applicationArchived,
    lifecyclePending,
    labels,
    initialInspection,
  }: Readonly<{
    initialInspection?: RepositoryOnboardingResponse;
    repository: RepositoryResponse;
    applicationArchived: boolean;
    lifecyclePending: boolean;
    labels: ProjectsOnboardingLabels;
  }>,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  const [started, setStarted] = useState<RepositoryOnboardingResponse | null>(
    initialInspection?.repositoryId === repository.id
      ? initialInspection
      : null,
  );
  // The parent remounts this section on session, organization or selection changes.
  const [controller] = useState(() => ({ current: new AbortController() }));
  useEffect(() => {
    if (controller.current.signal.aborted) {
      controller.current = new AbortController();
    }
    const mountedController = controller.current;
    return () => mountedController.abort();
  }, [controller]);
  const statusOptions = repositoryOnboardingQueryOptions(
    api,
    scope,
    repository.id,
    started?.id ?? "",
    started?.jobId ?? "",
  );
  const status = useQuery({
    ...statusOptions,
    enabled: scope.organizationId !== null && started !== null,
  });
  const onboarding = status.data ?? started;
  const completed = !status.isError && onboarding?.status === "completed"
    ? onboarding
    : null;
  const observation = useQuery({
    ...repositoryProfileObservationQueryOptions(
      api,
      scope,
      repository.applicationId,
      completed,
    ),
    enabled: scope.organizationId !== null &&
      completed?.observationId != null &&
      completed.profileId !== null,
  });
  const archived = applicationArchived || repository.archivedAt !== null;
  const inFlight = onboarding?.status === "queued" ||
    onboarding?.status === "running";
  const start = useMutation<void, ApiFailure>({
    mutationKey: ["repositoryOnboardings.start"],
    mutationFn: async () => {
      const signal = controller.current.signal;
      if (
        signal.aborted || scope.organizationId === null || archived ||
        repository.activeProfileId === null || lifecyclePending || inFlight
      ) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      const result = await api.startRepositoryOnboarding({
        organizationId: scope.organizationId,
        repositoryId: repository.id,
        idempotencyKey: crypto.randomUUID(),
        signal,
      });
      if (signal.aborted) {
        throw { kind: "invalid-response", status: 0 } satisfies ApiFailure;
      }
      if (!result.ok) throw result.error;
      if (result.data.repositoryId !== repository.id) {
        throw { kind: "invalid-response", status: 200 } satisfies ApiFailure;
      }
      queryClient.setQueryData(
        repositoryOnboardingQueryOptions(
          api,
          scope,
          repository.id,
          result.data.id,
          result.data.jobId,
        ).queryKey,
        result.data,
      );
      setStarted(result.data);
    },
  });
  // Publication may have advanced the active profile. Refresh the existing lifecycle
  // and binding inputs without replacing the exact observation with a latest lookup.
  const completedId = completed?.id ?? null;
  useEffect(() => {
    if (completedId === null) return;
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: repositoryQueryOptions(api, scope, repository.id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: repositoryProfilesListQueryOptions(api, scope, repository.id)
          .queryKey.slice(0, -1),
      }),
      queryClient.invalidateQueries({
        queryKey: repositoriesListQueryOptions(api, scope).queryKey.slice(
          0,
          -1,
        ),
      }),
    ]);
  }, [api, completedId, queryClient, repository.id, scope]);
  const statusLabels = {
    queued: translate("projects.onboarding.inspection.status.queued"),
    running: translate("projects.onboarding.inspection.status.running"),
    completed: translate("projects.onboarding.inspection.status.completed"),
    failed: translate("projects.onboarding.inspection.status.failed"),
    canceled: translate("projects.onboarding.inspection.status.canceled"),
  };
  const adminNoteId = `inspection-admin-${repository.id}`;
  return (
    <UI.PaneSection
      data-testid="projects-onboarding-inspection"
      heading="strong"
      ruled
      title={translate("projects.onboarding.inspection.heading")}
      trailing={onboarding === null ? undefined : (
        <UI.StatusDot
          role="status"
          size="small"
          tone={inspectionTone(onboarding.status)}
        >
          {statusLabels[onboarding.status]}
        </UI.StatusDot>
      )}
    >
      <p>{translate("projects.onboarding.inspection.description")}</p>
      <UI.VisuallyHidden as="div" id={adminNoteId}>
        <p>{translate("projects.onboarding.inspection.adminRequired")}</p>
      </UI.VisuallyHidden>
      {archived
        ? (
          <UI.InlineNotice tone="warning">
            {translate("projects.onboarding.inspection.archived")}
          </UI.InlineNotice>
        )
        : repository.activeProfileId === null
        ? (
          <UI.InlineNotice tone="information">
            {translate("projects.onboarding.inspection.baselineRequired")}
          </UI.InlineNotice>
        )
        : null}
      {start.isError
        ? (
          <UI.InlineNotice tone="error" role="alert">
            {start.error.kind === "problem" &&
                start.error.problem.status === 403
              ? translate("projects.onboarding.inspection.adminRequired")
              : start.error.kind === "problem" &&
                  (start.error.problem.status === 409 ||
                    start.error.problem.status === 412)
              ? labels.errors.conflict
              : labels.errors.mutation}
          </UI.InlineNotice>
        )
        : null}
      <UI.Button
        aria-describedby={adminNoteId}
        variant="outline"
        disabled={start.isPending || lifecyclePending || inFlight || archived ||
          repository.activeProfileId === null || scope.organizationId === null}
        loading={start.isPending}
        onClick={() => start.mutate()}
      >
        {start.isPending
          ? translate("projects.onboarding.inspection.starting")
          : started === null || inFlight
          ? translate("projects.onboarding.inspection.start")
          : translate("projects.onboarding.inspection.retryStart")}
      </UI.Button>
      {onboarding !== null
        ? <InspectionStatus onboarding={onboarding} />
        : null}
      {status.isError && started !== null
        ? (
          <UI.ErrorState
            title={labels.errors.load}
            description={translate(
              "projects.onboarding.inspection.status.readError",
            )}
            action={
              <UI.Button onClick={() => void status.refetch()}>
                {translate("projects.onboarding.inspection.status.retry")}
              </UI.Button>
            }
          />
        )
        : null}
      {completed !== null
        ? completed.profileId === null || completed.observationId === null
          ? (
            <UI.InlineNotice tone="error" role="alert">
              {translate("projects.onboarding.observation.unavailable")}
            </UI.InlineNotice>
          )
          : observation.isError
          ? (
            <UI.ErrorState
              title={labels.errors.load}
              description={translate(
                "projects.onboarding.observation.readError",
              )}
              action={
                <UI.Button onClick={() => void observation.refetch()}>
                  {translate("projects.onboarding.observation.retry")}
                </UI.Button>
              }
            />
          )
          : observation.data !== undefined
          ? <RepositoryObservation observation={observation.data} />
          : (
            <UI.InlineNotice tone="information" role="status">
              {translate("projects.onboarding.observation.loading")}
            </UI.InlineNotice>
          )
        : null}
    </UI.PaneSection>
  );
}
