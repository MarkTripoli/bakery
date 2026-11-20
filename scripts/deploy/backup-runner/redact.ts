/**
 * Nothing the runner prints or reports may contain the runner credential, a
 * lease token or the off-site key pair. Every string that leaves the process
 * (a log line, a failure detail sent to the server) goes through `redact`.
 */

export type Secrets = { readonly values: Set<string> };

export function createSecrets(
  initial: readonly (string | null | undefined)[] = [],
): Secrets {
  const secrets: Secrets = { values: new Set() };
  for (const value of initial) addSecret(secrets, value);
  return secrets;
}

/** Remembers a value to scrub. Very short values are ignored: they would shred ordinary text. */
export function addSecret(
  secrets: Secrets,
  value: string | null | undefined,
): void {
  if (typeof value === "string" && value.length >= 8) secrets.values.add(value);
}

const DETAIL_MAX = 1000;

/** Replaces every known secret, strips control characters and bounds the length. */
export function redact(
  text: string,
  secrets: Secrets,
  max = DETAIL_MAX,
): string {
  let value = text;
  // Longest first, so a secret that contains another is removed whole.
  for (
    const secret of [...secrets.values].sort((a, b) => b.length - a.length)
  ) {
    value = value.split(secret).join("[redacted]");
  }
  // A bearer header or a base64 blob that slipped into an error message.
  value = value.replace(
    /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    "Bearer [redacted]",
  );
  value = Array.from(value).filter((c) => {
    const code = c.charCodeAt(0);
    return code === 10 || (code >= 32 && code !== 127);
  }).join("").trim();
  return value.slice(0, max);
}
