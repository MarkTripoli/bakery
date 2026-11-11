import { useQuery } from "@tanstack/react-query";
import { authProblemCode } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { connectedClientsListQueryOptions } from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
} from "../app/async-state.ts";
import { wordableScopes } from "../app/connected-clients.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { ConnectedClientsScreen } from "../screens/ConnectedClientsScreen.tsx";
import type { SecurityAsyncKind } from "../screens/security-async.tsx";

/**
 * Connected clients list. Reads through the typed `connectedClients.list`
 * client and shows loading, empty, error, forbidden and connectivity states
 * without ever leaving a refused read's grants on screen. Revoking opens the confirmation for that grant
 * through `onRevoke`; the page never revokes directly.
 */
export function ConnectedClientsPage(
  { onRevoke, revoked }: {
    readonly onRevoke: (grantId: string) => void;
    readonly revoked: boolean;
  },
) {
  const { translate } = useI18n();
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const grants = useQuery({
    ...connectedClientsListQueryOptions(api, scope),
    throwOnError: (error) => authProblemCode(error) !== null,
  });
  const connectivity = useConnectivity({
    refetch: grants.refetch,
    refetching: grants.isFetching,
    dataUpdatedAt: grants.dataUpdatedAt,
  });
  const failure = grants.isError ? asyncKindForError(grants.error) : null;
  const items = failure === "forbidden" ? [] : grants.data?.items ?? [];
  const async: SecurityAsyncKind | null = grants.isPending
    ? "loading"
    : failure !== null
    ? failure
    : asyncKindForConnectivity(connectivity) ??
      (items.length === 0 ? "empty" : null);
  const reload = () => void grants.refetch();
  return (
    <ConnectedClientsScreen
      async={async}
      clients={items.map((grant) => ({
        id: grant.id,
        clientName: grant.clientName,
        organizationName: grant.organizationName,
        scopes: wordableScopes(grant.scopes).map((key) => translate(key)),
      }))}
      onRefresh={reload}
      onReload={reload}
      onRetry={reload}
      onRevoke={onRevoke}
      revoked={revoked}
    />
  );
}
