import { contractSchemas } from "@bakery/contracts/contracts";
import { type ExecutionRouteOptions, sha256Hex } from "./shared.ts";

/**
 * Short codes for the one-paste machine link (#70): the link code an Admin's
 * command carries and the user code a terminal prints for an Admin to approve.
 *
 * Eight characters from an alphabet with no 0/O, 1/I or L, shown as XXXX-XXXX.
 * Input ignores case, spaces and the dash. 31 symbols over eight places is
 * about 39.6 bits; a code also expires in ten minutes, works once, and every
 * route that takes one is rate-limited per source and per code, so guessing
 * hits RATE_LIMITED long before it can cover a useful part of the space.
 */
export const SHORT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const SHORT_CODE_LENGTH = 8;
/** The largest multiple of the alphabet size below 256: bytes past it are redrawn, so every symbol is equally likely. */
const UNBIASED_LIMIT = 256 - (256 % SHORT_CODE_ALPHABET.length);
const SHORT_CODE = new RegExp(
  `^[${SHORT_CODE_ALPHABET}]{${SHORT_CODE_LENGTH}}$`,
);

/** A fresh XXXX-XXXX code from the platform's cryptographic random source. */
export function mintShortCode(): string {
  const symbols: string[] = [];
  while (symbols.length < SHORT_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte >= UNBIASED_LIMIT || symbols.length >= SHORT_CODE_LENGTH) {
        continue;
      }
      symbols.push(SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]!);
    }
  }
  return `${symbols.slice(0, 4).join("")}-${symbols.slice(4).join("")}`;
}

/** The canonical XXXX-XXXX form of what a person typed, or null when it cannot be a code. */
export function normalizeShortCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]+/g, "");
  if (!SHORT_CODE.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/** Hashes are namespaced so a link code, a user code and a device secret can never stand in for one another. */
export async function linkCodeHash(code: string): Promise<string> {
  return await sha256Hex(`worker-link-code:${code}`);
}
export async function userCodeHash(code: string): Promise<string> {
  return await sha256Hex(`worker-link-user-code:${code}`);
}
export async function deviceSecretHash(secret: string): Promise<string> {
  return await sha256Hex(`worker-link-device:${secret}`);
}

/**
 * The systems the installer is proven on: the same list as the web's systems
 * table (#864, `apps/web/src/pages/machine-systems.ts`), whose only
 * supported row is Linux on arm64 (`scripts/deploy/bootstrap-host.sh`).
 * Architectures are in the server's stored form (see `normalizeArchitecture`).
 */
export const SUPPORTED_WORKER_SYSTEMS: readonly Readonly<{
  os: "linux" | "macos";
  architecture: string;
}>[] = [{ os: "linux", architecture: "arm64" }];

/** The stored system name for what a machine reports (`process.platform` or a person's word), or null for one Bakery has no name for. */
export function reportedOs(value: string): "linux" | "macos" | null {
  const word = value.trim().toLowerCase();
  if (word === "linux") return "linux";
  if (word === "macos" || word === "darwin" || word === "mac") return "macos";
  return null;
}

export function isSupportedSystem(
  os: string | null,
  architecture: string,
): boolean {
  return SUPPORTED_WORKER_SYSTEMS.some((system) =>
    system.os === os && system.architecture === architecture
  );
}

/** A host name as a machine reports it: letters, digits, dots, dashes and underscores. */
export function isHostname(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}

/**
 * The one line an Admin pastes on the machine. Until the npm scope has an
 * owner (#70), the command names the package the owner chose; the server
 * origin and the code are the only parts that change.
 */
export function linkCommand(publicBaseUrl: string, linkCode: string): string {
  const origin = new URL(publicBaseUrl).origin;
  return `npx @bakery/worker link --server ${origin} --code ${linkCode}`;
}

/**
 * The enrollment answer with the one-line command built from its link code
 * (#70). The command is derived here, never stored: replays rebuild it.
 */
export function withLinkCommand(
  options: Pick<ExecutionRouteOptions, "publicBaseUrl">,
  response: Record<string, unknown>,
) {
  const linkCode = typeof response.linkCode === "string"
    ? response.linkCode
    : "";
  return contractSchemas.WorkerEnrollment.parse({
    ...response,
    command: linkCommand(options.publicBaseUrl, linkCode),
  });
}
