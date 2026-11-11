import {
  harnessAvailable,
  harnessExecutablePath,
  harnessProcessesAlive,
} from "./harness.ts";
export {
  CapturingOutputSink,
  gitText,
  harnessAvailable,
  harnessExecutablePath,
  harnessProcessesAlive,
  prepareScratchRepository,
  type ScratchRepository,
} from "./harness.ts";

/** Existing Codex test names remain available while the corpus goes generic. */
export function codexExecutablePath(): string {
  return harnessExecutablePath("codex");
}

export function codexProcessesAlive(): Promise<string[]> {
  return harnessProcessesAlive(codexExecutablePath(), "exec");
}

export function codexHarnessAvailable(): Promise<string | true> {
  return harnessAvailable("codex", codexExecutablePath());
}

/**
 * The operator's own Codex login directory, for the real-CLI cases only:
 * `BAKERY_CODEX_AUTH_SOURCE_DIR`, then `CODEX_HOME`, then `$HOME/.codex`,
 * the same order the worker config uses.
 */
export function operatorCodexAuthSource(): string {
  const configured = Deno.env.get("BAKERY_CODEX_AUTH_SOURCE_DIR")?.trim() ||
    Deno.env.get("CODEX_HOME")?.trim();
  if (configured) return configured;
  const home = Deno.env.get("HOME")?.trim();
  if (!home) throw new Error("HOME_REQUIRED_FOR_REAL_CODEX_CASES");
  return `${home}/.codex`;
}
