import {
  type ApiFailure,
  type BakeryApiClient,
  type RepositoryProfileResponse,
  type RepositoryResponse,
  versionEtag,
} from "../../api/client.ts";
import {
  configDigest,
  hasOwnRules,
  settingsConfig,
} from "./repository-state.ts";

/** The three calls the working settings need, so a test can drive the same sequence against the real routes. */
export type SaveApi = Pick<
  BakeryApiClient,
  "createRepositoryProfile" | "getRepository" | "updateRepository"
>;

export type SaveInput = {
  readonly organizationId: string;
  readonly repository: Pick<
    RepositoryResponse,
    "id" | "defaultBranch" | "version"
  >;
  /** The version in use, whose config the new one keeps everything else of. */
  readonly previous: RepositoryProfileResponse | null;
  readonly revision: number;
  readonly branches: readonly string[];
  readonly folder: string;
  /** One key for the new version; the same key replays it if the answer was lost. */
  readonly createKey: string;
  /** The key for putting a version in use, by the repository version it is sent with. */
  readonly useKey: (profileId: string, version: number) => string;
};

export type SaveResult =
  | {
    readonly ok: true;
    readonly profile: RepositoryProfileResponse;
    /** Who put the version in use: the server did it with the save, or the page did. */
    readonly putInUseBy: "server" | "page";
  }
  | { readonly ok: false; readonly step: "create"; readonly error: ApiFailure }
  | {
    readonly ok: false;
    readonly step: "use";
    readonly error: ApiFailure;
    readonly profile: RepositoryProfileResponse;
  };

/**
 * Save working settings: create the next version, then make sure it is in use.
 * The server puts a repository's first version in use itself, and also one
 * whose base is not the default branch, which moves the repository's version;
 * so the repository is read again after the save, and the page only puts the
 * version in use (with the version it just read) if the server has not.
 *
 * A version in use that carries rules of the repository's own is never
 * restated: the save asks the server to keep them (`keepRepositoryRules`),
 * which then puts the new version in use itself, under the repository version
 * sent as If-Match (#461). Branches are all it may change.
 */
export async function saveWorkingSettings(
  api: SaveApi,
  input: SaveInput,
): Promise<SaveResult> {
  const config = settingsConfig(input.previous?.config ?? null, {
    base: input.repository.defaultBranch,
    branches: input.branches,
    folder: input.folder,
  });
  const keepsRules = input.previous !== null &&
    hasOwnRules(input.previous.config);
  const created = await api.createRepositoryProfile({
    organizationId: input.organizationId,
    repositoryId: input.repository.id,
    input: {
      revision: input.revision,
      config,
      digest: await configDigest(config),
      ...(keepsRules ? { keepRepositoryRules: true } : {}),
    },
    ...(keepsRules ? { ifMatch: versionEtag(input.repository.version) } : {}),
    idempotencyKey: input.createKey,
  });
  if (!created.ok) return { ok: false, step: "create", error: created.error };
  const profile = created.data;
  const fresh = await api.getRepository({
    organizationId: input.organizationId,
    id: input.repository.id,
  });
  if (!fresh.ok) {
    return { ok: false, step: "use", error: fresh.error, profile };
  }
  if (fresh.data.activeProfileId === profile.id) {
    return { ok: true, profile, putInUseBy: "server" };
  }
  const used = await api.updateRepository({
    organizationId: input.organizationId,
    id: input.repository.id,
    input: { activeProfileId: profile.id },
    ifMatch: versionEtag(fresh.data.version),
    idempotencyKey: input.useKey(profile.id, fresh.data.version),
  });
  if (!used.ok) return { ok: false, step: "use", error: used.error, profile };
  return { ok: true, profile, putInUseBy: "page" };
}
