import type { Page } from "@playwright/test";
import type { K0RasterProfile } from "./paper-k0-raster.d.mts";
export const WHOLE_ARTBOARD_VERSION: "paper-k0-whole-artboard-v1";
/** Explicit registration of the complete artwork and its outer qualification. */
export interface WholeArtboardBinding {
  contractVersion: typeof WHOLE_ARTBOARD_VERSION;
  targetSelector: '[data-paper-whole-artboard="worker-detail"]';
  qualificationSelector: ".ui-worker-detail__boundary";
}
export const WHOLE_ARTBOARD_BINDING: Readonly<WholeArtboardBinding>;
/** Measured, revision-bound paired evidence. The consumer verifies receipt and bytes. */
export interface WholeArtboardCaptureV1 {
  contractVersion: typeof WHOLE_ARTBOARD_VERSION;
  caseId: string;
  state: "ready";
  sourceProfile: "K-0";
  sourceDigest: string;
  originalPng: { sha256: string; width: number; height: number };
  candidateDigest: string;
  buildDigest: string;
  themeDigest: string;
  contextDigest: string;
  snapshotGeneration: string;
  adapter: {
    version: "paper-k0-centered-canvas-v1";
    implementationDigest: string;
    x: 0;
    y: 0 | 0.5;
  };
  target: {
    selector: string;
    naturalWidth: number;
    naturalHeight: number;
    completeArtwork: true;
  };
  fullUI: {
    scope: "full-ui";
    path: string;
    sha256: string;
    width: number;
    height: number;
    adapter: "none";
  };
  parity: {
    scope: "whole-artboard-parity";
    path: string;
    sha256: string;
    width: number;
    height: number;
  };
  browserContract: { passed: true; receiptSha256: string };
  qualification: { visible: true; accessible: true; textDigest: string };
}
export function metadataDigest(value: unknown): string;
export function wholeArtboardBindingIssues(
  baseline: Record<string, unknown>,
  binding?: unknown,
): string[];
export function pairedIdentity(
  candidate: Record<string, unknown>,
  baseline: Record<string, unknown>,
): Record<string, unknown>;
export function observeWholeArtboard(
  page: Page,
  binding: WholeArtboardBinding,
): Promise<Record<string, unknown>>;
export function wholeArtboardObservationIssues(
  observed: unknown,
  reference: { width: number; height: number },
): string[];
export function wholeArtboardMetadataIssues(record: unknown): string[];
export function wholeArtboardPairIssues(
  root: string,
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): Promise<string[]>;
export function captureWholeArtboardPair(
  page: Page,
  binding: WholeArtboardBinding,
  profile: K0RasterProfile,
  captureFullUI: () => Promise<Buffer>,
  assertBrowser: () => Promise<void>,
): Promise<
  {
    fullUI: Buffer;
    parity: Buffer;
    observation: Record<string, unknown>;
    snapshotGeneration: string;
    snapshotNonce: string;
  }
>;
