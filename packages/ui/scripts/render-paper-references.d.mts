import type { Browser } from "@playwright/test";

export type PaperSourceProfileId = "K-0";
export interface PaperSourceProfile {
  source: {
    fileId: "01M1X504XVC45FC0VDK857A37D";
    pageId: "K-0";
    manifestPath: "docs/technical-design/worker-readiness/paper-manifest.json";
    inputs: readonly string[];
    revision: string;
    digest: string;
  };
  raster: {
    version: "paper-k0-centered-canvas-v1";
    helperVersion: "paper-k0-export-reconciliation-v1";
    implementationDigest: string;
  };
  render: {
    entryPath: "worker-readiness/index.html";
    mountSelector: "#app";
    readyGlobal: "bakeryWorkerReadinessReady";
    imageSelector: "#app img";
  };
}
export interface DesignCase {
  sourceProfile?: PaperSourceProfileId;
}
export function resolveSourceProfile(
  baseline: Record<string, unknown>,
  designCase?: DesignCase,
): {
  source: Record<string, unknown>;
  render: Record<string, string>;
  raster?: PaperSourceProfile["raster"];
};
export function designReferenceUrl(
  baseUrl: string,
  baseline: Record<string, unknown>,
  designCase: Record<string, unknown>,
): string;
export function readDesignManifest(
  baseline?: Record<string, unknown>,
  designCase?: DesignCase,
): Promise<{
  fileId: string;
  pageId: string;
  screens: Array<Record<string, unknown>>;
}>;
export function lookupArtboard(
  manifest: { screens: Array<Record<string, unknown>> },
  criteria: { screen: string; state: string; theme: string; device: string },
  baseline?: Record<string, unknown>,
  designCase?: DesignCase,
): { nodeId: string; width: number; height: number };
export function renderDesignReference(
  browser: Browser,
  baseline: Record<string, unknown>,
  designCase: Record<string, unknown>,
): Promise<{
  bytes: Buffer;
  rasterContract?: Record<string, unknown>;
  playwrightVersion?: string;
  rasterProfile?: import("./paper-k0-raster.mjs").K0RasterProfile;
  browserLaunchOptions?: import("@playwright/test").LaunchOptions;
  browserVersion?: string;
  os?: string;
  height: number;
  measured: { x: number; y: number; width: number; height: number } | null;
}>;
export function fontDigests(
  baseline?: Record<string, unknown>,
  designCase?: DesignCase,
): Promise<Record<string, string>>;
export function closeServer(): Promise<void>;
export function computeSourceIdentity(
  baseline: Record<string, unknown>,
  designCase?: DesignCase,
): Promise<{ digest: string; revision: string }>;
export function checkDesignReferences(
  options: { baseline: Record<string, unknown>; browser: Browser },
): Promise<{
  issues: string[];
  results: Array<
    | { id: string; score: number; contentCoverage: number }
    | { id: string; issue: string }
  >;
}>;
/** Verified original-PNG profile; rejects stale source and helper identity. */
export function loadK0RasterProfile(
  baseline: Record<string, unknown>,
  designCase: Record<string, unknown>,
): Promise<import("./paper-k0-raster.mjs").K0RasterProfile>;
