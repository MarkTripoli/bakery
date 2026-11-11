import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import {
  asyncKindForConnectivity,
  asyncKindForError,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { protectedQueryKey } from "../app/query-scope.ts";
import { useSession } from "../app/session-context.tsx";
import { SecurityHubScreen } from "../screens/SecurityHubScreen.tsx";

/**
 * The full security hub: identity and two-factor state come from the
 * session, the passkey count from the provider's passkey list. The hub
 * stays read-only; every change happens on the page its row links to.
 */
export function SecurityHubPage(
  { confirmed }: { readonly confirmed: boolean },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const { identity } = useSession();
  const passkeys = useQuery({
    queryKey: protectedQueryKey(scope, "auth.passkey.list", {}),
    queryFn: ({ signal }) => api.auth.passkey.listUserPasskeys(signal),
  });
  // `reconnecting` only follows an outage, never a routine background refetch.
  const connectivity = useConnectivity({
    refetch: passkeys.refetch,
    refetching: passkeys.isFetching,
    dataUpdatedAt: passkeys.dataUpdatedAt,
  });
  if (identity === null) return null;
  const refetch = () => void passkeys.refetch();
  return (
    <SecurityHubScreen
      async={passkeys.isPending
        ? "loading"
        : passkeys.isError
        ? asyncKindForError(passkeys.error)
        : asyncKindForConnectivity(connectivity)}
      backupCodesRemaining={identity.backupCodesRemaining ?? 0}
      confirmed={confirmed}
      displayName={identity.displayName}
      email={identity.email}
      onRefresh={refetch}
      onReload={refetch}
      onRetry={refetch}
      passkeyCount={passkeys.data?.length ?? 0}
      twoFactorEnabled={identity.twoFactorEnabled}
    />
  );
}
