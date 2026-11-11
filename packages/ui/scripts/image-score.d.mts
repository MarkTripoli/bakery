export interface ScorePixelsInput {
  candidate: Uint8ClampedArray;
  baseline: Uint8ClampedArray;
  width: number;
  height: number;
  region?: { x: number; y: number; width: number; height: number } | null;
}

export interface ScorePixelsResult {
  score: number;
  inkScore: number;
  surfaceScore: number;
  inkCoverage: number;
  surfaceCoverage: number;
  mismatched: { ink: number; surface: number };
  diff: Uint8ClampedArray;
}

export interface ScorePixelsIssue {
  issue: string;
}

export function scorePixels(
  args: ScorePixelsInput,
): ScorePixelsResult | ScorePixelsIssue;

export function pngDimensions(
  bytes: Uint8Array,
): { width: number; height: number };

export interface ComparePngsInput {
  candidate: Uint8Array;
  baseline: Uint8Array;
  candidateCrop?:
    | { x: number; y: number; width: number; height: number }
    | null;
  baselineCrop?: { x: number; y: number; width: number; height: number } | null;
  region?: { x: number; y: number; width: number; height: number } | null;
  diff?: boolean;
}

export type ComparePngsResult =
  & { frame: { width: number; height: number } }
  & (
    | (Omit<ScorePixelsResult, "diff"> & { diffDataURL?: string })
    | ScorePixelsIssue
  );

export function comparePngs(
  page: unknown,
  input: ComparePngsInput,
): Promise<ComparePngsResult>;
