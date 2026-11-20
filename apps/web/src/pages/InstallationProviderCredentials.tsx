import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBakeryApi } from "../api/context.tsx";
import { integrationClientCredentialsQueryOptions } from "../api/query.ts";
import { failureStatus, isForbiddenFailure } from "../app/async-state.ts";
import { useSingleFlightSubmit } from "../app/auth-form.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  EMPTY_PROVIDER_CREDENTIALS,
  ProviderCredentialsSection,
  type ProviderCredentialsStatus,
  type ProviderCredentialValues,
} from "../screens/ProviderCredentialsSection.tsx";

/**
 * One provider's OAuth client credentials: loads the saved registration, saves with
 * the version it read, and never keeps the secret. The typed secret leaves the form
 * before the request does and is never refilled from a response; the client ID stays
 * as typed until the save succeeds.
 */
export function InstallationProviderCredentials(
  { provider, guideUrl }: { provider: string; guideUrl?: string },
) {
  const api = useBakeryApi();
  const scope = useProtectedScope();
  const queryClient = useQueryClient();
  const options = integrationClientCredentialsQueryOptions(
    api,
    scope,
    provider,
  );
  const credentials = useQuery(options);
  const [values, setValues] = useState<ProviderCredentialValues>(
    EMPTY_PROVIDER_CREDENTIALS,
  );
  const [status, setStatus] = useState<ProviderCredentialsStatus>("idle");
  const [forbidden, setForbidden] = useState(false);
  useEffect(() => {
    setValues(EMPTY_PROVIDER_CREDENTIALS);
    setStatus("idle");
    setForbidden(false);
  }, [scope.sessionGeneration]);
  const loaded = credentials.data;
  const [, save] = useSingleFlightSubmit(async () => {
    const current = values;
    // The secret leaves the form before the request does. The client ID is not a
    // secret: it stays as typed, so a failed save costs one field to re-enter.
    setValues({ ...EMPTY_PROVIDER_CREDENTIALS, clientId: current.clientId });
    setStatus("saving");
    const started = scope.sessionGeneration;
    const result = await api.integrationClientCredentials.put({
      provider,
      input: {
        clientId: current.clientId.trim(),
        // Pasted from a provider page, a secret often carries a trailing space or
        // newline, which the server refuses: trim it as the client ID is trimmed.
        clientSecret: current.clientSecret.trim(),
      },
      ...(loaded && loaded.configured ? { version: loaded.version } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
    if (started !== scope.sessionGeneration) return;
    if (result.ok) {
      queryClient.setQueryData(options.queryKey, result.data);
      setValues(EMPTY_PROVIDER_CREDENTIALS);
      setStatus("idle");
      return;
    }
    if (isForbiddenFailure(result.error)) {
      setValues(EMPTY_PROVIDER_CREDENTIALS);
      setForbidden(true);
      setStatus("idle");
      return;
    }
    const code = failureStatus(result.error);
    if (code === 412 || code === 428) {
      // Someone saved first: show what is stored now, and nothing of what was typed.
      setValues(EMPTY_PROVIDER_CREDENTIALS);
      setStatus("stale");
      await credentials.refetch();
      return;
    }
    // Any other failure saved nothing: the form stays open with the client ID kept.
    setStatus("failed");
  });
  const view = forbidden || (credentials.isError &&
      isForbiddenFailure(credentials.error))
    ? "forbidden"
    : credentials.isError
    ? "error"
    : loaded
    ? "ready"
    : "loading";
  return (
    <ProviderCredentialsSection
      guideUrl={guideUrl}
      onChange={(field, value) =>
        setValues((current) => ({ ...current, [field]: value }))}
      onCancel={() => {
        setValues(EMPTY_PROVIDER_CREDENTIALS);
        setStatus("idle");
      }}
      onReload={() => void credentials.refetch()}
      onSubmit={() => void save()}
      provider={provider}
      saved={loaded
        ? {
          configured: loaded.configured,
          clientId: loaded.clientId,
          clientSecretSavedAt: loaded.clientSecretSavedAt,
          callbackUrl: loaded.callbackUrl,
        }
        : null}
      status={status}
      values={values}
      view={view}
    />
  );
}
