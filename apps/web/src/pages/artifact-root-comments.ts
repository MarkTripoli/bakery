import { useInfiniteQuery } from "@tanstack/react-query";
import type {
  ArtifactResponse,
  ArtifactVersionResponse,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { artifactCommentsAcrossVersionsQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";

export function useArtifactRootComments(
  artifact: ArtifactResponse | undefined,
  version: ArtifactVersionResponse | null,
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const artifactId = artifact?.id ?? "";
  const versionId = version?.id ?? "";
  const options = artifactCommentsAcrossVersionsQueryOptions(
    api,
    scope,
    artifactId,
    { viewVersionId: versionId },
  );
  return useInfiniteQuery({
    queryKey: [...options.queryKey, "pages"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      if (!scope.organizationId) throw new Error("ORGANIZATION_REQUIRED");
      const result = await api.listArtifactCommentsAcrossVersions({
        organizationId: scope.organizationId,
        artifactId,
        viewVersionId: versionId,
        cursor: pageParam,
        signal,
      });
      if (!result.ok) throw result.error;
      return result.data;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: scope.organizationId !== null && artifact !== undefined &&
      version !== null,
    retry: false,
  });
}
