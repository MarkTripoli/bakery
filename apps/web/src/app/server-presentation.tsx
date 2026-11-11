import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { UserPreferences, UserPreferencesUpdate } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { userPreferencesQueryOptions } from "../api/query.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { serverPresentation } from "../i18n/presentation.ts";
import { asyncKindForError, isConflictFailure } from "./async-state.ts";
import * as organizationSelection from "./organization-selection.ts";
import { useProtectedScope } from "./query-scope-context.tsx";
import type { ProtectedScope } from "./query-scope.ts";
import { useSession } from "./session-context.tsx";

/**
 * The scope presentation preferences are read under: the selected
 * organization, else the one remembered from the last sign-in, so a reload on
 * any page (Settings never selects an organization itself) still reads the
 * person's saved theme and language. The server checks membership; a stale
 * id is refused and the browser cache stands.
 */
export function usePresentationScope(): ProtectedScope {
  const scope = useProtectedScope();
  const rememberedId = scope.organizationId === null
    ? organizationSelection.remembered()
    : null;
  return useMemo(
    () =>
      rememberedId === null
        ? scope
        : { ...scope, organizationId: rememberedId },
    [rememberedId, scope],
  );
}

/**
 * Adopts the signed-in person's server-side presentation: language and
 * direction (organization default included), time zone, and theme. The
 * server's answer wins over the browser cache, which only exists so the
 * first paint of the next visit already matches. Renders nothing.
 */
export function ServerPresentation() {
  const api = useBakeryApi();
  const session = useSession();
  const { applyServerPresentation } = useI18n();
  const { setTheme, theme } = UI.useTheme();
  const identity = session.status === "authenticated" ? session.identity : null;
  const presentationScope = usePresentationScope();
  const preferences = useQuery({
    ...userPreferencesQueryOptions(api, presentationScope),
    enabled: identity !== null && presentationScope.organizationId !== null,
  });
  const preferenceData = preferences.data ?? null;

  useEffect(() => {
    if (identity === null) return;
    // The identity answer lacks the organization default, so it is final only
    // when there is no organization whose preferences could refine it.
    const settled = preferenceData !== null ||
      presentationScope.organizationId === null;
    // Until it settles, a visit that already painted from the cache keeps
    // that language rather than flashing the identity answer.
    if (!settled && UI.readStoredLocale() !== null) return;
    applyServerPresentation(
      serverPresentation({ identity, preferences: preferenceData }),
      { persist: settled },
    );
  }, [applyServerPresentation, identity, preferenceData, presentationScope]);

  const serverTheme = preferenceData?.theme;
  const localTheme = useRef(theme);
  localTheme.current = theme;
  useEffect(() => {
    // The stored server choice wins, and `setTheme` refreshes the cache. Only
    // a new server value reconciles; a local pick awaiting its save is not
    // undone by an unrelated render.
    if (serverTheme !== undefined && serverTheme !== localTheme.current) {
      setTheme(serverTheme);
    }
  }, [serverTheme, setTheme]);

  return null;
}

/** What saving a presentation preference came to. */
export type PreferenceSaveResult =
  | { readonly kind: "saved"; readonly preferences: UserPreferences }
  | {
    readonly kind: "failed";
    readonly reason: "forbidden" | "conflict" | "offline" | "error";
  };

/**
 * Saves part of the per-organization preferences with the compare-and-swap
 * version the page last read. A stale version is refetched and retried
 * once: each field here is a single value, so last write wins.
 */
export function usePreferenceSaver(): (
  change: Omit<UserPreferencesUpdate, "expectedCasVersion">,
) => Promise<PreferenceSaveResult> {
  const api = useBakeryApi();
  const scope = usePresentationScope();
  const queryClient = useQueryClient();
  return useCallback(async (change) => {
    const organizationId = scope.organizationId;
    if (organizationId === null) {
      return { kind: "failed", reason: "error" };
    }
    const options = userPreferencesQueryOptions(api, scope);
    let current: UserPreferences;
    try {
      current = queryClient.getQueryData(options.queryKey) ??
        await queryClient.fetchQuery(options);
    } catch (error) {
      const reason = asyncKindForError(error);
      return {
        kind: "failed",
        reason: reason === "forbidden" || reason === "offline"
          ? reason
          : "error",
      };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await api.userPreferences.update({
        organizationId,
        input: { ...change, expectedCasVersion: current.casVersion },
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.ok) {
        queryClient.setQueryData(options.queryKey, result.data);
        return { kind: "saved", preferences: result.data };
      }
      if (attempt === 0 && isConflictFailure(result.error)) {
        try {
          current = await queryClient.fetchQuery({ ...options, staleTime: 0 });
          continue;
        } catch {
          return { kind: "failed", reason: "conflict" };
        }
      }
      const reason = asyncKindForError(result.error);
      return {
        kind: "failed",
        reason: reason === "forbidden" || reason === "offline" ||
            reason === "conflict"
          ? reason
          : "error",
      };
    }
    return { kind: "failed", reason: "conflict" };
  }, [api, queryClient, scope]);
}

/**
 * The theme control's state: picking applies at once on this device and is
 * then saved to the server so it follows the person to other devices.
 */
export function useThemePreference() {
  const { setTheme, theme } = UI.useTheme();
  const save = usePreferenceSaver();
  const choose = useCallback((next: UI.Theme) => {
    setTheme(next);
    return save({ theme: next });
  }, [save, setTheme]);
  return { choose, theme };
}
