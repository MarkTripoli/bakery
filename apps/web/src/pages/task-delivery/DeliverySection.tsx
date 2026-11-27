import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@bakery/i18n";
import { useBakeryApi } from "../../api/context.tsx";
import type { ApiFailure, RunResponse } from "../../api/client.ts";
import {
  approvalsQueryOptions,
  artifactsListQueryOptions,
  artifactVersionsQueryOptions,
  effectiveAccessQueryOptions,
  mergeAttemptsQueryOptions,
  mergeEntriesQueryOptions,
  pullRequestsQueryOptions,
  reviewFindingsQueryOptions,
  runChecksQueryOptions,
  runDeliveryDecisionsQueryOptions,
  runDeploymentsQueryOptions,
  runOutputStepIdsQueryOptions,
  runQueryOptions,
  runReviewsQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { protectedQueryKey } from "../../app/query-scope.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  approvalsForRun,
  choosePullRequest,
  type DeliveryModel,
  deliveryModel,
} from "./model.ts";
import { useMerge } from "./use-merge.ts";
import { useApprovalDecision } from "./use-approval-decision.ts";
import { useGoBack } from "./use-go-back.ts";
import { useMoreTries } from "./use-more-tries.ts";
import {
  DeliverySectionView,
  type DeliveryViewState,
} from "./DeliverySectionView.tsx";

/**
 * The run has no head commit of its own. The revision card already reads the
 * run's patch artifact and its versions, so this makes the same calls with the
 * same keys (React Query shares the cache) and takes the newest version's head
 * sha. Null when no version carries one yet.
 */
function useRevisionHeadSha(taskId: string, runId: string, enabled: boolean) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const steps = useQuery({
    ...runOutputStepIdsQueryOptions(api, scope, runId),
    enabled,
  });
  const artifacts = useQuery({
    ...artifactsListQueryOptions(api, scope, {
      taskId,
      artifactType: "patch",
      cursor: undefined,
      limit: 25,
    }),
    enabled,
  });
  const artifact = artifacts.isError
    ? undefined
    : artifacts.data?.items.find((entry) =>
      entry.taskId === taskId && entry.artifactType === "patch"
    );
  const versions = useQuery({
    ...artifactVersionsQueryOptions(api, scope, artifact?.id ?? "", {
      limit: 25,
      cursor: undefined,
    }),
    queryKey: protectedQueryKey(scope, "runArtifactVersions.list", {
      artifactId: artifact?.id,
      taskId,
      runId,
      currentVersionId: artifact?.currentVersionId,
      cursor: null,
    }),
    refetchInterval: 5000,
    enabled: enabled && artifact !== undefined,
  });
  const stepIds = steps.isError ? [] : steps.data ?? [];
  const candidates = versions.isError || artifact === undefined
    ? []
    : versions.data?.items.filter((version) =>
      version.artifactId === artifact.id && version.runStepId !== null &&
      stepIds.includes(version.runStepId) && version.subjectHeadSha !== null
    ) ?? [];
  const newest = [...candidates].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1
  )
    .at(-1);
  return newest?.subjectHeadSha ?? null;
}

const failureOf = (error: unknown): ApiFailure | null =>
  error !== null && typeof error === "object" && "kind" in error
    ? error as ApiFailure
    : null;

/** A denied read is a 404 (a denied control is a 403); both mean no access here. */
const forbidden = (error: unknown): boolean => {
  const failure = failureOf(error);
  return failure?.kind === "problem" &&
    (failure.problem.status === 403 || failure.problem.status === 404);
};

/**
 * The delivery section of the task run view: what the run's checks, review and
 * fix attempts say, and whose turn it is. It reads, and it sends the person's
 * decision on the candidate approval when the workflow asks for one.
 */
export function DeliverySection(
  {
    baseSha,
    enabled,
    limitStop = null,
    offline,
    onOpenRules,
    onTellBakery,
    paused,
    runId,
    taskId,
  }: Readonly<{
    taskId: string;
    runId: string;
    enabled: boolean;
    baseSha: string | null;
    limitStop?: RunResponse["limitStop"];
    paused: boolean;
    offline: boolean;
    onTellBakery: () => void;
    onOpenRules: () => void;
  }>,
) {
  const api = useBakeryApi();
  const queryClient = useQueryClient();
  const scope = useProtectedScope();
  const { locale, timeZone } = useI18n();
  const revisionHeadSha = useRevisionHeadSha(taskId, runId, enabled);
  const checks = useQuery({
    ...runChecksQueryOptions(api, scope, runId),
    enabled,
    refetchInterval: 5000,
  });
  const reviews = useQuery({
    ...runReviewsQueryOptions(api, scope, runId),
    enabled,
    refetchInterval: 5000,
  });
  const decisions = useQuery({
    ...runDeliveryDecisionsQueryOptions(api, scope, runId),
    enabled,
    refetchInterval: 5000,
  });
  // The approvals read never blocks the section: a task whose workflow asks for
  // no approval has none, and a refused read only means none is shown.
  const approvals = useQuery({
    ...approvalsQueryOptions(api, scope, taskId),
    enabled,
    refetchInterval: 5000,
  });
  const latestReviewId = reviews.data?.items.reduce<
    { id: string; ordinal: number } | null
  >(
    (best, entry) =>
      best === null || entry.ordinal > best.ordinal
        ? { id: entry.id, ordinal: entry.ordinal }
        : best,
    null,
  )?.id ?? null;
  const findings = useQuery({
    ...reviewFindingsQueryOptions(api, scope, runId, latestReviewId),
    enabled: enabled && latestReviewId !== null,
    refetchInterval: 5000,
  });
  // The pull request and merge the trace ends at. Like the approvals read it
  // never blocks the section: a task with no pull request shows none recorded,
  // and a refused read only means none is shown.
  const pullRequests = useQuery({
    ...pullRequestsQueryOptions(api, scope, taskId),
    enabled,
    refetchInterval: 5000,
  });

  // The chosen pull request's merge attempts, newest first. Like the pull
  // requests read it never blocks the section: without it nothing about merging
  // is offered, and an unknown outcome is only ever read from here.
  const chosen = choosePullRequest(pullRequests.data?.items ?? [], runId);
  const mergeAttempts = useQuery({
    ...mergeAttemptsQueryOptions(api, scope, chosen?.id ?? ""),
    enabled: enabled && chosen !== undefined && chosen.status === "open",
    refetchInterval: 5000,
  });

  // The chosen pull request's queued merges, newest first: what Bakery is
  // doing about a merge, and why it stopped one. Like the attempts it never
  // blocks the section; without it no merge is offered.
  const mergeEntries = useQuery({
    ...mergeEntriesQueryOptions(api, scope, chosen?.id ?? ""),
    enabled: enabled && chosen !== undefined && chosen.status === "open",
    refetchInterval: 5000,
  });

  const merged = chosen?.status === "merged" && chosen.mergedSha !== null;
  const deployments = useQuery({
    ...runDeploymentsQueryOptions(api, scope, runId),
    enabled: enabled && merged,
    refetchInterval: 5000,
  });
  const outOfTries =
    decisions.data?.items.some((entry) =>
      entry.decision === "stop" && entry.reason === "repair_cycles_exhausted"
    ) ?? false;
  const access = useQuery({
    ...effectiveAccessQueryOptions(api, scope),
    enabled: enabled && (merged || outOfTries || limitStop !== null),
  });
  const mayDeploy = access.data?.role === "admin" ||
    access.data?.role === "developer";
  const mayGiveMoreTries = access.data?.role === "admin" ||
    access.data?.capabilities.includes("review:accept") === true;

  const reads = [checks, reviews, decisions];
  const failed = [...reads, findings].find((read) => read.isError);
  const state: DeliveryViewState = failed !== undefined
    ? forbidden(failed.error) ? "forbidden" : "error"
    : reads.some((read) => read.isPending) || approvals.isPending ||
        (latestReviewId !== null && findings.isPending)
    ? "loading"
    : "ready";

  const model: DeliveryModel | null = state === "ready"
    ? deliveryModel({
      runId,
      checks: checks.data?.items ?? [],
      reviews: reviews.data?.items ?? [],
      findings: latestReviewId === null ? [] : findings.data?.items ?? [],
      decisions: decisions.data?.items ?? [],
      approvals: approvalsForRun(approvals.data?.items ?? [], runId),
      pullRequests: pullRequests.data?.items ?? [],
      // A pull request whose attempts or queued merges could not be read offers
      // no merge: an unknown outcome or a merge under way might be hidden there.
      mergeAttempts: mergeAttempts.isError ? [] : mergeAttempts.data?.items ??
        [],
      mergeEntries: mergeEntries.isError ? [] : mergeEntries.data?.items ?? [],
      // A refused read of the queued merges is a person who may not see the
      // queue, and who cannot merge either, so it hides nothing they could use.
      mergeUnavailable: chosen !== undefined && chosen.status === "open" &&
        (mergeAttempts.isError ||
          (mergeEntries.isError && !forbidden(mergeEntries.error))),
      // A refusal means this person cannot see approvals, so none is shown;
      // any other failure means one may be waiting that could not be read.
      approvalsUnavailable: approvals.isError && !forbidden(approvals.error),
      deployments: merged && !deployments.isError
        ? (deployments.data?.items ?? []).map((item) => ({
          ...item,
          previousCommitSha: item.previousCommitSha ?? null,
          rollbackFailed: item.rollbackFailed ?? false,
        }))
        : [],
      mayDeploy,
      revisionHeadSha,
      baseSha,
      limitStop,
      paused,
    })
    : null;
  const refreshDecision = useCallback(async () => {
    await Promise.all([approvals.refetch(), decisions.refetch()]);
  }, [approvals.refetch, decisions.refetch]);
  const refreshMerge = useCallback(async () => {
    await Promise.all([
      pullRequests.refetch(),
      mergeAttempts.refetch(),
      mergeEntries.refetch(),
    ]);
  }, [pullRequests.refetch, mergeAttempts.refetch, mergeEntries.refetch]);
  const refreshRelease = useCallback(async () => {
    await deployments.refetch();
  }, [deployments.refetch]);
  const mergeAction = useMerge(refreshMerge);
  const refreshTries = useCallback(async () => {
    await Promise.all([
      decisions.refetch(),
      checks.refetch(),
      reviews.refetch(),
      queryClient.invalidateQueries({
        queryKey: runQueryOptions(api, scope, runId).queryKey,
      }),
    ]);
  }, [
    decisions.refetch,
    checks.refetch,
    reviews.refetch,
    queryClient,
    api,
    scope,
    runId,
  ]);
  const goBackAction = useGoBack(refreshRelease);
  const moreTriesAction = useMoreTries(runId, refreshTries);
  const decision = useApprovalDecision(
    model?.approval ?? null,
    refreshDecision,
  );
  // No changes yet: the section is not drawn at all.
  if (state === "ready" && model !== null && !model.visible) return null;

  const updatedAt = Math.max(
    checks.dataUpdatedAt,
    reviews.dataUpdatedAt,
    decisions.dataUpdatedAt,
  );
  return (
    <DeliverySectionView
      lastUpdated={updatedAt > 0
        ? formatDate(new Date(updatedAt), locale, {
          timeZone,
          timeStyle: "short",
        })
        : null}
      decisionPhase={decision.phase}
      model={model}
      offline={offline}
      mergePhase={mergeAction.phase}
      mergeTarget={mergeAction.target}
      onCheckAgain={mergeAction.checkAgain}
      onClearMerge={mergeAction.clear}
      goBackPhase={goBackAction.phase}
      onClearGoBack={goBackAction.clear}
      mayGiveMoreTries={mayGiveMoreTries}
      moreTriesPhase={moreTriesAction.phase}
      onClearMoreTries={moreTriesAction.clear}
      onGiveMoreTries={moreTriesAction.allow}
      onDecide={decision.decide}
      onGoBack={goBackAction.goBack}
      onMerge={mergeAction.merge}
      onOpenRules={onOpenRules}
      onRetryApprovals={() => void approvals.refetch()}
      onRetry={() => {
        for (
          const read of [
            checks,
            reviews,
            decisions,
            findings,
            approvals,
            pullRequests,
            mergeAttempts,
            mergeEntries,
          ]
        ) {
          if (read.isError) void read.refetch();
        }
      }}
      onTellBakery={onTellBakery}
      state={state}
    />
  );
}
