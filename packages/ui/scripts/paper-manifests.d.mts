export type PaperManifestName =
  | "auth"
  | "enterprise"
  | "settings"
  | "entitlements"
  | "artifacts";
export type LedgerEntry = {
  routeId: string;
  path: string;
  status: string;
  rationale?: string;
  manifest?: string;
  cases?: string[];
  frames?: Array<{ frameId: string }>;
};
export const LEDGER_PATH: string;
export const MANIFEST_NAMES: string[];
export function manifestProfile(name?: string): {
  name: string;
  baselineRepoPath: string;
  baselinePath: string;
  artifactSubdirectory: string;
  siteRendered: boolean;
  defersScoring: boolean;
};
export function isSiteManifest(name?: string): boolean;
export function defersScoring(name?: string): boolean;
export function artifactsDirectoryFor(
  artifactsDirectory: string,
  name?: string,
): string;
export function readRouteLedger(): Promise<{ entries: LedgerEntry[] }>;
export function plannedCases(
  ledger: { entries?: LedgerEntry[] } | null | undefined,
  manifestName?: string,
): Map<string, LedgerEntry>;
export function baselinedCases(
  ledger: { entries?: LedgerEntry[] } | null | undefined,
  manifestName?: string,
): Set<string>;
export function debtCases(
  ledger: { entries?: LedgerEntry[] } | null | undefined,
  manifest:
    | {
      cases?: Array<{ id: string; frameId?: string; reference?: string }>;
    }
    | null
    | undefined,
  manifestName?: string,
): Map<string, LedgerEntry>;
export function captureViewport<
  T extends {
    viewport?: { width: number; height: number };
    deviceChrome?: { top: number } | null;
  },
>(designCase: T): { width: number; height: number } | undefined;
