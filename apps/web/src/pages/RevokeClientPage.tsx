import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authProblemCode } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { connectedClientsListQueryOptions } from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { RevokeClientScreen } from "../screens/RevokeClientScreen.tsx";
import type { SecurityAsyncKind } from "../screens/security-async.tsx";

/**
 * Revoke-client confirmation for one grant. The heading names the client and
 * its organization, read from the same grant list the list page shows. A
 * grant that is already gone (revoked elsewhere) has nothing left to confirm
 * and returns to the list through `onDone`; a failed revocation stays here as
 * a retryable error notice and changes nothing.
 */
export function RevokeClientPage(
  { grantId, onCancel, onDone }: {
    readonly grantId: string;
    readonly onCancel: () => void;
    readonly onDone: () => void;
  },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  const listOptions = connectedClientsListQueryOptions(api, scope);
  const grants = useQuery({
    ...listOptions,
    throwOnError: (error) => authProblemCode(error) !== null,
  });
  const connectivity = useConnectivity({
    refetch: grants.refetch,
    refetching: grants.isFetching,
    dataUpdatedAt: grants.dataUpdatedAt,
  });
  const revoke = useMutation({
    mutationKey: ["connectedClients.revoke"],
    mutationFn: async () => {
      const result = await api.connectedClients.revoke(grantId);
      if (!result.ok) throw result.error;
    },
  });
  const grant = grants.data?.items.find((candidate) =>
    candidate.id === grantId
  );
  const gone = grants.isSuccess && grant === undefined && !revoke.isPending;
  useEffect(() => {
    if (gone) onDone();
  }, [gone, onDone]);

  const failure = grants.isError ? asyncKindForError(grants.error) : null;
  const async: SecurityAsyncKind | null = grants.isPending
    ? "loading"
    : failure !== null
    ? failure
    : asyncKindForConnectivity(connectivity);
  const reload = () => void grants.refetch();
  return (
    <RevokeClientScreen
      async={async}
      clientName={grant?.clientName ?? ""}
      failed={failed}
      onCancel={onCancel}
      onConfirm={() => {
        setFailed(false);
        revoke.mutate(undefined, {
          onError: () => setFailed(true),
          onSuccess: async () => {
            await queryClient.invalidateQueries({
              queryKey: listOptions.queryKey,
            });
            onDone();
          },
        });
      }}
      onRefresh={reload}
      onReload={reload}
      onRetry={reload}
      organizationName={grant?.organizationName ?? ""}
      pending={revoke.isPending}
    />
  );
}
