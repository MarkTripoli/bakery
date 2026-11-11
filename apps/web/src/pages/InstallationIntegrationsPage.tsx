import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  ApiFailure,
  IntegrationAppRegistration,
  IntegrationAppRegistrationPut,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { integrationAppRegistrationQueryOptions } from "../api/query.ts";
import {
  failureStatus,
  isConflictFailure,
  isForbiddenFailure,
} from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  type CreateStatus,
  InstallationIntegrationsScreen,
  type IntegrationsView,
  type ManifestHandoff,
  parseAppName,
  type RegisteredApp,
  type RegistrationOutcome,
} from "../screens/InstallationIntegrationsScreen.tsx";
import {
  EMPTY_EXISTING_APP,
  type ExistingAppStatus,
  type ExistingAppValues,
  parseAppId,
} from "../screens/ExistingGitHubAppForm.tsx";
import { InstallationSkillStorage } from "./InstallationSkillStorage.tsx";
import { ShellActiveNavigation } from "../shell/shell-slots.tsx";
import { InstallationBreadcrumbs } from "../shell/SettingsShellSlots.tsx";

/** Query parameter the manifest callback redirect carries (server contract). */
export const REGISTRATION_OUTCOME_PARAMETER = "githubAppRegistration";

const OUTCOMES: readonly RegistrationOutcome[] = [
  "registered",
  "state_rejected",
  "already_registered",
  "conversion_failed",
  "storage_failed",
];

/** Narrows an untrusted query value to a known outcome; anything else is none. */
export function parseRegistrationOutcome(
  value: unknown,
): RegistrationOutcome | undefined {
  return OUTCOMES.find((outcome) => outcome === value);
}

/**
 * A starting App name unlikely to be taken on github.com: Bakery plus this
 * deployment's host, in the characters GitHub keeps in a slug.
 */
export function defaultAppName(hostname: string): string {
  const host = hostname.replace(/[^A-Za-z0-9-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return (host === "" ? "Bakery" : `Bakery ${host}`).slice(0, 34).trim();
}

/** GitHub's permission map is json; keep only `name: level` string pairs. */
function permissionEntries(
  permissions: unknown,
): readonly (readonly [string, string])[] {
  if (
    permissions === null || typeof permissions !== "object" ||
    Array.isArray(permissions)
  ) return [];
  return Object.entries(permissions).flatMap(([name, level]) =>
    typeof level === "string" ? [[name, level] as const] : []
  ).sort(([left], [right]) => left.localeCompare(right));
}

function registeredApp(
  registration: IntegrationAppRegistration,
): RegisteredApp | null {
  const { appId, slug, name, ownerLogin, ownerType } = registration;
  if (
    registration.status !== "registered" || appId === null || slug === null ||
    name === null || ownerLogin === null || ownerType === null
  ) return null;
  return {
    name,
    appId,
    slug,
    ownerLogin,
    ownerType,
    registeredAt: registration.registeredAt,
    permissions: permissionEntries(registration.permissions),
    secrets: {
      clientSecret: registration.clientSecretRevision ?? null,
      privateKey: registration.privateKeyRevision ?? null,
      webhookSecret: registration.webhookSecretRevision ?? null,
    },
  };
}

/** The form outcome a refused put renders; every refusal stored nothing. */
function existingAppFailure(error: ApiFailure): ExistingAppStatus {
  const status = failureStatus(error);
  const problem = error.kind === "problem" ? error.problem : null;
  // 400 and 422 map by status: the server sends issue paths as arrays, which
  // the shared Problem schema (string paths) rejects, so no problem survives.
  if (status === 400) return "malformed";
  if (status === 422) return "rejected";
  if (status === 412 || status === 428) return "stale";
  if (status === 409 && problem?.code === "STATE_CONFLICT") {
    if (problem.reason === "app_mismatch") return "appMismatch";
    // Registered meanwhile; no reason is the missing secrets key.
    return problem.reason === "provider_registered" ? "stale" : "unavailable";
  }
  if (status === 503) return "githubUnavailable";
  return "failed";
}

/** Drops every secret the administrator typed; public ids stay. */
function withoutSecrets(values: ExistingAppValues): ExistingAppValues {
  return { ...values, clientSecret: "", privateKey: "", webhookSecret: "" };
}

export function InstallationIntegrationsPage(
  { outcome }: { readonly outcome: RegistrationOutcome | null },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const options = integrationAppRegistrationQueryOptions(api, scope);
  const registration = useQuery(options);
  const [createStatus, setCreateStatus] = useState<CreateStatus>("idle");
  const [appName, setAppName] = useState(() =>
    defaultAppName(globalThis.location?.hostname ?? "")
  );
  const [handoff, setHandoff] = useState<ManifestHandoff | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [existing, setExisting] = useState<ExistingAppValues>(
    EMPTY_EXISTING_APP,
  );
  const [existingStatus, setExistingStatus] = useState<ExistingAppStatus>(
    "idle",
  );
  useEffect(() => {
    setCreateStatus("idle");
    setHandoff(null);
    setForbidden(false);
    setExisting(EMPTY_EXISTING_APP);
    setExistingStatus("idle");
  }, [scope.sessionGeneration]);
  // Back from GitHub can restore this page from the back/forward cache with
  // the spent hand-off still in state; the single-use values are useless now.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setCreateStatus("idle");
      setHandoff(null);
    };
    globalThis.addEventListener("pageshow", reset);
    return () => globalThis.removeEventListener("pageshow", reset);
  }, []);
  const [, create] = useSingleFlightSubmit(async () => {
    const name = parseAppName(appName);
    if (name === null) return;
    setCreateStatus("starting");
    const started = scope.sessionGeneration;
    const result = await api.integrationAppRegistrations.begin({
      input: { name },
    });
    if (started !== scope.sessionGeneration) return;
    if (result.ok) {
      setHandoff({
        registrationUrl: result.data.registrationUrl,
        manifest: result.data.manifest,
        state: result.data.state,
      });
      setCreateStatus("handoff");
      return;
    }
    if (isForbiddenFailure(result.error)) {
      setForbidden(true);
      setCreateStatus("idle");
      return;
    }
    if (isConflictFailure(result.error)) {
      // An existing App and a missing secrets key answer the same conflict:
      // the fresh registration tells them apart.
      const fresh = await queryClient.fetchQuery({ ...options, staleTime: 0 })
        .catch(() => null);
      setCreateStatus(
        fresh && fresh.status === "unregistered" ? "unavailable" : "idle",
      );
      return;
    }
    setCreateStatus("failed");
  });
  const dismissOutcome = () => {
    void navigate({
      to: "/settings/installation/integrations",
      search: {},
      replace: true,
    });
  };
  const startAgain = () => {
    if (outcome) dismissOutcome();
    void create();
  };
  const app = registration.data ? registeredApp(registration.data) : null;
  const registeredClientId = registration.data?.status === "registered"
    ? registration.data.clientId
    : null;
  // The registered App's public client id is a starting value for a
  // replacement. Secret fields are never filled from the server.
  useEffect(() => {
    if (registeredClientId === null) return;
    setExisting((values) =>
      values.clientId === ""
        ? { ...values, clientId: registeredClientId }
        : values
    );
  }, [registeredClientId]);
  // Replacing keeps the App, so its id is fixed.
  const existingValues: ExistingAppValues = app
    ? { ...existing, appId: String(app.appId) }
    : existing;
  const [, saveExisting] = useSingleFlightSubmit(async () => {
    const values = existingValues;
    const appId = parseAppId(values.appId);
    if (appId === null) return;
    const input: IntegrationAppRegistrationPut = {
      appId,
      clientId: values.clientId.trim(),
      privateKey: values.privateKey,
      ...(values.clientSecret === ""
        ? {}
        : { clientSecret: values.clientSecret }),
      ...(values.webhookSecret === ""
        ? {}
        : { webhookSecret: values.webhookSecret }),
    };
    // Write-only: the typed secrets leave the form before the request does.
    setExisting(withoutSecrets(values));
    setExistingStatus("saving");
    const started = scope.sessionGeneration;
    const result = await api.integrationAppRegistrations.put({
      input,
      ...(registration.data?.status === "registered"
        ? { version: registration.data.version }
        : {}),
      idempotencyKey: crypto.randomUUID(),
    });
    if (started !== scope.sessionGeneration) return;
    if (result.ok) {
      queryClient.setQueryData(options.queryKey, result.data);
      setExistingStatus("saved");
      return;
    }
    if (isForbiddenFailure(result.error)) {
      setForbidden(true);
      setExistingStatus("idle");
      return;
    }
    const failure = existingAppFailure(result.error);
    setExistingStatus(failure);
    if (failure === "stale") void registration.refetch();
  });
  const view: IntegrationsView = forbidden ||
      (registration.isError && isForbiddenFailure(registration.error))
    ? "forbidden"
    : registration.isError ||
        (registration.data?.status === "registered" && !app)
    ? "error"
    : !registration.data
    ? "loading"
    : app
    ? "registered"
    : "unregistered";
  return (
    <>
      <ShellActiveNavigation id="settings" />
      <InstallationBreadcrumbs section="settings.integrations.section">
        <InstallationIntegrationsScreen
          app={app}
          createStatus={createStatus}
          handoff={handoff}
          appName={appName}
          onAppNameChange={setAppName}
          onCreate={startAgain}
          onDismissOutcome={dismissOutcome}
          onReload={() => void registration.refetch()}
          outcome={outcome}
          storage={<InstallationSkillStorage />}
          view={view}
          existingApp={{
            values: existingValues,
            status: existingStatus,
            onChange: (field, value) => {
              setExisting({ ...existingValues, [field]: value });
              if (existingStatus !== "saving") setExistingStatus("idle");
            },
            onSubmit: () => void saveExisting(),
          }}
        />
      </InstallationBreadcrumbs>
    </>
  );
}
