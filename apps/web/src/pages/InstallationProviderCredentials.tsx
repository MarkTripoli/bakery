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
  { provider, guideUrl, connectAvailable, signingSecret }: {
    provider: string;
    guideUrl?: string;
    connectAvailable?: boolean;
    signingSecret?: boolean;
  },
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
    const signing = current.signingSecret.trim();
    setValues({ ...EMPTY_PROVIDER_CREDENTIALS, clientId: current.clientId });
    setStatus("saving");
    const started = scope.sessionGeneration;
    const result = await api.integrationClientCredentials.put({
      provider,
      input: {
        clientId: current.clientId.trim(),
        clientSecret: current.clientSecret.trim(),
        ...(signing === "" ? {} : { signingSecret: signing }),
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
      setValues(EMPTY_PROVIDER_CREDENTIALS);
      setStatus("stale");
      await credentials.refetch();
      return;
    }
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
      connectAvailable={connectAvailable}
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
      signingSecret={signingSecret}
      saved={loaded
        ? {
          configured: loaded.configured,
          clientId: loaded.clientId,
          clientSecretSavedAt: loaded.clientSecretSavedAt,
          signingSecretSavedAt: loaded.signingSecretSavedAt,
          callbackUrl: loaded.callbackUrl,
        }
        : null}
      status={status}
      values={values}
      view={view}
    />
  );
}
