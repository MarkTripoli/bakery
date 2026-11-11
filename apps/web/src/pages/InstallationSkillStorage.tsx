import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApiFailure,
  SkillStorageSettings,
  SkillStorageSettingsPut,
} from "../api/client.ts";
import { useBakeryApi } from "../api/context.tsx";
import { skillStorageQueryOptions } from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  EMPTY_SKILL_STORAGE,
  type SkillStorageProbeRefusal,
  type SkillStorageSaved,
  type SkillStorageSaveStatus,
  SkillStorageSection,
  type SkillStorageValues,
  type SkillStorageVerifyStatus,
  type SkillStorageView,
} from "../screens/SkillStorageSection.tsx";

/** The saved settings as the section shows them. */
function savedSettings(settings: SkillStorageSettings): SkillStorageSaved {
  return {
    backend: settings.backend,
    configured: settings.configured,
    accountId: settings.accountId,
    bucket: settings.bucket,
    credentialRevision: settings.credentialRevision,
    credentialUpdatedAt: settings.credentialUpdatedAt,
  };
}

/** The non-secret fields prefilled from the server; credentials stay empty. */
function seeded(settings: SkillStorageSettings): SkillStorageValues {
  return {
    ...EMPTY_SKILL_STORAGE,
    accountId: settings.accountId ?? "",
    bucket: settings.bucket ?? "",
  };
}

const PROBE_REFUSALS: ReadonlySet<string> = new Set<SkillStorageProbeRefusal>([
  "not_configured",
  "credentials_rejected",
  "access_denied",
  "bucket_not_found",
  "endpoint_unreachable",
  "integrity_failed",
  "provider_error",
]);

/** The outcome a refused save renders; every refusal saved nothing. */
function saveFailure(error: ApiFailure): SkillStorageSaveStatus {
  const status = failureStatus(error);
  const problem = error.kind === "problem" ? error.problem : null;
  // 400 and 422 map by status; the client normalizes the server's array issue
  // paths, so a 422 keeps its issue codes.
  if (status === 400) return "malformed";
  if (status === 422) {
    // A rotation refused by the pre-save probe names the fixed outcome.
    const code = problem?.issueCodes?.find((value) =>
      PROBE_REFUSALS.has(value)
    );
    return code ? `probe:${code}` as SkillStorageSaveStatus : "rejected";
  }
  if (status === 412 || status === 428) return "stale";
  if (status === 409 && problem?.code === "STATE_CONFLICT") {
    // No reason is the missing secrets key.
    return problem.reason === "backend_active"
      ? "backendActive"
      : "unavailable";
  }
  return "failed";
}

/**
 * The "Object storage" section: loads the saved settings, saves them with the
 * current version, and runs the verification probe. Credential inputs are
 * cleared before every request and never refilled from a response.
 */
export function InstallationSkillStorage() {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const options = skillStorageQueryOptions(api, scope);
  const settings = useQuery(options);
  const [values, setValues] = useState<SkillStorageValues>(EMPTY_SKILL_STORAGE);
  const [status, setStatus] = useState<SkillStorageSaveStatus>("idle");
  const [verification, setVerification] = useState<SkillStorageVerifyStatus>({
    state: "idle",
  });
  const [forbidden, setForbidden] = useState(false);
  useEffect(() => {
    setValues(EMPTY_SKILL_STORAGE);
    setStatus("idle");
    setVerification({ state: "idle" });
    setForbidden(false);
  }, [scope.sessionGeneration]);
  const loaded = settings.data;
  // The first load prefills the saved account and bucket once.
  useEffect(() => {
    if (!loaded) return;
    setValues((current) =>
      current.accountId === "" && current.bucket === ""
        ? seeded(loaded)
        : current
    );
  }, [loaded]);
  const [, save] = useSingleFlightSubmit(async () => {
    const current = values;
    const input: SkillStorageSettingsPut = {
      accountId: current.accountId,
      bucket: current.bucket,
      ...(current.accessKeyId === "" && current.secretAccessKey === "" ? {} : {
        accessKeyId: current.accessKeyId,
        secretAccessKey: current.secretAccessKey,
      }),
    };
    // Write-only: the typed credentials leave the form before the request does.
    setValues({ ...current, accessKeyId: "", secretAccessKey: "" });
    setStatus("saving");
    setVerification({ state: "idle" });
    const started = scope.sessionGeneration;
    const result = await api.skillStorage.put({
      input,
      ...(loaded && loaded.version > 0 ? { version: loaded.version } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
    if (started !== scope.sessionGeneration) return;
    if (result.ok) {
      queryClient.setQueryData(options.queryKey, result.data);
      setValues(seeded(result.data));
      setStatus("saved");
      return;
    }
    if (isForbiddenFailure(result.error)) {
      setForbidden(true);
      setStatus("idle");
      return;
    }
    const failure = saveFailure(result.error);
    setStatus(failure);
    if (failure === "stale" || failure === "backendActive") {
      // Show the current values so the next attempt starts from them.
      const fresh = await settings.refetch();
      if (started === scope.sessionGeneration && fresh.data) {
        setValues(seeded(fresh.data));
      }
    }
  });
  const [, verify] = useSingleFlightSubmit(async () => {
    setVerification({ state: "verifying" });
    setStatus("idle");
    const started = scope.sessionGeneration;
    const result = await api.skillStorage.verify({
      idempotencyKey: crypto.randomUUID(),
    });
    if (started !== scope.sessionGeneration) return;
    if (result.ok) {
      setVerification({ state: "done", outcome: result.data.outcome });
      return;
    }
    if (isForbiddenFailure(result.error)) {
      setForbidden(true);
      setVerification({ state: "idle" });
      return;
    }
    setVerification({ state: "failed" });
  });
  const view: SkillStorageView = forbidden ||
      (settings.isError && isForbiddenFailure(settings.error))
    ? "forbidden"
    : settings.isError
    ? "error"
    : !loaded
    ? "loading"
    : "ready";
  return (
    <SkillStorageSection
      onChange={(field, value) => {
        setValues({ ...values, [field]: value });
        if (status !== "saving") setStatus("idle");
      }}
      onReload={() => void settings.refetch()}
      onSubmit={() => void save()}
      onVerify={() => void verify()}
      saved={loaded ? savedSettings(loaded) : null}
      status={status}
      values={values}
      verification={verification}
      view={view}
    />
  );
}
