/**
 * Version metadata keys that record a version's source draft. Only draft
 * publication writes them; any other publisher supplying one is refused, so
 * the keys prove provenance.
 */
export const DRAFT_SOURCE_METADATA_KEYS = Object.freeze(
  [
    "sourceDraftId",
    "sourceDraftEpoch",
    "sourceDraftCheckpointId",
    "sourceDraftServerSequence",
    "publishedActorKind",
  ] as const,
);
