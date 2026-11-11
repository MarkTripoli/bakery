/** Media types `artifactVersions.extract` can return as bounded UTF-8 text. */
const EXTRACTABLE_MEDIA_TYPES: Record<string, true> = {
  "application/json": true,
  "application/xml": true,
  "text/csv": true,
  "text/markdown": true,
  "text/plain": true,
  "text/xml": true,
};

export function isExtractableMediaType(mediaType: string): boolean {
  const baseType = mediaType.split(";", 1)[0].trim().toLowerCase();
  return Object.hasOwn(EXTRACTABLE_MEDIA_TYPES, baseType);
}

/** Largest text body the page renders inline (1 MiB), per 14-artifacts.md. */
export const MAX_TEXT_PREVIEW_BYTES = 1_048_576;
/** Largest image body the page renders inline (10 MiB, the version maximum). */
export const MAX_IMAGE_PREVIEW_BYTES = 10_485_760;

/** Media the isolated preview origin renders: markup, images and plain text. */
const PREVIEWABLE_MEDIA_TYPES: Record<string, true> = {
  "application/json": true,
  "application/xml": true,
  "image/avif": true,
  "image/bmp": true,
  "image/gif": true,
  "image/jpeg": true,
  "image/png": true,
  "image/svg+xml": true,
  "image/webp": true,
  "text/csv": true,
  "text/html": true,
  "text/markdown": true,
  "text/plain": true,
  "text/xml": true,
};

export function isPreviewableMediaType(mediaType: string): boolean {
  const baseType = mediaType.split(";", 1)[0].trim().toLowerCase();
  return Object.hasOwn(PREVIEWABLE_MEDIA_TYPES, baseType);
}
