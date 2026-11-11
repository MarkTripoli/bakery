export function isRouteSharedInput(path: string): boolean;
export function isGlobalChange(
  paths: string[],
  options?: { routesOnly?: boolean },
): boolean;
export function routeOwnedPaths(
  entry: { routeId: string; path?: string },
  paths: string[],
): string[];
export function selectDesignCases(options: {
  designCases: Array<Record<string, unknown> & { id: string }>;
  manifestName?: string;
  paths: string[];
  baseManifest: { cases?: Array<Record<string, unknown>> } | null;
  manifest?: Record<string, unknown>;
  ledger: { entries?: Array<Record<string, unknown>> } | null;
  manifestRepoPath: string;
}): Array<Record<string, unknown> & { id: string }>;
export function baseManifestAt(options: {
  repoPath: string;
  baseSha?: string;
  baseRef?: string;
  git?: (...args: unknown[]) => string;
}): Record<string, unknown> | null;
export function parseCaptureArguments(argv: string[]): {
  changed: boolean;
  only: string[];
  webBaseUrl: string | null;
};
export function captureEnterpriseCases(options?: {
  args?: ReturnType<typeof parseCaptureArguments>;
  manifestName?: string;
}): Promise<Array<Record<string, unknown>>>;
export function captureCaseFor<
  T extends {
    viewport: { width: number; height: number };
    deviceChrome?: { top: number } | null;
  },
>(designCase: T): T;
