import type { Browser } from "@playwright/test";

export const ENTERPRISE_BASELINE_PATH: string;
export type EnterpriseBaseline = Record<string, unknown> & {
  source: Record<string, unknown> & { digest: string; revision: string };
  cases?: Array<Record<string, unknown> & { id: string }>;
};
export function enterpriseLaunchOptions(): {
  env: Record<string, string | undefined>;
};
export function enterpriseRender(baseline: Record<string, unknown>): {
  entryPath: string;
  mountSelector: string;
  readyGlobal: string;
  imageSelector: string;
};
export function enterpriseReferenceUrl(
  baseUrl: string,
  baseline: Record<string, unknown>,
  designCase: { theme: string; design: { screen: string; state: string } },
): string;
export function closeEnterpriseServer(): Promise<void>;
export function renderEnterpriseReference(
  browser: Browser,
  baseline: Record<string, unknown>,
  designCase: Record<string, unknown>,
): Promise<{
  bytes: Buffer;
  height: number;
  chromeHeight: number | null;
  chromeText: string | null;
}>;
export function deviceChromeDrift(
  designCase: { deviceChrome?: { top: number } },
  chromeHeight: number | null | undefined,
  chromeText: string | null | undefined,
): string | null;
export const STATUS_BAR_TIME_TEXT: string;
export function enterpriseSchemaIssues(
  baseline: Record<string, unknown>,
): Promise<string[]>;
export function checkEnterpriseReferences(options: {
  baseline: Record<string, unknown>;
  browser: Browser;
}): Promise<{
  issues: string[];
  results: Array<{ id: string; score?: number; issue?: string }>;
}>;
export function buildEnterpriseCase(
  baseline: Record<string, unknown>,
  manifest: Record<string, unknown>,
  selection: {
    screen: string;
    state: string;
    theme: string;
    device: string;
    route: string;
    session: string;
  },
): Record<string, unknown> & { id: string };
export function renderAndFillEnterpriseCase(
  browser: Browser,
  baseline: Record<string, unknown>,
  designCase: Record<string, unknown>,
): Promise<void>;
export function parseEnterpriseArguments(
  argv: string[],
): { kind: "write" | "check" | "list" | "add"; [key: string]: unknown };
