import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  authProblemCode,
  type OrganizationAccess,
  type OrganizationAccessPage,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import {
  installationCapabilitiesQueryOptions,
  installationSettingsQueryOptions,
  organizationsListQueryOptions,
} from "../api/query.ts";
import {
  ORGANIZATIONS_PATH,
  rememberCurrentReturnTo,
  SIGN_IN_PATH,
  TWO_FACTOR_PATH,
} from "../app/auth-required.tsx";
import { consumeReturnTo } from "../app/auth-return.ts";
import { usePagedFocus } from "../app/focus.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import {
  useProtectedScope,
  useQueryScopeController,
} from "../app/query-scope-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { OrganizationsScreen } from "../screens/OrganizationsScreen.tsx";

const ROLE_MESSAGE_KEY = {
  admin: "auth.invitation.role.Admin",
  developer: "auth.invitation.role.Developer",
  viewer: "auth.invitation.role.Viewer",
  guest: "auth.invitation.role.Guest",
} as const satisfies Record<NonNullable<OrganizationAccess["role"]>, string>;

/** Translated role label for an organization membership row, or `null` for an exact-grant-only relationship with no role. */
function roleMessageKey(role: OrganizationAccess["role"]) {
  if (role === null) return null;
  return ROLE_MESSAGE_KEY[role];
}

/**
 * `/organizations`: the first page is a scoped query — an expired or
 * forbidden session rethrows to `ProtectedRouteError`, any other transport
 * failure renders in place with a retry. "Load more" fetches subsequent
 * pages through the same factory (so they share the scoped cache and are
 * evicted with it) and appends them locally; `CursorControls`' own
 * `loadMore` variant is additive, not a page replacement. Paper's
 * `organizations` artboard only ever shows two illustrative memberships, so
 * it has no pagination affordance at all; a real installation can have many,
 * so `CursorControls` stays below the list regardless — a real necessity
 * the design's two-item sample never needed to depict.
 */
export function OrganizationsPage(
  { reason }: { readonly reason: "forbidden" | "removed" | null },
) {
  const api = useBakeryApi();
  const queryClient = useQueryClient();
  const queryScope = useQueryScopeController();
  const scope = useProtectedScope();
  const navigate = useNavigate();
  const { translate } = useI18n();

  const [morePages, setMorePages] = useState<
    readonly OrganizationAccessPage[]
  >([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [selecting, setSelecting] = useState(false);

  const organizations = useQuery({
    ...organizationsListQueryOptions(api, scope),
    throwOnError: (error) => authProblemCode(error) !== null,
  });

  const availability = useQuery(installationCapabilitiesQueryOptions(api));
  const administration = useQuery(installationSettingsQueryOptions(api, scope));

  // A refetch of the first page (a window refocus, a manual retry, or a
  // scope change) invalidates every locally accumulated "load more" page:
  // its cursor window no longer lines up with the fresh first page, which
  // can otherwise duplicate or skip rows (and collide on `key`).
  useEffect(() => {
    setMorePages([]);
  }, [organizations.dataUpdatedAt, scope]);

  const items = [
    ...(organizations.data?.items ?? []),
    ...morePages.flatMap((page) => page.items),
  ];
  const cursor = morePages.length > 0
    ? morePages[morePages.length - 1].nextCursor ?? null
    : organizations.data?.nextCursor ?? null;

  const paging = usePagedFocus("organizations", {
    pending: loadingMore || organizations.isFetching,
    failed: moreError || organizations.isError,
    rowCount: items.length,
    hasMore: cursor !== null,
  });
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await queryClient.fetchQuery(
        organizationsListQueryOptions(api, scope, { cursor }),
      );
      setMorePages((current) => [...current, page]);
    } catch (error) {
      const code = authProblemCode(error);
      if (code === "AUTH_FACTOR_REQUIRED") {
        rememberCurrentReturnTo();
        void navigate({ to: TWO_FACTOR_PATH });
      } else if (code === "AUTH_INVALID" || code === "AUTH_EXPIRED") {
        rememberCurrentReturnTo();
        void navigate({ to: SIGN_IN_PATH, search: { reason: "expired" } });
      } else if (code === "AUTH_REQUIRED") {
        rememberCurrentReturnTo();
        void navigate({ to: SIGN_IN_PATH });
      } else if (code === "AUTH_FORBIDDEN") {
        organizationSelection.handleForbidden(queryScope);
        void navigate({
          to: ORGANIZATIONS_PATH,
          search: { reason: "forbidden" },
        });
      } else {
        setMoreError(true);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [api, cursor, navigate, queryClient, queryScope, scope]);

  // Setting `selecting` first decouples the transitional render from the
  // scoped query's own state: `setIdentity` immediately remounts
  // `organizations` under a fresh cache key (isPending again) before
  // `navigate` finishes, which would otherwise flash the loading skeleton
  // (or worse, an empty/error state) on this screen mid-transition. A
  // remembered return-to back onto `/organizations` itself (or a sub-path of
  // it) would leave this page mounted with `selecting` permanently stuck, so
  // that case falls back to `/`; `selecting` is cleared in `finally` for the
  // same-route/failed-navigation cases where this component stays mounted.
  const select = async (organizationId: string) => {
    setSelecting(true);
    queryScope.setIdentity(organizationId);
    organizationSelection.remember(organizationId);
    try {
      const target = consumeReturnTo();
      await navigate({
        to: target !== null && !target.startsWith(ORGANIZATIONS_PATH)
          ? target
          : "/",
      });
    } finally {
      setSelecting(false);
    }
  };

  const loading = selecting || organizations.isPending;
  const empty = !loading && !organizations.isError && items.length === 0;

  return (
    <OrganizationsScreen
      creation={availability.data?.organizationCreation ===
            "installation_admins" && !administration.data
        ? "paused"
        : "hidden"}
      forbidden={reason === "forbidden" && !empty}
      loadMore={cursor === null ? null : {
        state: moreError ? "error" : loadingMore ? "loading" : "ready",
      }}
      onLoadMore={() => {
        paging.ask();
        void loadMore();
      }}
      onRefresh={() => {
        if (organizations.isError) paging.ask("first");
        void organizations.refetch();
      }}
      onSelect={(organizationId) => void select(organizationId)}
      organizations={items.map((organization) => {
        const roleKey = roleMessageKey(organization.role);
        return {
          id: organization.id,
          initial: [...organization.name][0]?.toUpperCase() ?? "",
          name: organization.name,
          role: roleKey === null ? null : translate(roleKey),
        };
      })}
      state={loading
        ? "loading"
        : organizations.isError
        ? "error"
        : empty
        ? reason === "removed" ? "removed" : "empty"
        : "ready"}
    />
  );
}
