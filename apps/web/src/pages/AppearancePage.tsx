import { useMemo, useState } from "react";
import { useUnsavedChanges } from "../app/unsaved-changes.tsx";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supportedLocales } from "@bakery/i18n";
import type { MessageKey } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { useBakeryApi } from "../api/context.tsx";
import {
  organizationQueryOptions,
  userPreferencesQueryOptions,
} from "../api/query.ts";
import {
  asyncKindForConnectivity,
  asyncKindForError,
  isConflictFailure,
} from "../app/async-state.ts";
import { useConnectivity } from "../app/connectivity.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import * as organizationSelection from "../app/organization-selection.ts";
import { useRestoreOrganizationScope } from "../app/restore-organization.ts";
import {
  usePresentationScope,
  useThemePreference,
} from "../app/server-presentation.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import {
  type AppearanceOption,
  AppearanceScreen,
} from "../screens/AppearanceScreen.tsx";
import type { SecurityAsyncKind } from "../screens/security-async.tsx";

const LOCALE_NAME_KEYS: Readonly<Record<string, MessageKey>> = {
  en: "organizationSettings.language.name.en",
  "en-XA": "organizationSettings.language.name.en-XA",
  "ar-XB": "organizationSettings.language.name.ar-XB",
};

/** `America/New_York` reads as `America / New York`. */
const zoneLabel = (zone: string) =>
  zone.replaceAll("_", " ").replaceAll("/", " / ");

function supportedZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

/**
 * `/settings/appearance`. The theme applies at once and is saved to the
 * account; language and time zone are drafted, then saved together with the
 * `casVersion` the page last read, so an edit made elsewhere surfaces as a
 * `conflict` with the draft kept.
 */
export function AppearancePage() {
  const api = useBakeryApi();
  const scope = usePresentationScope();
  const queryClient = useQueryClient();
  const { locale, translate } = useI18n();
  const { resolvedTheme } = UI.useTheme();
  const { choose, theme } = useThemePreference();
  useRestoreOrganizationScope();
  const restoring = organizationSelection.hasRemembered();

  const preferences = useQuery(userPreferencesQueryOptions(api, scope));
  const organization = useQuery(organizationQueryOptions(api, scope));
  const connectivity = useConnectivity({
    refetch: preferences.refetch,
    refetching: preferences.isFetching,
    dataUpdatedAt: preferences.dataUpdatedAt,
  });
  const [draftLanguage, setDraftLanguage] = useState<string | null>(null);
  const [draftZone, setDraftZone] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "conflict" | "forbidden" | "offline" | "failed"
  >("idle");
  const [themeSaveFailed, setThemeSaveFailed] = useState(false);

  const current = preferences.data;
  const savedLanguage = current?.locale ?? "";
  const savedZone = current?.timeZone ?? "";
  const language = draftLanguage ?? savedLanguage;
  const timeZone = draftZone ?? savedZone;
  const dirty = language !== savedLanguage || timeZone !== savedZone;
  useUnsavedChanges(dirty);

  const installed = current?.availableLocales ?? [...supportedLocales];
  const languageName = (tag: string) =>
    LOCALE_NAME_KEYS[tag] ? translate(LOCALE_NAME_KEYS[tag]) : tag;
  const languageOptions: AppearanceOption[] = [
    { value: "", label: translate("preferences.language.systemDefault") },
    ...installed.map((tag) => ({ value: tag, label: languageName(tag) })),
  ];
  const zones = useMemo(() => {
    const all = new Set(supportedZones());
    if (savedZone !== "") all.add(savedZone);
    if (timeZone !== "") all.add(timeZone);
    return [...all].sort();
  }, [savedZone, timeZone]);
  const timeZoneOptions: AppearanceOption[] = [
    { value: "", label: translate("preferences.timeZone.deviceDefault") },
    ...zones.map((zone) => ({ value: zone, label: zoneLabel(zone) })),
  ];
  const effectiveZone = timeZone === ""
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : timeZone;
  let zoneName = effectiveZone;
  try {
    zoneName = new Intl.DateTimeFormat(locale, {
      timeZone: effectiveZone,
      timeZoneName: "longGeneric",
    }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")
      ?.value ?? effectiveZone;
  } catch {
    // An unknown zone shows its identifier.
  }

  const submit = async () => {
    if (current === undefined || scope.organizationId === null) return;
    setSaved(false);
    setSaveState("idle");
    const result = await api.userPreferences.update({
      organizationId: scope.organizationId,
      input: {
        locale: language === "" ? null : language,
        timeZone: timeZone === "" ? null : timeZone,
        expectedCasVersion: current.casVersion,
      },
      idempotencyKey: crypto.randomUUID(),
    });
    if (result.ok) {
      queryClient.setQueryData(
        userPreferencesQueryOptions(api, scope).queryKey,
        result.data,
      );
      setDraftLanguage(null);
      setDraftZone(null);
      setSaved(true);
      return;
    }
    const kind = asyncKindForError(result.error);
    if (isConflictFailure(result.error)) setSaveState("conflict");
    else if (kind === "forbidden") setSaveState("forbidden");
    else if (kind === "offline") setSaveState("offline");
    else setSaveState("failed");
  };
  const [pending, runSubmit] = useSingleFlightSubmit(submit);

  const discard = () => {
    setDraftLanguage(null);
    setDraftZone(null);
    setSaved(false);
    setSaveState("idle");
  };
  const reload = () => {
    discard();
    void preferences.refetch();
  };

  const async: SecurityAsyncKind | null = scope.organizationId === null
    ? restoring ? "loading" : "empty"
    : preferences.isPending
    ? "loading"
    : preferences.isError
    ? asyncKindForError(preferences.error)
    : saveState === "forbidden"
    ? "forbidden"
    : saveState === "conflict"
    ? "conflict"
    : saveState === "offline"
    ? "offline"
    : asyncKindForConnectivity(connectivity);

  return (
    <AppearanceScreen
      async={async}
      dirty={dirty}
      language={language}
      languageHint={translate("preferences.language.hint", {
        language: languageName(current?.effectiveLocale ?? locale),
      })}
      languageHintShort={translate("preferences.language.hintShort", {
        language: languageName(current?.effectiveLocale ?? locale),
      })}
      languageOptions={languageOptions}
      onCancel={discard}
      onLanguage={(value) => {
        setSaved(false);
        setDraftLanguage(value);
      }}
      onRefresh={reload}
      onReload={reload}
      onRetry={reload}
      onSave={() => void runSubmit()}
      onTheme={(next) => {
        setThemeSaveFailed(false);
        void choose(next).then((result) => {
          if (result.kind === "failed") setThemeSaveFailed(true);
        });
      }}
      onTimeZone={(value) => {
        setSaved(false);
        setDraftZone(value);
      }}
      organizationName={organization.data?.name ?? ""}
      pending={pending}
      resolvedTheme={resolvedTheme}
      saveFailed={saveState === "failed"}
      saved={saved}
      theme={theme}
      themeSaveFailed={themeSaveFailed}
      timeZone={timeZone}
      timeZoneHint={translate("preferences.timeZone.hint", { zoneName })}
      timeZoneHintShort={translate("preferences.timeZone.hintShort")}
      timeZoneOptions={timeZoneOptions}
    />
  );
}
