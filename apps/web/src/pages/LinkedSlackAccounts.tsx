import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import {
  effectiveAccessQueryOptions,
  mySlackLinkQueryOptions,
  organizationQueryOptions,
} from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import {
  LinkedSlackSection,
  type SlackLinkNotice,
  type SlackLinkStatus,
} from "../screens/LinkedSlackSection.tsx";

export function LinkedSlackAccounts(
  { result }: { readonly result: SlackLinkNotice | null },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  useRestoreOrganizationScope({ redirect: false });
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const mayLink = access.data?.role === "admin" ||
    access.data?.role === "developer";
  const organization = useQuery(organizationQueryOptions(api, scope));
  const link = useQuery({
    ...mySlackLinkQueryOptions(api, scope),
    enabled: mayLink,
  });
  const [notice, setNotice] = useState(result);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const shown = mayLink && !link.isPending;
  useEffect(() => {
    if (shown && globalThis.location.hash === "#slack") {
      globalThis.document.getElementById("slack")?.scrollIntoView();
    }
  }, [shown]);
  const organizationId = scope.organizationId;
  if (!mayLink || organizationId === null) return null;

  const status: SlackLinkStatus = link.isPending
    ? { kind: "loading" }
    : link.data === undefined
    ? { kind: "failed" }
    : {
      kind: "ready",
      connection: link.data.connection,
      state: link.data.state,
      workspaceName: link.data.workspaceName ?? null,
      linkedAt: link.data.linkedAt ?? null,
      removedAt: link.data.removedAt ?? null,
    };
  const start = async () => {
    setLinking(true);
    setNotice(null);
    const started = await api.mySlackLink.start(organizationId);
    if (started.ok) {
      globalThis.location.assign(started.data.authorizationUrl);
      return;
    }
    const read = await link.refetch();
    if (read.data?.connection === "working") setNotice("exchange_failed");
    setLinking(false);
  };
  const unlink = async () => {
    setUnlinking(true);
    const ended = await api.mySlackLink.unlink(organizationId);
    if (ended.ok) {
      queryClient.setQueryData(
        mySlackLinkQueryOptions(api, scope).queryKey,
        ended.data,
      );
    }
    setNotice(ended.ok ? "unlinked" : "unlink_failed");
    setConfirmingUnlink(false);
    setUnlinking(false);
  };
  return (
    <LinkedSlackSection
      canManageIntegrations={access.data?.role === "admin"}
      confirmingUnlink={confirmingUnlink}
      linking={linking}
      notice={notice}
      onConfirmingUnlinkChange={setConfirmingUnlink}
      onLink={() => void start()}
      onRetry={() => void link.refetch()}
      onUnlink={() => void unlink()}
      organizationName={organization.data?.name ?? ""}
      status={status}
      unlinking={unlinking}
    />
  );
}
