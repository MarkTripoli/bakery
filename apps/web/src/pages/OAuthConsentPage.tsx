import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  failureStatus,
} from "../app/async-state.ts";
import {
  CONNECTED_CLIENTS_PATH,
  SECURITY_SETTINGS_PATH,
} from "../app/auth-paths.ts";
import type { ConsentGateway } from "../app/connected-clients.ts";
import { useConnectivity } from "../app/connectivity.ts";
import {
  type OAuthConsentAsync,
  OAuthConsentScreen,
  type OAuthConsentState,
} from "../screens/OAuthConsentScreen.tsx";

/** The server answers an unknown or timed-out authorization request with this. */
const EXPIRED_STATUS = 410;

/**
 * OAuth consent. Uses only the read-only `get-consent` and the consent
 * response; the delete and update consent paths are refused server-side and
 * never called here. Binding is explicit: the chosen organization is
 * selected first and the grant only exists for it. A pending-MFA session is
 * refused by the server (403), which renders as `forbidden` with nothing
 * about the request left on screen.
 */
export function OAuthConsentPage(
  { gateway }: { readonly gateway: ConsentGateway },
) {
  const router = useRouter();
  const request = useQuery({
    queryKey: ["oauth-consent"],
    queryFn: ({ signal }) => gateway.get(signal),
    retry: false,
  });
  const connectivity = useConnectivity({
    refetch: request.refetch,
    refetching: request.isFetching,
    dataUpdatedAt: request.dataUpdatedAt,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"denied" | "success" | null>(null);
  const [failed, setFailed] = useState(false);
  const respond = useMutation({
    mutationKey: ["oauth.consent.respond"],
    mutationFn: async (
      choice: { readonly accept: boolean; readonly organizationId: string },
    ) => {
      if (choice.accept) {
        await gateway.selectOrganization(choice.organizationId);
      }
      await gateway.respond(choice.accept);
    },
  });

  const data = request.data;
  const selected = chosen ?? data?.selectedOrganizationId ??
    data?.organizations[0]?.id ?? "";
  const expired = request.isError &&
    failureStatus(request.error) === EXPIRED_STATUS;
  const kind = request.isError && !expired
    ? asyncKindForError(request.error)
    : null;
  const async: OAuthConsentAsync | null = request.isPending
    ? "loading"
    : kind === "forbidden" || kind === "offline" || kind === "error"
    ? kind
    : asyncKindForConnectivity(connectivity);
  const state: OAuthConsentState = outcome ?? (expired ? "expired" : "default");
  const decide = (accept: boolean) => {
    setFailed(false);
    respond.mutate({ accept, organizationId: selected }, {
      onError: (error) => {
        if (failureStatus(error) === EXPIRED_STATUS) void request.refetch();
        else setFailed(true);
      },
      onSuccess: () => setOutcome(accept ? "success" : "denied"),
    });
  };
  return (
    <OAuthConsentScreen
      async={async}
      clientName={data?.clientName ?? ""}
      failed={failed}
      onAllow={() => decide(true)}
      onDeny={() => decide(false)}
      onRetry={() => void request.refetch()}
      onReturnToAccount={() => router.history.push(SECURITY_SETTINGS_PATH)}
      onReviewClients={() => router.history.push(CONNECTED_CLIENTS_PATH)}
      onSelectOrganization={setChosen}
      organizations={kind === "forbidden" ? [] : data?.organizations ?? []}
      pending={respond.isPending}
      scopes={kind === "forbidden" ? [] : data?.scopes ?? []}
      selectedOrganizationId={selected}
      state={state}
    />
  );
}
