import type { ArtifactKindsActionHandlers } from "./actions.ts";
import {
  createArtifactKindsListHandler,
  createArtifactKindVersionsListHandler,
  getArtifactKind,
  publishArtifactKindVersion,
} from "./postgres.ts";

export function createArtifactKindsHandlers(
  secret: string,
): ArtifactKindsActionHandlers {
  return {
    listKinds: createArtifactKindsListHandler(secret),
    getKind: getArtifactKind,
    publishVersion: publishArtifactKindVersion,
    listVersions: createArtifactKindVersionsListHandler(secret),
  };
}
