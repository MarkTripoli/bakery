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
  /** The validated numeric installation id the token is minted for. */
  installationId: number;
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

/** How long one installation token mint may take before it is abandoned. */
const MINT_DEADLINE_MS = 10_000;

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
    // The snapshot names the installation the invocation was authorized under.
    // If the connection now points at a different one, the authorization is for
    // an installation this request would not use, so there is nothing to mint.
    if (connectionRow.installationId !== request.subject.installId) return null;
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
    // `Number()` maps anything unparseable to NaN, and a NaN installation id
    // would reach the client as a request for installation "NaN". A row that
    // cannot name its installation is not mintable.
    const installationId = Number(installRow.externalId);
    if (!Number.isSafeInteger(installationId) || installationId < 1) {
      return null;
    }
    const credentials = await deps.readAppCredentials(transaction);
    if (credentials === null) return null;
    return {
      status: connectionRow.status,
      installationStatus: installRow.status,
      installationExternalId: installRow.externalId,
      installationId,
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
      // An offline run never receives a brokered credential, whatever the
      // invocation was authorized for: refused before any row or key is read.
      if (request.runEnvironment === "offline") {
        throw new StandardError({
          code: "STATE_CONFLICT",
          detail: "environment_offline",
          params: { reason: "environment_offline" },
        });
      }
      // The generation was captured BEFORE the authority snapshot this request
      // was authorized against, upstream in the broker. Reading it here instead
      // would compare a fresh value against itself and see no change, so an edit
      // landing between the snapshot and now would go unnoticed. A request that
      // carries none is refused rather than minted against an unpinned snapshot.
      const generation = request.generation;
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          detail: "auth_required",
          params: { reason: "auth_required" },
        });
      }
      // Narrowing is not a detail to discover after the read: a request with no
      // repository to narrow to is refused before anything is read.
      const repositoryIds = repositoryIdsOf(request);
      const authority = await readTokenAuthority(deps, request, generation);
      const target: TokenTarget = {
        connectionId: authority.connectionId,
        generation: authority.generation,
        status: authority.status,
        installationStatus: authority.installationStatus,
        appId: authority.appId,
        privateKey: authority.privateKey,
        installationId: authority.installationId,
        repositoryIds,
        permissions: narrowPermissions(request.providerPermissions),
      };
      // A mint that never answers would hold the send open indefinitely, so it
      // gets a deadline of its own. The caller's request deadline cannot stand in
      // for one: the credential is fetched before the request is built.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MINT_DEADLINE_MS);
      let minted: Awaited<ReturnType<typeof deps.broker.token>>;
      try {
        minted = await deps.broker.token(target, controller.signal);
      } catch (error) {
        // An aborted mint is the same answer as a refusal: no usable credential.
        if (controller.signal.aborted) {
          throw new StandardError({
            code: "DEPENDENCY_UNAVAILABLE",
            detail: "auth_required",
            params: { retryAfterSeconds: 30 },
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
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
      /** The connection's generation, read before the authority snapshot. */
      generationOf: (connectionId: string) => number;
    }>,
): ProviderRequestPort {
  return createBroker({
    registry: deps.registry,
    credentials: createInstallationCredentialPort(deps),
    fetch: deps.fetch,
    snapshotPort: deps.snapshotPort,
    generationOf: deps.generationOf,
  });
}
