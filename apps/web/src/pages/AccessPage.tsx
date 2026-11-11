import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import type { EffectiveAccess } from "../api/client.ts";
import {
  effectiveAccessQueryOptions,
  organizationQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isStaleRead,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { usePresentationScope } from "../app/server-presentation.tsx";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { type AccessGroup, AccessScreen } from "../screens/AccessScreen.tsx";
import type { SecurityAsyncKind } from "../screens/security-async.tsx";

/** A read this old is offered an explicit refresh instead of being trusted. */
const STALE_AFTER_MS = 5 * 60_000;

const WORK_PREFIXES = [
  "task:",
  "run:",
  "repository:",
  "application:",
  "project:",
  "conversation:",
  "artifact:",
  "question:",
  "message:",
];
const MACHINE_PREFIXES = ["worker:"];
const ROLE_LABEL_KEYS = {
  admin: "access.role.admin",
  developer: "access.role.developer",
  viewer: "access.role.viewer",
  guest: "access.role.guest",
} as const;

const matches = (
  capabilities: EffectiveAccess["capabilities"],
  prefixes: string[],
) =>
  capabilities.some((capability) =>
    prefixes.some((prefix) => capability.startsWith(prefix))
  );

/**
 * `/settings/access`. One read of the live effective access for the selected
 * organization, summarized in three plain groups. Leaving the organization,
 * losing access or going quiet for a while never leaves protected content on
 * screen: removed access clears it and a stale read asks to be refreshed.
 */
export function AccessPage() {
  const api = useBakeryApi();
  const scope = usePresentationScope();
  const session = useSession();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();
  const access = useQuery(effectiveAccessQueryOptions(api, scope));
  const organization = useQuery(organizationQueryOptions(api, scope));
  const connectivity = useConnectivity({
    refetch: access.refetch,
    refetching: access.isFetching,
    dataUpdatedAt: access.dataUpdatedAt,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  const data = access.data;
  const role = data?.role ?? null;
  const groups: AccessGroup[] = [];
  if (data !== undefined) {
    groups.push({
      id: "settings",
      title: translate("access.group.settings.title"),
      description: translate("access.group.settings.description"),
      level: translate("access.level.manage"),
    });
    if (matches(data.capabilities, WORK_PREFIXES)) {
      groups.push({
        id: "work",
        title: translate("access.group.work.title"),
        description: translate("access.group.work.description"),
        level: translate(
          role === "admin"
            ? "access.level.manage"
            : role === "viewer"
            ? "access.level.view"
            : "access.level.scoped",
        ),
      });
    }
    if (matches(data.capabilities, MACHINE_PREFIXES)) {
      groups.push({
        id: "machines",
        title: translate("access.group.machines.title"),
        description: translate(
          role === "admin"
            ? "access.group.machines.descriptionAdmin"
            : "access.group.machines.description",
        ),
        level: translate(
          role === "admin" ? "access.level.manage" : "access.level.view",
        ),
      });
    }
  }

  const reload = () => void access.refetch();
  const kind = access.isError ? asyncKindForError(access.error) : null;
  // A refused or missing read must not leave an earlier answer on screen.
  const showData = data !== undefined && kind !== "forbidden";
  const async: SecurityAsyncKind | null = scope.organizationId === null
    ? restoring ? "loading" : "empty"
    : access.isPending
    ? "loading"
    : kind !== null
    ? kind
    : asyncKindForConnectivity(connectivity) ??
      (isStaleRead(access.dataUpdatedAt, now, STALE_AFTER_MS) ? "stale" : null);

  return (
    <AccessScreen
      async={async}
      displayName={session.identity?.displayName ?? ""}
      groups={showData ? groups : []}
      noGrant={showData && role === null && data.capabilities.length === 0}
      onRefresh={reload}
      onReload={reload}
      onRetry={reload}
      organizationName={organization.data?.name ?? ""}
      roleLabel={role === null ? null : translate(ROLE_LABEL_KEYS[role])}
    />
  );
}
