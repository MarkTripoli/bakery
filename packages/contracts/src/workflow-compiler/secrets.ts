const SECRET_WORDS: ReadonlySet<string> = new Set([
  "secret",
  "secrets",
  "password",
  "passwords",
  "passphrase",
  "credential",
  "credentials",
]);

const SECRET_PAIRS: ReadonlySet<string> = new Set([
  "apikey",
  "apikeys",
  "privatekey",
  "privatekeys",
  "accesstoken",
  "accesstokens",
  "refreshtoken",
  "refreshtokens",
]);

/**
 * True when a field or input name carries a secret word or pair: `secret`,
 * `password`, `passphrase`, `credential` (plural forms too), `apiKey`,
 * `privateKey`, `accessToken` or `refreshToken` (plural forms too). The
 * name is stripped of non-alphanumeric runs, lower-cased and searched for each
 * word or pair as a substring, so `XApiKey`, `api_key`, `DBPASSWORD` and
 * `dbpassword` match. Linear in the name length (no backtracking regex). A false
 * positive only rejects a definition; a miss would leak a secret.
 */
export function isSecretName(name: string): boolean {
  const flat = name.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
  for (const word of SECRET_WORDS) if (flat.includes(word)) return true;
  for (const pair of SECRET_PAIRS) if (flat.includes(pair)) return true;
  return false;
}
