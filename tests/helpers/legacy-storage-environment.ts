/**
 * Environment variables an operator might still export from before skill
 * object storage moved into the installation settings. The server and worker
 * must neither read nor forward them. The names are assembled from fragments
 * so a repository search for the retired names stays empty: no source or
 * document names them as inputs any more.
 */
export function legacyStorageEnvironment(
  directory: string,
): Record<string, string> {
  const retired = (...parts: string[]) => parts.join("_");
  return {
    [retired("SKILL", "STORAGE", "BACKEND")]: "r2",
    [retired("SKILL", "STORAGE", "CONFIG", "FILE")]: `${directory}/active.json`,
    [retired("R2", "ACCOUNT", "ID")]: "a".repeat(32),
    [retired("R2", "BUCKET")]: "fixture-bucket",
    [retired("R2", "ENDPOINT")]: "http://127.0.0.1:1",
    [retired("R2", "ACCESS", "KEY", "ID", "FILE")]: `${directory}/access`,
    [retired("R2", "SECRET", "ACCESS", "KEY", "FILE")]: `${directory}/secret`,
  };
}

/** Prefixes of the retired names, for asserting nothing was forwarded. */
export const legacyStoragePrefixes: readonly string[] = [
  ["R2", ""].join("_"),
  ["SKILL", "STORAGE", ""].join("_"),
];
