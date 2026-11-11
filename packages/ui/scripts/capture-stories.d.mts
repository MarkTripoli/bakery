import type { Page } from "@playwright/test";

export function renderedContainmentIssues(): string[];
export function fullFrameRasterTarget(page: Page): Promise<string>;
export function runtimeAssertions(
  page: Page,
  runtimeCase: Record<string, unknown>,
  context: Record<string, unknown>,
  catalogEntry?: Record<string, unknown>,
): Promise<void>;
export function runtimeGlobalQuery(context: Record<string, unknown>): string;
export function storyUrl(
  baseURL: string,
  runtimeCase: Record<string, unknown>,
  context: Record<string, unknown>,
): string;
export function servedBuildIdentityIssues(
  localFiles: Record<string, string>,
  servedFiles: Record<string, string>,
): string[];
export function includePaperCases(
  runtimeCases: Array<Record<string, unknown>>,
  selectedCases: Array<Record<string, unknown>>,
): Array<Record<string, unknown>>;
export type WebRouteStub = {
  pattern: string;
  method?: string;
  fulfill: {
    status: number;
    contentType?: string;
    headers?: Record<string, string>;
    body: string;
  };
};
export function webRouteStubs(
  session: "anonymous" | "authenticated",
): WebRouteStub[];
export function captureConcurrency(
  env?: Record<string, string | undefined>,
): number;
export function changedPaths(options?: {
  baseRef?: string;
  baseSha?: string;
  git?: (...args: unknown[]) => string;
}): string[];
export function selectCases(
  runtime: { cases: Array<Record<string, unknown>> },
  catalog: { entries: Array<Record<string, unknown>> },
  stories: Array<Record<string, unknown>>,
  args: {
    changed: boolean;
    caseIds: string[];
    only?: string[];
    webBaseUrl?: string | null;
  },
  paths?: string[],
): Array<Record<string, unknown>>;
export function sourceIdentity(
  sourceCommit: string,
  sourceDiff: string,
  untrackedSource?: string,
): {
  sourceCommit: string;
  sourceDirty: boolean;
  sourceDiffDigest: string | null;
};
export function captureDesignCase(
  browser: import("@playwright/test").Browser | null,
  webBaseUrl: string,
  designCase: Record<string, unknown>,
  metadata: Record<string, unknown>,
  contextPool?: {
    acquire(
      designCase: Record<string, unknown>,
    ): Promise<import("@playwright/test").BrowserContext>;
  },
): Promise<Record<string, unknown>>;

export function designCaptureMetadata(
  baseline: Record<string, unknown>,
  designCase: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>>;
/** Full UI remains the primary output; parity is an additional explicit scope. */
export interface PairedStoryCapture {
  outputPath: string;
  outputSha256: string;
  outputScope: "full-ui";
  outputAdapter: "none";
  rasterProfile: import("./paper-k0-raster.mjs").K0RasterProfile;
  wholeArtboardCaptureSha256: string;
  wholeArtboardCapture:
    import("./paper-whole-artboard.mjs").WholeArtboardCaptureV1;
}

export function coarseTargetCheck(
  root: Element,
): { visibleCount: number; undersized: string[] };
export function detailInertnessIssues(root: Element): string[];
