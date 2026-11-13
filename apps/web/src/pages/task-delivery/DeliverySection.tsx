import { useQuery } from "@tanstack/react-query";
import { formatDate } from "@bakery/i18n";
import { useBakeryApi } from "../../api/context.tsx";
import type { ApiFailure } from "../../api/client.ts";
import {
  artifactsListQueryOptions,
  artifactVersionsQueryOptions,
  reviewFindingsQueryOptions,
  runChecksQueryOptions,
  runDeliveryDecisionsQueryOptions,
  runOutputStepIdsQueryOptions,
  runReviewsQueryOptions,
} from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { protectedQueryKey } from "../../app/query-scope.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { type DeliveryModel, deliveryModel } from "./model.ts";
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
 * fix attempts say, and whose turn it is. It reads; it never decides.
 */
export function DeliverySection(
  {
    baseSha,
    enabled,
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
    paused: boolean;
    offline: boolean;
    onTellBakery: () => void;
    onOpenRules: () => void;
  }>,
) {
  const api = useBakeryApi();
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

  const reads = [checks, reviews, decisions];
  const failed = [...reads, findings].find((read) => read.isError);
  const state: DeliveryViewState = failed !== undefined
    ? forbidden(failed.error) ? "forbidden" : "error"
    : reads.some((read) => read.isPending) ||
        (latestReviewId !== null && findings.isPending)
    ? "loading"
    : "ready";

  const model: DeliveryModel | null = state === "ready"
    ? deliveryModel({
      checks: checks.data?.items ?? [],
      reviews: reviews.data?.items ?? [],
      findings: latestReviewId === null ? [] : findings.data?.items ?? [],
      decisions: decisions.data?.items ?? [],
      revisionHeadSha,
      baseSha,
      paused,
    })
    : null;
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
      model={model}
      offline={offline}
      onOpenRules={onOpenRules}
      onRetry={() => {
        for (const read of [checks, reviews, decisions, findings]) {
          if (read.isError) void read.refetch();
        }
      }}
      onTellBakery={onTellBakery}
      state={state}
    />
  );
}
