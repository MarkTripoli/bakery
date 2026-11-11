import type { QueryClient } from "@tanstack/react-query";
import type { ProtectedScope } from "../app/query-scope.ts";

/**
 * Re-reads every authorized artifact query of the current scope: the artifact,
 * its version list, comments and storage. The verified content preview and the
 * extraction are keyed by immutable version, so they are left alone.
 */
export function invalidateArtifactQueries(
  queryClient: QueryClient,
  scope: ProtectedScope,
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      const [kind, generation, , operation] = queryKey;
      return kind === "protected" && generation === scope.sessionGeneration &&
        typeof operation === "string" && operation.startsWith("artifact") &&
        operation !== "artifactVersions.verifiedPreview" &&
        operation !== "artifactVersions.extract";
    },
  });
}
