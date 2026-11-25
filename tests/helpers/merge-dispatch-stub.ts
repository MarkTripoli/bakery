import type { MergeDispatchDependencies } from "../../apps/server/src/modules/delivery/merge-dispatch.ts";
import type {
  GitHubAppClient,
} from "../../apps/server/src/modules/integrations/github-app.ts";
import type { InstallationTokenBroker } from "../../apps/server/src/modules/integrations/token-broker.ts";
import type { ReconcileDependencies } from "../../apps/server/src/modules/integrations/reconcile.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";

/**
 * Merge dispatch dependencies for fixtures that only read delivery state.
 *
 * `createDeliveryHandlers` takes the merge dispatch dependencies whoever the
 * caller is, so every read-only fixture has to supply them. Reaching them
 * would mean the fixture is driving a merge it never meant to drive, which is
 * a bug in the test rather than a code path to serve: each member therefore
 * throws with the fixture's name instead of quietly answering.
 *
 * A cast guards each interface because they describe real GitHub authority
 * well beyond what a stub can honestly implement; the cast is confined to this
 * file so a fixture cannot build a half-standing dependency by hand.
 */
export function mergeDispatchStub(owner: string): MergeDispatchDependencies {
  const refuse = (member: string): never => {
    throw new Error(
      `${owner} is a read-only fixture: merge dispatch dependency \`${member}\` was reached`,
    );
  };
  const github = new Proxy({} as GitHubAppClient, {
    get: (_target, member) => () => refuse(`github.${String(member)}`),
  });
  const broker: InstallationTokenBroker = {
    token: () => refuse("broker.token"),
    editing: () => refuse("broker.editing"),
    beginEdit: () => refuse("broker.beginEdit"),
    isCurrent: () => refuse("broker.isCurrent"),
    forget: () => refuse("broker.forget"),
    // `size` is a plain count rather than a call, so it answers 0: this broker
    // holds no state and asking never reaches GitHub.
    size: 0,
    generation: () => refuse("broker.generation"),
    serialize: () => refuse("broker.serialize"),
  };
  return { github, broker };
}

export function registrationStub(
  owner: string,
  database: PgDatabase,
): ReconcileDependencies {
  return { database, ...mergeDispatchStub(owner) };
}
