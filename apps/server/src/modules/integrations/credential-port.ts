import { StandardError } from "@bakery/contracts/http";
import {
  type PgDatabase,
  type PgTransactionClient,
  withPgTransaction,
} from "../../platform/database.ts";
import {
  type CredentialPort,
  type CredentialRequest,
  opaqueCredential,
} from "../catalog/integration-gate-broker.ts";
import type { AppCredentials } from "./callbacks.ts";
import {
  type BrokerDeps,
  createBroker,
} from "../catalog/integration-gate-broker.ts";
import type { ProviderRequestPort } from "../catalog/integration-gate.ts";
import {
  type InstallationTokenBroker,
  type TokenTarget,
} from "./token-broker.ts";

/**
 * The production credential store: an installation token, minted per invocation.
 *
 * Until this file the invoke door ran with `denyAllProviderRequests`, so a
 * correctly authorized send could not leave the process. The broker, the
 * profiles and the token broker were all already written and already took a
 * registry; what was missing was the piece that turns "this invocation is
 * authorized" into "here is a credential that matches the profile it is going
 * to be placed in".
 *
 * Two properties this holds, both of which are the reason it is not a thin
 * passthrough:
 *
 * 1. **Generation before read.** The connection's invalidation generation is
 *    captured *before* the rows are read, so an edit that commits mid-request
 *    moves the generation and the broker refuses instead of minting a token
 *    against authority that has since changed. Capturing it after the read would
 *    leave a window where a revoked connection still mints.
 * 2. **Narrowed, never widened.** The permissions handed to the broker are the
 *    ones the action declared. A token is never minted with more authority than
 *    the call being made, even if the installation holds more.
 */

/** The rows a token needs, read once, after the generation is captured. */
type TokenAuthority = Readonly<{
  connectionId: string;
  generation: number;
  status: string;
  installationStatus: string;
  installationExternalId: string;
  appId: number;
  privateKey: AppCredentials["privateKey"];
}>;

export type CredentialStoreDeps = Readonly<{
  database: PgDatabase;
  /** The process's installation token broker and its generation counter. */
  broker: InstallationTokenBroker;
  /**
   * Reads the app credentials for an installation, decrypting with the
   * process's secrets key. Injected so this module never holds the key.
   */
  readAppCredentials(
    transaction: PgTransactionClient,
  ): Promise<AppCredentials | null>;
  /** The connection's current invalidation generation. */
  generationOf(connectionId: string): number;
}>;

/** The permission set a token is minted with, as the action declared it. */
function narrowPermissions(
  requested: Readonly<Record<string, "read" | "write">>,
): Record<string, "read" | "write"> {
  return { ...requested };
}

/**
 * Reads the connection and installation rows a token needs.
 *
 * Every field is required: a missing row is not a default but a refusal, because
 * a token minted from guessed values is a token nobody can reason about.
 */
async function readTokenAuthority(
  deps: CredentialStoreDeps,
  request: CredentialRequest,
  generation: number,
): Promise<TokenAuthority> {
  const row = await withPgTransaction(deps.database, async (transaction) => {
    const connection = await transaction.query<
      { status: string; installationId: string }
    >(
      `select status, installation_id as "installationId"
         from bakery.integration_connections
        where organization_id = $1 and id = $2 and archived_at is null`,
      [request.organizationId, request.connectionId],
    );
    const connectionRow = connection.rows[0];
    if (!connectionRow) return null;
    const install = await transaction.query<
      { status: string; externalId: string }
    >(
      `select status, external_id as "externalId"
         from bakery.integration_installations
        where id = $1 and archived_at is null`,
      [connectionRow.installationId],
    );
    const installRow = install.rows[0];
    if (!installRow) return null;
    const credentials = await deps.readAppCredentials(transaction);
    if (credentials === null) return null;
    return {
      status: connectionRow.status,
      installationStatus: installRow.status,
      installationExternalId: installRow.externalId,
      appId: credentials.appId,
      privateKey: credentials.privateKey,
    };
  });
  if (row === null) {
    // A connection whose rows are gone is not mintable; the caller sees the same
    // auth-required conflict a refused broker answer produces, so there is one
    // shape for "no usable credential" rather than two.
    throw new StandardError({
      code: "STATE_CONFLICT",
      detail: "auth_required",
      params: { reason: "auth_required" },
    });
  }
  return { connectionId: request.connectionId, generation, ...row };
}

/**
 * The numeric repository id the token is narrowed to.
 *
 * A GitHub App installation token is narrowed to a repository set, so a request
 * with nothing to narrow to cannot produce a usable credential at all: the
 * client refuses an empty set and the send dies at the last moment with a
 * dependency error that says nothing about the cause. Refusing here instead
 * names it, and refuses before any row is read or any key is touched.
 */
function repositoryIdsOf(request: CredentialRequest): readonly number[] {
  const repositoryId = request.subject.repositoryId;
  const numeric = repositoryId === undefined
    ? Number.NaN
    : Number(repositoryId);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      detail: "auth_required",
      params: { reason: "repository_unbound" },
    });
  }
  return [numeric];
}

/**
 * A `CredentialPort` over the installation token broker.
 *
 * Refusals stay the broker's: a disabled connection, a disabled installation or a
 * moved generation answers `refused` there, before any GitHub call, and are
 * surfaced here as the auth-required conflict the broker's caller already raises
 * at that stage.
 */
export function createInstallationCredentialPort(
  deps: CredentialStoreDeps,
): CredentialPort {
  return {
    async resolve(request) {
      // Captured BEFORE the rows are read, so an edit that commits mid-request
      // moves the generation and the broker refuses rather than minting stale.
      // Narrowing is not a detail to discover after the read: a request with no
      // repository to narrow to is refused before anything is read.
      const repositoryIds = repositoryIdsOf(request);
      const generation = deps.generationOf(request.connectionId);
      const authority = await readTokenAuthority(deps, request, generation);
      const target: TokenTarget = {
        connectionId: authority.connectionId,
        generation: authority.generation,
        status: authority.status,
        installationStatus: authority.installationStatus,
        appId: authority.appId,
        privateKey: authority.privateKey,
        installationId: Number(authority.installationExternalId),
        repositoryIds,
        permissions: narrowPermissions(request.providerPermissions),
      };
      const minted = await deps.broker.token(
        target,
        new AbortController().signal,
      );
      // Both arms carry `kind`; the token is the "minted" one. Testing mere
      // presence would refuse every success.
      if (minted.kind !== "minted") {
        // The broker refused. Its reasons are the ones that matter (disabled,
        // suspended, stale generation) and re-reporting them individually here
        // would be a second copy of a decision it already made.
        throw new StandardError({
          code: "STATE_CONFLICT",
          detail: "auth_required",
          params: { reason: "auth_required" },
        });
      }
      return opaqueCredential(minted.token);
    },
  };
}

/**
 * The production `ProviderRequestPort`: the gate's broker over real credentials.
 *
 * `createBroker` had no production caller before this: it needed a
 * `CredentialPort`, and nothing implemented one, so every path that could have
 * sent ran on `denyAllProviderRequests`. Assembling it here keeps the credential
 * source and the sender in one place, so a caller cannot wire one without the
 * other.
 */
export function createProviderRequestPort(
  deps:
    & CredentialStoreDeps
    & Readonly<{
      registry: BrokerDeps["registry"];
      fetch: typeof fetch;
      snapshotPort: BrokerDeps["snapshotPort"];
    }>,
): ProviderRequestPort {
  return createBroker({
    registry: deps.registry,
    credentials: createInstallationCredentialPort(deps),
    fetch: deps.fetch,
    snapshotPort: deps.snapshotPort,
  });
}
