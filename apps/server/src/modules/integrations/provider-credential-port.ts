import type { SecretsKeyConfig } from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";
import type {
  CredentialStrategy,
  DriverContext,
  SecretSlots,
} from "@bakery/integration-sdk/provider";
import type { PgDatabase } from "../../platform/database.ts";
import { withPgTransaction } from "../../platform/database.ts";
import {
  type CredentialPort,
  type CredentialRequest,
  opaqueCredential,
} from "../catalog/integration-gate-broker.ts";
import { openInstallationSecret } from "../secrets/installation-secrets.ts";

const MINT_DEADLINE_MS = 10_000;
const SLOT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function encodeSecretSlots(
  slots: Readonly<Record<string, string>>,
): string {
  const encoded: Record<string, string> = {};
  for (const [name, value] of Object.entries(slots)) {
    if (!SLOT_NAME.test(name)) throw new Error("invalid secret slot name");
    encoded[name] = btoa(
      String.fromCharCode(...new TextEncoder().encode(value)),
    );
  }
  return JSON.stringify(encoded);
}

export function decodeSecretSlots(
  stored: string,
  wanted: readonly string[],
): SecretSlots {
  const parsed: unknown = JSON.parse(stored);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("stored secret slots are not an object");
  }
  const slots: Record<string, Uint8Array> = {};
  for (const name of wanted) {
    const value = (parsed as Record<string, unknown>)[name];
    if (typeof value !== "string") continue;
    slots[name] = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  }
  return slots;
}

const authRequired = (reason = "auth_required") =>
  new StandardError({
    code: "STATE_CONFLICT",
    detail: "auth_required",
    params: { reason },
  });

const MINT_ORIGIN = new URL("https://mint.invalid/");

const refusingDriver = (signal: AbortSignal): DriverContext => ({
  provider: {
    send: () => Promise.reject(new Error("minting never sends a request")),
  },
  origin: { apiBaseUrl: MINT_ORIGIN, webBaseUrl: MINT_ORIGIN },
  signal,
  now: () => new Date(),
});

export type StoredSlotReader = (
  request: CredentialRequest,
) => Promise<string | null>;

export type MintingProvider = Readonly<{
  impl: Readonly<{
    hostProfile: string;
    gate?: unknown;
    credentials: CredentialStrategy;
  }>;
}>;

export type MintingProviders = Readonly<{
  providers: readonly MintingProvider[];
}>;

export type ProviderCredentialPortDeps = Readonly<{
  providers: MintingProviders;
  readStoredSlots: StoredSlotReader;
}>;

export function providerForProfile(
  providers: MintingProviders,
  profileId: string,
): MintingProvider | undefined {
  return providers.providers.find((provider) =>
    provider.impl.gate !== undefined && provider.impl.hostProfile === profileId
  );
}

export function postgresStoredSlotReader(
  database: PgDatabase,
  secretsKey: SecretsKeyConfig | undefined,
): StoredSlotReader {
  return (request) =>
    withPgTransaction(database, async (transaction) => {
      const found = await transaction.query<{ secretId: string | null }>(
        `select installation.credential_secret_id as "secretId"
         from bakery.integration_connections connection
         join bakery.integration_installations installation
           on installation.id = connection.installation_id
          and installation.status = 'enabled'
        where connection.organization_id = $1 and connection.id = $2
          and connection.installation_id = $3
          and connection.archived_at is null
          and connection.status = 'enabled'`,
        [
          request.organizationId,
          request.connectionId,
          request.subject.installId,
        ],
      );
      const secretId = found.rows[0]?.secretId ?? null;
      if (secretId === null) return null;
      return await openInstallationSecret(transaction, secretsKey, secretId);
    });
}

export function createProviderCredentialPort(
  deps: ProviderCredentialPortDeps,
): CredentialPort {
  return {
    async resolve(request) {
      if (request.runEnvironment === "offline") {
        throw new StandardError({
          code: "STATE_CONFLICT",
          detail: "environment_offline",
          params: { reason: "environment_offline" },
        });
      }
      if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
        throw authRequired();
      }
      const provider = providerForProfile(deps.providers, request.profileId);
      if (provider === undefined) throw authRequired("unknown_profile");
      let stored: string | null;
      try {
        stored = await deps.readStoredSlots(request);
      } catch {
        throw authRequired();
      }
      if (stored === null) throw authRequired();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MINT_DEADLINE_MS);
      try {
        const minted = await provider.impl.credentials.mint({
          binding: null,
          permissions: { ...request.providerPermissions },
          secrets: decodeSecretSlots(
            stored,
            provider.impl.credentials.secretSlots,
          ),
          ctx: refusingDriver(controller.signal),
        });
        if (minted.placement !== "bearer" || minted.token.length === 0) {
          throw authRequired();
        }
        if (minted.expiresAt !== null && minted.expiresAt <= new Date()) {
          throw authRequired("credential_expired");
        }
        return opaqueCredential(minted.token);
      } catch (error) {
        if (error instanceof StandardError) throw error;
        throw authRequired();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function routeCredentialsByProfile(
  installation: CredentialPort,
  provider: CredentialPort,
  installationProfiles: ReadonlySet<string>,
): CredentialPort {
  return {
    resolve: (request) =>
      installationProfiles.has(request.profileId)
        ? installation.resolve(request)
        : provider.resolve(request),
  };
}
