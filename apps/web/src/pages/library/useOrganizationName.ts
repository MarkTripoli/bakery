import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../../api/context.tsx";
import { organizationsListQueryOptions } from "../../api/query.ts";
import { useProtectedScope } from "../../app/query-scope-context.tsx";

export function useOrganizationName(): string | null {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const organizations = useQuery(organizationsListQueryOptions(api, scope));
  return organizations.data?.items.find((item) =>
    item.id === scope.organizationId
  )?.name ?? null;
}
