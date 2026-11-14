import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { InstallationSettingsUpdate } from "@bakery/contracts/installation-settings";
import type { InstallationSettings } from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { installationSettingsQueryOptions } from "../api/query.ts";
import { isConflictFailure, isForbiddenFailure } from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import { useSession } from "../app/session-context.tsx";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { INSTALLATION_HOME } from "../shell/breadcrumb-paths.ts";
import { InstallationSettingsScreen } from "../screens/InstallationSettingsScreen.tsx";
import { ShellActiveNavigation, ShellSlot } from "../shell/shell-slots.tsx";

type Edit = { base: InstallationSettings; draft: InstallationSettingsUpdate };
const policies = (
  record: InstallationSettings,
): InstallationSettingsUpdate => ({
  registrationMode: record.registrationMode,
  organizationCreationPolicy: record.organizationCreationPolicy,
});

export function InstallationSettingsPage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const session = useSession();
  const generation = useRef(scope.sessionGeneration);
  generation.current = scope.sessionGeneration;
  const queryClient = useQueryClient();
  const options = installationSettingsQueryOptions(api, scope);
  const settings = useQuery(options);
  const { translate, locale, timeZone } = useI18n();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saveState, setSaveState] = useState<
    "default" | "error" | "conflict" | "forbidden"
  >("default");
  const [saved, setSaved] = useState(false);
  const intent = useRef<{ key: string; version: number; body: string } | null>(
    null,
  );
  useEffect(() => {
    setEdit(null);
    setSaveState("default");
    setSaved(false);
    intent.current = null;
  }, [scope.sessionGeneration]);
  const base = edit?.base ?? settings.data;
  const draft = edit?.draft ?? (base ? policies(base) : null);
  const dirty = Boolean(
    base && draft &&
      (base.registrationMode !== draft.registrationMode ||
        base.organizationCreationPolicy !== draft.organizationCreationPolicy),
  );
  const [pending, submit] = useSingleFlightSubmit(async () => {
    if (!base || !draft || !dirty || saveState === "conflict") return;
    const started = scope.sessionGeneration;
    const body = JSON.stringify(draft);
    if (
      !intent.current || intent.current.version !== base.version ||
      intent.current.body !== body
    ) {
      intent.current = {
        key: crypto.randomUUID(),
        version: base.version,
        body,
      };
    }
    const result = await api.installationSettings.update({
      input: draft,
      version: base.version,
      idempotencyKey: intent.current.key,
    });
    if (generation.current !== started) return;
    if (!result.ok) {
      setSaveState(
        isForbiddenFailure(result.error)
          ? "forbidden"
          : isConflictFailure(result.error)
          ? "conflict"
          : "error",
      );
      return;
    }
    queryClient.setQueryData(options.queryKey, result.data);
    await queryClient.invalidateQueries({
      queryKey: ["public", "installation-capabilities"],
    });
    if (generation.current !== started) return;
    setEdit(null);
    setSaveState("default");
    setSaved(true);
    intent.current = null;
  });
  const reload = async () => {
    const started = scope.sessionGeneration;
    const result = await settings.refetch();
    if (generation.current !== started || !result.isSuccess) return;
    setEdit(null);
    setSaveState("default");
    setSaved(false);
    intent.current = null;
  };
  const state = saveState === "forbidden" ||
      (settings.isError && isForbiddenFailure(settings.error))
    ? "forbidden"
    : pending
    ? "saving"
    : saveState !== "default"
    ? saveState
    : !base && settings.isPending
    ? "loading"
    : settings.isError
    ? "error"
    : "default";
  const changedDate = base
    ? new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(base.updatedAt))
    : "";
  const updater = base?.updatedByPrincipalId;
  const changedLabel = base
    ? updater
      ? translate("settings.installation.changedBy", {
        actor: session.status === "authenticated" &&
            session.identity?.principalId === updater
          ? session.identity.displayName
          : updater,
        date: changedDate,
      })
      : translate("settings.installation.changed", { date: changedDate })
    : "";
  return (
    <>
      <ShellActiveNavigation id="settings" />
      <ShellSlot name="breadcrumbs">
        <UI.Breadcrumbs
          aria-label={translate("shell.navigation.breadcrumb")}
          items={[{
            href: INSTALLATION_HOME,
            label: translate("shell.navigation.installation"),
          }, {
            label: translate("settings.installation.section"),
          }]}
        />
      </ShellSlot>
      <InstallationSettingsScreen
        draft={draft}
        state={state}
        saved={saved}
        dirty={dirty}
        changedLabel={changedLabel}
        onChange={(next) => {
          if (!base) return;
          setEdit({ base, draft: next });
          setSaved(false);
          setSaveState((current) =>
            current === "conflict" ? current : "default"
          );
          intent.current = null;
        }}
        onSave={() => void submit()}
        onReload={() => void reload()}
        onDiscard={() => {
          setEdit(null);
          setSaved(false);
          setSaveState("default");
          intent.current = null;
        }}
      />
    </>
  );
}
