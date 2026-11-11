import type { Page } from "@playwright/test";
export const K0_RASTER_VERSION: "paper-k0-export-reconciliation-v1";
export interface K0RasterProfile {
  readonly version: typeof K0_RASTER_VERSION;
  readonly sourceIdentity: string;
  readonly reference: Readonly<
    { sha256: string; width: number; height: number }
  >;
  readonly offset: Readonly<{ x: 0; y: number }>;
  readonly implementationDigest: string;
}
export function deriveK0RasterProfile(
  originalReferencePng: Uint8Array,
  expected: {
    sha256: string;
    width: number;
    height: number;
    sourceIdentity: string;
  },
): K0RasterProfile;
export function verifyK0RasterProfile(
  originalReferencePng: Uint8Array,
  metadata: K0RasterProfile,
): K0RasterProfile;
/** Odd-height captures require a page from an explicit BrowserContext.
 * Uses a same-context empty background control; restores target and body styles.
 */
export function captureK0Raster(
  page: Page,
  targetSelector: string,
  profile: K0RasterProfile,
): Promise<Buffer>;
