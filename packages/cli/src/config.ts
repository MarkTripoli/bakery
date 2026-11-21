import { readFile } from "node:fs/promises";

/** What the command line needs to reach one organization's Bakery as one person. */
export type CliConfig = Readonly<{
  /** The server's address, for example `https://bakery.example.com`. */
  baseUrl: string;
  /** An access token (`bky_…`); sent as a bearer value, never printed or put in a URL. */
  token: string;
  /** The organization every request is made in. */
  organizationId: string;
}>;

/** A command line the tool cannot act on: a missing setting, an unknown command or a bad flag. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Environment variables the tool reads; there is deliberately no `--token` flag, so a token never lands in shell history. */
export const ENVIRONMENT = Object.freeze({
  url: "BAKERY_URL",
  token: "BAKERY_TOKEN",
  tokenFile: "BAKERY_TOKEN_FILE",
  organization: "BAKERY_ORGANIZATION",
});

export type ConfigSources = Readonly<{
  environment: (name: string) => string | undefined;
  /** `--url` and `--organization`, which take the place of the variables. */
  flags: Readonly<{ url?: string; organization?: string }>;
  readFileText?: (path: string) => Promise<string>;
}>;

/** Reads the settings from flags and the environment, or says which one is missing. */
export async function readConfig(sources: ConfigSources): Promise<CliConfig> {
  const baseUrl = sources.flags.url ?? sources.environment(ENVIRONMENT.url);
  if (baseUrl === undefined || baseUrl.trim() === "") {
    throw new UsageError(
      `Set ${ENVIRONMENT.url} (or pass --url) to your Bakery server's address.`,
    );
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("scheme");
    }
  } catch {
    throw new UsageError(`${ENVIRONMENT.url} is not a web address: ${baseUrl}`);
  }
  const organizationId = sources.flags.organization ??
    sources.environment(ENVIRONMENT.organization);
  if (organizationId === undefined || organizationId.trim() === "") {
    throw new UsageError(
      `Set ${ENVIRONMENT.organization} (or pass --organization) to the organization's id.`,
    );
  }
  let token = sources.environment(ENVIRONMENT.token)?.trim();
  const tokenFile = sources.environment(ENVIRONMENT.tokenFile);
  if ((token === undefined || token === "") && tokenFile !== undefined) {
    const read = sources.readFileText ??
      ((path: string) => readFile(path, "utf8"));
    token = (await read(tokenFile).catch(() => {
      throw new UsageError(
        `Cannot read ${ENVIRONMENT.tokenFile}: ${tokenFile}`,
      );
    })).trim();
  }
  if (token === undefined || token === "") {
    throw new UsageError(
      `Set ${ENVIRONMENT.token} (or ${ENVIRONMENT.tokenFile}) to an access token from Settings.`,
    );
  }
  return {
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    token,
    organizationId: organizationId.trim(),
  };
}
