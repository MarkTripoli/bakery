import type { SecretsKeyConfig } from "@bakery/config";
import { StandardError } from "@bakery/contracts/http";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { loadSecretKey } from "../secrets/crypto.ts";
import { type AppCredentials, openAppSecret } from "./callbacks.ts";
import type {
  GitHubAppClient,
  GitHubInstallationToken,
  GitHubPermissions,
} from "./github-app.ts";
import { createGitHubAppJwt } from "./github-app.ts";

/** A cached token is dropped this long before GitHub would expire it. */
export const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
/** GitHub installation tokens last one hour; never trust a longer answer. */
const TOKEN_MAX_LIFETIME_MS = 60 * 60_000;

/** The connection and authority one installation token is minted for. */
export type TokenTarget = {
  connectionId: string;
  /**
   * The connection's invalidation generation, captured before its status
   * and selection were read. A moved generation means an edit committed
   * since: nothing is minted.
   */
  generation: number;
  /** Lifecycle status read in the same request; only `enabled` mints. */
  status: string;
  /**
   * The installation's lifecycle status read in the same request; only
   * `enabled` mints. A suspended or revoked installation holds no authority.
   */
  installationStatus: string;
  appId: number;
  privateKey: AppCredentials["privateKey"];
  installationId: number;
  repositoryIds: readonly number[];
  permissions: GitHubPermissions;
};

type Entry = { token: GitHubInstallationToken; reuseUntil: number };
type Namespace = {
  generation: number;
  /** Edits of this connection that have started and not yet settled. */
  editing: number;
  entries: Map<string, Entry>;
};

export type InstallationTokenBroker = {
  /**
   * A token narrowed to the target's repositories and permissions, from the
   * cache while it is more than five minutes from expiry, else freshly
   * minted. A connection that is not enabled, an installation that is not
   * enabled, or a connection edited (or reconciled) since the target's
   * generation was captured, is refused with 409 before the key is
   * decrypted or GitHub is called.
   */
  token(
    target: TokenTarget,
    signal: AbortSignal,
  ): Promise<GitHubInstallationToken | { kind: "refused" }>;
  /**
   * Runs one edit of the connection. While it runs, and once it settled, no
   * token is minted or reused for the state before it: the cache is dropped
   * on entry and exit, the generation moves both times, and `token` refuses
   * while any edit is in progress.
   */
  editing<T>(connectionId: string, run: () => Promise<T>): Promise<T>;
  /**
   * Opens the same edit window as `editing` and returns the call that
   * closes it; closing twice is harmless.
   */
  beginEdit(connectionId: string): () => void;
  /** Whether nothing edited the connection since `generation` was captured. */
  isCurrent(connectionId: string, generation: number): boolean;
  /**
   * Drops a cached token its caller saw GitHub fail with, so the next
   * request mints afresh instead of reusing a revoked or dead token.
   */
  forget(connectionId: string, token: string): void;
  /**
   * Connections the broker holds state for; reads never add one. An
   * observable for diagnostics and the provider tests that prove refused
   * requests leave no state.
   */
  readonly size: number;
  /**
   * The connection's current invalidation generation. Reading it creates no
   * state, so unauthenticated requests cannot grow the broker.
   */
  generation(connectionId: string): number;
  /** Runs `run` after every earlier run for the same installation settles. */
  serialize<T>(installationId: number, run: () => Promise<T>): Promise<T>;
};

/** 409 for a connection that may not hold provider authority right now. */
export function connectionNotEnabled(status: string): StandardError {
  return new StandardError({
    code: "STATE_CONFLICT",
    params: {
      reason: status === "pending" || status === "disabled" ||
          status === "revoked"
        ? `connection_${status}`
        : "connection_unavailable",
    },
  });
}

/**
 * 409 for an installation that is pending, suspended or revoked: the same
 * reason the connection and resource edits give, whatever the status.
 */
export function installationNotEnabled(): StandardError {
  return new StandardError({
    code: "STATE_CONFLICT",
    params: { reason: "installation_unavailable" },
  });
}

/**
 * In-memory installation token broker. Tokens never leave process memory:
 * no row, log, event or response carries one. The App private key is
 * decrypted per mint, imported as a non-extractable signing key for one
 * nine-minute RS256 App JWT, and dropped.
 */
export function createInstallationTokenBroker(
  dependencies: {
    github: GitHubAppClient;
    secretsKey?: SecretsKeyConfig;
    now?: () => number;
  },
): InstallationTokenBroker {
  const now = dependencies.now ?? Date.now;
  const namespaces = new Map<string, Namespace>();
  const queues = new Map<number, Promise<unknown>>();
  const namespace = (connectionId: string): Namespace => {
    let value = namespaces.get(connectionId);
    if (value === undefined) {
      value = { generation: 0, editing: 0, entries: new Map() };
      namespaces.set(connectionId, value);
    }
    return value;
  };
  const cacheKey = (target: TokenTarget) =>
    canonicalJson({
      appId: target.appId,
      installationId: target.installationId,
      repositoryIds: [...target.repositoryIds].sort((a, b) => a - b),
      permissions: Object.fromEntries(
        Object.entries(target.permissions).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        ),
      ),
    });
  /** Refuses while the connection is being edited or was edited since `generation`. */
  const assertCurrent = (space: Namespace, generation: number) => {
    if (space.generation !== generation || space.editing > 0) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "connection_changed" },
      });
    }
  };
  const mint = async (
    target: TokenTarget,
    space: Namespace,
    signal: AbortSignal,
  ) => {
    const key = await loadSecretKey(dependencies.secretsKey);
    let pem: string;
    try {
      pem = await openAppSecret(key, target.privateKey);
    } catch {
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    // The PEM lives only for this signing call.
    const jwt = await createGitHubAppJwt(target.appId, pem, now());
    // An edit may have started or settled while the key was opened.
    assertCurrent(space, target.generation);
    signal.throwIfAborted();
    return await dependencies.github.mintInstallationToken(
      {
        jwt,
        installationId: target.installationId,
        repositoryIds: target.repositoryIds,
        permissions: target.permissions,
      },
      signal,
    );
  };
  const beginEdit = (connectionId: string) => {
    const space = namespace(connectionId);
    space.editing += 1;
    space.entries.clear();
    space.generation += 1;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      space.entries.clear();
      space.generation += 1;
      space.editing -= 1;
    };
  };
  return {
    async token(target, signal) {
      if (target.status !== "enabled") {
        throw connectionNotEnabled(target.status);
      }
      if (target.installationStatus !== "enabled") {
        throw installationNotEnabled();
      }
      const space = namespace(target.connectionId);
      assertCurrent(space, target.generation);
      const key = cacheKey(target);
      const cached = space.entries.get(key);
      if (cached !== undefined) {
        if (cached.reuseUntil > now()) return cached.token;
        space.entries.delete(key);
      }
      const minted = await mint(target, space, signal);
      if (minted.kind !== "minted") return minted;
      const reuseUntil =
        Math.min(minted.expiresAt, now() + TOKEN_MAX_LIFETIME_MS) -
        TOKEN_EXPIRY_MARGIN_MS;
      // An invalidation while GitHub was minting keeps this token out of the
      // cache; only this request uses it.
      if (
        space.generation === target.generation && space.editing === 0 &&
        reuseUntil > now()
      ) {
        space.entries.set(key, { token: minted, reuseUntil });
      }
      return minted;
    },
    async editing(connectionId, run) {
      const end = beginEdit(connectionId);
      try {
        return await run();
      } finally {
        end();
      }
    },
    beginEdit,
    isCurrent(connectionId, generation) {
      const space = namespaces.get(connectionId);
      // A namespace is never deleted, so an absent one is at generation 0.
      return space === undefined
        ? generation === 0
        : space.generation === generation && space.editing === 0;
    },
    generation(connectionId) {
      return namespaces.get(connectionId)?.generation ?? 0;
    },
    forget(connectionId, token) {
      const space = namespaces.get(connectionId);
      if (space === undefined) return;
      for (const [key, entry] of space.entries) {
        if (entry.token.token === token) space.entries.delete(key);
      }
    },
    get size() {
      return namespaces.size;
    },
    serialize(installationId, run) {
      const previous = queues.get(installationId) ?? Promise.resolve();
      const result = previous.catch(() => {}).then(run);
      const settled = result.catch(() => {});
      queues.set(installationId, settled);
      settled.then(() => {
        if (queues.get(installationId) === settled) {
          queues.delete(installationId);
        }
      });
      return result;
    },
  };
}
