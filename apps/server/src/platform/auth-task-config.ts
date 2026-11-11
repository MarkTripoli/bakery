import type { DatabaseConfig } from "@bakery/config";

export const authEnvironmentNames = [
  "BAKERY_CONTAINER_BASE_URL",
  "BAKERY_ENV",
  "BAKERY_INNGEST_LOCAL_COMPOSE",
  "BAKERY_INNGEST_PRIVATE_HOST_SUFFIX",
  "BAKERY_PUBLIC_BASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "DATABASE_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "INNGEST_SIGNING_KEY",
  "INNGEST_EVENT_KEY",
  "INNGEST_URL",
] as const;

export function readAuthTaskEnvironment(
  env: Record<string, string | undefined>,
  databaseConfig: DatabaseConfig,
): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    authEnvironmentNames.map((name) => [name, env[name]]),
  );
  environment.BAKERY_APP_DATABASE_URL = databaseConfig.url;
  return environment;
}
