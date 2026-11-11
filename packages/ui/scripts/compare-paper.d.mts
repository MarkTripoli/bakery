export function storyCandidateIssues(
  baseline: Record<string, unknown>,
  candidate?: Record<string, unknown>,
  read?: (path: string) => { toString(encoding?: string): string },
): string[];
export function compatibilityIssues(
  candidate: Record<string, unknown>,
  baseline: Record<string, unknown>,
): string[];
export function designCompatibilityIssues(
  candidate: Record<string, unknown>,
  baseline: Record<string, unknown>,
): string[];
export function parseArguments(argv: string[]): {
  candidatePath?: string;
  cycle: number;
  maxCycles: 3 | 4 | 5 | 6;
  startedAt?: string;
  only: string[];
  manifestName: string;
};
export function isSiteStoryCase(baseline: Record<string, unknown>): boolean;
export function siteStoryCandidateIssues(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): Promise<string[]>;
export function baselineMetadataIssues(
  manifest: Record<string, unknown>,
  read?: (path: string) => { toString(encoding?: string): string },
  options?: { siteStories?: boolean },
): string[];
export function sourceRefreshed(
  manifest: Record<string, unknown>,
  baseManifest: Record<string, unknown>,
): boolean;
export function baselineMutationIssues(
  manifest: Record<string, unknown>,
  baseManifest: Record<string, unknown>,
): string[];
export function predecessorManifest(
  baseManifest: Record<string, unknown> | null,
  firstBranchManifest: Record<string, unknown> | null,
): Record<string, unknown> | null;
export function baselineProvenance(
  manifest: Record<string, unknown>,
  predecessor: Record<string, unknown> | null,
): { status: string; issues?: string[]; notes?: string[] };
export function repositoryBaselineProvenance(options?: {
  repositoryRoot?: string;
  comparisonRef?: string;
}): {
  status: string;
  baseCommit?: string;
  profiles?: Record<string, string>;
  issues?: string[];
  notes?: string[];
};
export function validateCycle(
  cycle: number,
  options?: { maxCycles?: number; manifestName?: string },
): void;
export function sourceDigestIssues(
  manifest: Record<string, unknown>,
): Promise<string[]>;
export function designReferenceInputs(
  baseline: Record<string, unknown>,
  manifestName?: string,
): Set<string>;
export function paperRasterDiagnostics(
  results: Record<string, unknown>[],
  run?: (...args: unknown[]) => Record<string, unknown>,
): Record<string, unknown>;
export function finalizePaperComparison(
  report: Record<string, unknown>,
  baseline: Record<string, unknown>,
  candidates: Map<string, unknown>,
  collectDiagnostics?: () => Record<string, unknown>,
  options?: {
    manifestName?: string;
    planned?: Map<string, unknown>;
    debt?: Map<string, unknown>;
  },
): void;
export function referenceRenderProvedAt(
  baseline: Record<string, unknown>,
  baseSha?: string,
  git?: (...args: unknown[]) => string,
  manifestName?: string,
): string | null;
export function baselineInputIssues(
  baseline: Record<string, unknown>,
  candidate?: Record<string, unknown>,
  options?: { siteStories?: boolean },
): Promise<string[]>;
export function comparisonStatus(score: number, threshold?: number): string;
export function comparePixels(
  page: unknown,
  candidateBytes: { toString(encoding?: string): string },
  baselineBytes: { toString(encoding?: string): string },
  comparisonRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
    candidateOrigin?: "main";
    measure?: string;
  },
  contentBox?: { x: number; y: number; width: number; height: number } | null,
  deviceChrome?: { top: number } | null,
): Promise<Record<string, unknown> & { score?: number; issue?: string }>;
export function caseResultForPixels(
  baselineCase: Record<string, unknown>,
  pixels: Record<string, unknown>,
  threshold: number,
): {
  status: string;
  score?: number;
  inkScore?: number;
  surfaceScore?: number;
  inkCoverage?: number;
  surfaceCoverage?: number;
  issue?: string;
  issues?: string[];
};
export function excludedResult(
  entry: { screen: string; state: string; reason: string },
): {
  baselineId: string;
  status: "excluded";
  reason: string;
  description: {
    expected: string;
    observed: string;
    inputs: Record<string, unknown>;
  };
};
export function plannedResult(
  baselineCase: Record<string, unknown> & { id: string },
  entry: { routeId: string; path: string; rationale?: string },
  candidateCase?: Record<string, unknown> | null,
): {
  baselineId: string;
  status: "planned";
  reason: string;
  route: string;
  description: {
    expected: string;
    observed: string;
    inputs: Record<string, unknown>;
  };
};
export function debtResult(
  baselineCase: Record<string, unknown> & { id: string },
  entry: { routeId: string; path: string; rationale?: string },
  candidateCase?: Record<string, unknown> | null,
): {
  baselineId: string;
  status: "debt";
  reason: string;
  route: string;
  description: {
    expected: string;
    observed: string;
    inputs: Record<string, unknown>;
  };
};
export function isNotSelected(
  baselineCase: { id: string; reference?: string },
  selectedDesign: Set<string> | null,
  baselined: Set<string>,
  captured: boolean,
): boolean;
export function notSelectedResult(
  baselineCase: Record<string, unknown> & { id: string },
): { baselineId: string; status: "not-selected"; reason: string };
export const accepted: (
  result: { status: string },
  manifestName?: string,
) => boolean;
export function comparePaper(
  options?: {
    candidatePath?: string;
    cycle?: number;
    maxCycles?: number;
    startedAt?: string;
    only?: string[];
    manifestName?: string;
  },
): Promise<Record<string, unknown> & { status: string }>;
/** Paired evidence is validated before selecting its complete parity image. */
export type WholeArtboardCaptureV1 =
  import("./paper-whole-artboard.mjs").WholeArtboardCaptureV1;
export function deviceChromeCrops(
  deviceChrome: { top: number },
  baseline: { width: number; height: number },
  candidate: { width: number; height: number },
):
  | { issue: string; sizeMismatch?: true }
  | {
    baselineCrop: { x: number; y: number; width: number; height: number };
    candidateCrop: { x: number; y: number; width: number; height: number };
    issue?: undefined;
    sizeMismatch?: undefined;
  };
export function deviceChromeIssues(
  baseline: { cases?: Array<Record<string, unknown> & { id: string }> },
  manifestName?: string,
): string[];
