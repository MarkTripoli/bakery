import * as organizationSelection from "../../app/organization-selection.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../../app/restore-organization.ts";

/**
 * The scope the repository rules pages read and edit in: the signed-in
 * scope, or the organization remembered from the last visit while the
 * session is still restoring it. `waiting` is false while there is no
 * organization to ask about yet.
 */
export function useRulesScope() {
  const scope = useProtectedScope();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();
  const organizationId = scope.organizationId ??
    (restoring ? organizationSelection.remembered() : null);
  return {
    organizationId,
    scope: { ...scope, organizationId },
    waiting: !(organizationId === null && !restoring),
  };
}
