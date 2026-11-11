import type { Browser, LaunchOptions } from "@playwright/test";
export function paperBrowserLaunchOptions(
  designCase?: { sourceProfile?: string },
): LaunchOptions;
export function withPaperBrowser<T>(
  browser: Browser,
  designCase: { sourceProfile?: string },
  capture: (browser: Browser) => Promise<T>,
  launch?: (options: LaunchOptions) => Promise<Browser>,
): Promise<T>;
export const K0_ADAPTER_VERSION: "paper-k0-centered-canvas-v1";
export function assertK0Environment(record: Record<string, unknown>): void;

/** Shared canonical browser-context identity for raster parity. */
export function paperRasterContext(
  record: Record<string, unknown>,
): Record<string, unknown>;
