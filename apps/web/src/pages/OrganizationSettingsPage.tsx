import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supportedLocales } from "@bakery/i18n";
import type { MessageKey } from "@bakery/i18n";
import { useBakeryApi } from "../api/context.tsx";
import {
  installationCapabilitiesQueryOptions,
  organizationQueryOptions,
  organizationsListQueryOptions,
  userPreferencesQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isConflictFailure,
} from "../app/async-state.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { OrganizationBreadcrumbs } from "../shell/SettingsShellSlots.tsx";
import { OrganizationSettingsScreen } from "../screens/OrganizationSettingsScreen.tsx";
import type { SecurityAsyncKind } from "../screens/security-async.tsx";

const LOCALE_NAME_KEYS: Readonly<Record<string, MessageKey>> = {
  en: "organizationSettings.language.name.en",
  "en-XA": "organizationSettings.language.name.en-XA",
  "ar-XB": "organizationSettings.language.name.ar-XB",
};

/**
 * `/organization/settings`. The organization, the installed languages
 * (server `availableLocales`), the caller's role and the feature flags are
 * four scoped reads; saving the default language sends the version the page
 * last read as `If-Match`, so a concurrent edit surfaces as a `conflict`
 * with the draft kept rather than being overwritten. Non-Admins see the
 * default language read-only; the server enforces the same rule.
 */
export function OrganizationSettingsPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const { translate } = useI18n();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();

  const organization = useQuery(organizationQueryOptions(api, scope));
  const preferences = useQuery(userPreferencesQueryOptions(api, scope));
  const memberships = useQuery(organizationsListQueryOptions(api, scope));
  const availability = useQuery(installationCapabilitiesQueryOptions(api));

  const connectivity = useConnectivity({
    refetch: organization.refetch,
    refetching: organization.isFetching,
    dataUpdatedAt: organization.dataUpdatedAt,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "conflict" | "forbidden" | "offline" | "failed"
  >("idle");
  // A retry after a transport failure resends the same request; any edit or
  // newer version starts a new one.
  const intent = useRef<
    { key: string; version: number; locale: string } | null
  >(null);

  const savedLocale = organization.data?.defaultLocale ?? "";
  const draftLocale = draft ?? savedLocale;
  const role =
    memberships.data?.items.find((item) => item.id === scope.organizationId)
      ?.role ?? null;

  const installed = preferences.data?.availableLocales ??
    [...supportedLocales];
  const localeOptions = [
    {
      value: "",
      label: translate("organizationSettings.language.bakeryDefault"),
    },
    ...installed.map((tag) => ({
      value: tag,
      label: LOCALE_NAME_KEYS[tag] ? translate(LOCALE_NAME_KEYS[tag]) : tag,
    })),
  ];

  const submit = async () => {
    const current = organization.data;
    if (current === undefined || scope.organizationId === null) return;
    const locale = draftLocale;
    if (
      intent.current === null || intent.current.version !== current.version ||
      intent.current.locale !== locale
    ) {
      intent.current = {
        key: crypto.randomUUID(),
        version: current.version,
        locale,
      };
    }
    setSaved(false);
    setSaveState("idle");
    const result = await api.organizations.update({
      organizationId: scope.organizationId,
      input: { defaultLocale: locale === "" ? null : locale },
      version: current.version,
      idempotencyKey: intent.current.key,
    });
    if (result.ok) {
      intent.current = null;
      queryClient.setQueryData(
        organizationQueryOptions(api, scope).queryKey,
        result.data,
      );
      // The effective language may have changed for people on the default.
      await queryClient.invalidateQueries({
        queryKey: userPreferencesQueryOptions(api, scope).queryKey,
      });
      setDraft(null);
      setSaved(true);
      return;
    }
    const kind = asyncKindForError(result.error);
    if (isConflictFailure(result.error)) setSaveState("conflict");
    else if (kind === "forbidden") setSaveState("forbidden");
    else if (kind === "offline") setSaveState("offline");
    else setSaveState("failed");
    if (kind !== "offline") intent.current = null;
  };
  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  const reload = () => {
    setSaveState("idle");
    setSaved(false);
    setDraft(null);
    intent.current = null;
    void organization.refetch();
    void preferences.refetch();
  };
  const loadFailure = organization.isError
    ? organization.error
    : preferences.isError
    ? preferences.error
    : null;

  // With no organization yet, the remembered one is still being restored.
  const async: SecurityAsyncKind | null = scope.organizationId === null
    ? restoring ? "loading" : "empty"
    : organization.isPending || preferences.isPending
    ? "loading"
    : loadFailure !== null
    ? asyncKindForError(loadFailure)
    : saveState === "forbidden"
    ? "forbidden"
    : saveState === "conflict"
    ? "conflict"
    : saveState === "offline"
    ? "offline"
    : asyncKindForConnectivity(connectivity);

  return (
    <>
      <OrganizationBreadcrumbs />
      <OrganizationSettingsScreen
        async={async}
        availability={availability.data === undefined ? null : {
          signups: availability.data.registration === "invitation",
          organizationCreation:
            availability.data.organizationCreation === "any_user",
        }}
        canEdit={role === "admin"}
        draftLocale={draftLocale}
        localeOptions={localeOptions}
        onDraftChange={(value) => {
          setSaved(false);
          setSaveState((state) => state === "conflict" ? state : "idle");
          setDraft(value);
        }}
        onRefresh={reload}
        onReload={reload}
        onRetry={reload}
        onSave={() => void runSubmit()}
        organizationName={organization.data?.name ?? ""}
        pending={pending}
        saveFailed={saveState === "failed"}
        saved={saved}
        savedLocale={savedLocale}
      />
    </>
  );
}
