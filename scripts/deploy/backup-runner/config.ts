/**
 * The runner's address and credential, from its environment file
 * (`/etc/bakery/backup-runner.env`). Shared by the runner and the restore
 * drill, which reports with the same credential.
 */
export function readRunnerConfig(
  env: Readonly<Record<string, string | undefined>>,
): { baseUrl: string; token: string } | string {
  const baseUrl = env.BAKERY_API_URL ?? "";
  const token = env.BAKERY_BACKUP_RUNNER_TOKEN ?? "";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "BAKERY_API_URL must be the Bakery API address";
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") || url.username ||
    url.password || url.search || url.hash
  ) return "BAKERY_API_URL must be an http(s) address without credentials";
  if (token.length < 32) {
    return "BAKERY_BACKUP_RUNNER_TOKEN is missing or too short";
  }
  return { baseUrl: url.origin + url.pathname.replace(/\/+$/, ""), token };
}
