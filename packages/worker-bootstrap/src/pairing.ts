import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BootstrapError } from "./errors.ts";
import { checkRoot } from "./install.ts";

/**
 * Pairing an installation with a Bakery organization (#18, slice 2).
 *
 * The setup code is a one-time credential. It comes from hidden input or a
 * protected descriptor, never a flag or the environment. It is shown to the
 * server over TLS only to inspect it; the installation then records which
 * organization it is paired with and keeps the code in a file only its owner
 * can read, for the worker to consume when it registers. An installation is
 * bound to one organization: a rerun with the same setup is a no-op, and
 * another organization or another setup is refused, so a rerun cannot create a
 * second machine or quietly move the first.
 */

/** What the server tells the terminal about a setup code before it is used. */
export type EnrollmentPreview = Readonly<{
  enrollmentId: string;
  organizationName: string;
  name: string;
  os: string;
  architecture: string;
  slots: number;
  capabilities: readonly string[];
  expiresAt: string;
  state: "pending" | "canceled" | "expired";
}>;

/** The record, in the install root, of the organization it is paired with. */
export type PairingBinding = Readonly<{
  version: 1;
  serverOrigin: string;
  /** The organization's display name: the inspection reveals no other identity. */
  organizationName: string;
  enrollmentId: string;
  name: string;
  boundAt: string;
}>;

export const PAIRING_FILE = "pairing.json";
export const TOKEN_FILE = "enrollment-token";

const MAX_TOKEN_BYTES = 512;
const MAX_RESPONSE_BYTES = 16 * 1024;
const INSPECTION_PATH = "/v1/worker/enrollment-inspection";
const INSPECTION_TIMEOUT_MS = 15_000;

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "[::1]";
}

/**
 * The server's origin, or a refusal. https always; plain http only for this
 * machine. No login, path, query or fragment: the address is an origin, so no
 * other part of a pasted URL can steer where the code goes.
 */
export function normalizeServerOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BootstrapError("PAIRING_SERVER_INVALID");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BootstrapError("PAIRING_SERVER_INVALID");
  }
  if (
    url.username !== "" || url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") || url.search !== "" ||
    url.hash !== "" || url.hostname === ""
  ) throw new BootstrapError("PAIRING_SERVER_INVALID");
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new BootstrapError("PAIRING_SERVER_INSECURE");
  }
  return url.origin;
}

function checkedToken(raw: string): string {
  const token = raw.trim();
  // One line, printable, no spaces: a pasted code, not a sentence or a file.
  if (!/^[\x21-\x7e]{1,500}$/.test(token)) {
    throw new BootstrapError("PAIRING_TOKEN_INVALID");
  }
  return token;
}

/**
 * Reads the setup code from a protected file: a regular file (not a link) that
 * only its owner can read, holding one short line. Mirrors what the worker
 * itself accepts, so what setup takes the worker takes.
 */
export async function readProtectedToken(path: string): Promise<string> {
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new BootstrapError("PAIRING_TOKEN_UNREADABLE");
    if ((info.mode & 0o077) !== 0) {
      throw new BootstrapError("PAIRING_TOKEN_UNPROTECTED");
    }
    if (info.size > MAX_TOKEN_BYTES) {
      throw new BootstrapError("PAIRING_TOKEN_INVALID");
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("PAIRING_TOKEN_UNREADABLE", { cause: error });
  }
  return checkedToken(text);
}

/**
 * Reads one line from a terminal without echoing it. Refuses anything that is
 * not a terminal: a pipe cannot hide input, and a code typed into a pipe is
 * the shortcut this exists to rule out. Backspace edits; Ctrl-C and Ctrl-D end
 * the read without a code.
 */
export type HiddenInputStream = Readonly<{
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  setEncoding: (encoding: "utf8") => unknown;
  on: (event: "data", listener: (chunk: string) => void) => unknown;
  off: (event: "data", listener: (chunk: string) => void) => unknown;
}>;

export async function readHiddenToken(
  input: HiddenInputStream,
  prompt: (text: string) => void,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new BootstrapError("PAIRING_TOKEN_UNREADABLE");
  }
  prompt("Setup code (not shown): ");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  try {
    const text = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n") {
            input.off("data", onData);
            return resolve(buffer);
          }
          if (character === "\u0003" || character === "\u0004") {
            input.off("data", onData);
            return reject(new BootstrapError("PAIRING_TOKEN_UNREADABLE"));
          }
          if (character === "\u007f" || character === "\b") {
            buffer = buffer.slice(0, -1);
          } else if (buffer.length <= MAX_TOKEN_BYTES) buffer += character;
        }
      };
      input.on("data", onData);
    });
    return checkedToken(text);
  } finally {
    input.setRawMode(false);
    input.pause();
    prompt("\n");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The inspection answer, strictly: the shape is checked before anything is shown or kept. */
function parsePreview(value: unknown): EnrollmentPreview {
  if (!isRecord(value)) {
    throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
  }
  const text = (key: string, max: number): string => {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0 || field.length > max) {
      throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
    }
    return field;
  };
  const slots = value.slots;
  const capabilities = value.capabilities;
  const state = value.state;
  if (
    typeof slots !== "number" || !Number.isInteger(slots) || slots < 1 ||
    slots > 100 || !Array.isArray(capabilities) ||
    capabilities.length > 100 ||
    !capabilities.every((item) =>
      typeof item === "string" && item.length > 0 && item.length <= 100
    ) || (state !== "pending" && state !== "canceled" && state !== "expired")
  ) throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
  const enrollmentId = text("enrollmentId", 64);
  if (!/^[0-9a-f-]{36}$/i.test(enrollmentId)) {
    throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
  }
  return {
    enrollmentId,
    organizationName: text("organizationName", 200),
    name: text("name", 200),
    os: text("os", 20),
    architecture: text("architecture", 100),
    slots,
    capabilities: capabilities as string[],
    expiresAt: text("expiresAt", 40),
    state,
  };
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new BootstrapError("PAIRING_INSPECTION_MALFORMED");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Asks the server what a setup code is for, without using it. The code goes in
 * the body of one POST to the one fixed path; redirects are refused so it can
 * go nowhere else; the answer is size-bounded and strictly shaped. Nothing
 * the server says is echoed in an error.
 */
export async function inspectEnrollment(options: {
  origin: string;
  token: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
}): Promise<EnrollmentPreview> {
  let response: Response;
  try {
    response = await options.fetch(`${options.origin}${INSPECTION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ enrollmentToken: options.token }),
      redirect: "error",
      signal: options.signal ?? AbortSignal.timeout(INSPECTION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BootstrapError("PAIRING_INSPECTION_FAILED", { cause: error });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new BootstrapError("PAIRING_INSPECTION_FAILED");
  }
  let body: unknown;
  try {
    body = JSON.parse(await boundedText(response));
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("PAIRING_INSPECTION_MALFORMED", { cause: error });
  }
  return parsePreview(body);
}

async function readBinding(root: string): Promise<PairingBinding | null> {
  let text: string;
  try {
    const info = await lstat(join(root, PAIRING_FILE));
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new BootstrapError("PAIRING_BINDING_CORRUPT");
    }
    text = await readFile(join(root, PAIRING_FILE), "utf8");
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw new BootstrapError("PAIRING_BINDING_CORRUPT", { cause: error });
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (
      !isRecord(value) || value.version !== 1 ||
      typeof value.serverOrigin !== "string" ||
      typeof value.organizationName !== "string" ||
      typeof value.enrollmentId !== "string" ||
      typeof value.name !== "string" || typeof value.boundAt !== "string"
    ) throw new Error("shape");
    return value as unknown as PairingBinding;
  } catch (error) {
    throw new BootstrapError("PAIRING_BINDING_CORRUPT", { cause: error });
  }
}

/** Writes a file only its owner can read, all at once or not at all. */
async function writePrivate(path: string, content: string): Promise<void> {
  const pending = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(pending, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pending, path);
  } catch (error) {
    await rm(pending, { force: true });
    throw new BootstrapError("PAIRING_IO_FAILED", { cause: error });
  }
}

export type PairOptions = Readonly<{
  /** Absolute install root; the same one slice 1 installs into. */
  root: string;
  serverUrl: string;
  /** Where the code comes from: hidden input or a protected file. Never a flag value. */
  readToken: () => Promise<string>;
  /** Shows the organization and intent and asks, locally, whether to go on. */
  confirm: (preview: EnrollmentPreview) => Promise<boolean>;
  fetch: typeof fetch;
  now: Date;
}>;

export type PairResult = Readonly<{
  /** `paired` on a first pairing; `already` when this very setup was recorded before. */
  status: "paired" | "already";
  binding: PairingBinding;
  tokenFile: string;
}>;

/**
 * Pairs the installation. Order matters: the server is asked about the code
 * before anything is written; a mismatch is refused before the person is
 * asked; the person is asked before anything is written; the binding is
 * written before the code file, so a stop between them is resumed by a rerun.
 */
export async function pairInstallation(
  options: PairOptions,
): Promise<PairResult> {
  const origin = normalizeServerOrigin(options.serverUrl);
  if (!isAbsolute(options.root)) {
    throw new BootstrapError("INSTALL_ROOT_INVALID");
  }
  try {
    await checkRoot(options.root);
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError("INSTALL_ROOT_INVALID", { cause: error });
  }
  const token = await options.readToken();
  const preview = await inspectEnrollment({
    origin,
    token,
    fetch: options.fetch,
  });
  const tokenFile = join(options.root, TOKEN_FILE);

  const existing = await readBinding(options.root);
  if (existing !== null) {
    if (
      existing.serverOrigin !== origin ||
      existing.organizationName !== preview.organizationName
    ) throw new BootstrapError("PAIRING_ORGANIZATION_DIFFERS");
    if (existing.enrollmentId !== preview.enrollmentId) {
      throw new BootstrapError("PAIRING_ALREADY_PAIRED");
    }
    // This very setup, again: keep it going, creating nothing new. The code
    // file is rewritten if a stop left it missing.
    if (preview.state === "pending") {
      await writePrivate(tokenFile, `${token}\n`);
    }
    return { status: "already", binding: existing, tokenFile };
  }

  if (preview.state !== "pending") {
    throw new BootstrapError("PAIRING_NOT_PENDING");
  }
  if (!(await options.confirm(preview))) {
    throw new BootstrapError("PAIRING_DECLINED");
  }
  const binding: PairingBinding = {
    version: 1,
    serverOrigin: origin,
    organizationName: preview.organizationName,
    enrollmentId: preview.enrollmentId,
    name: preview.name,
    boundAt: options.now.toISOString(),
  };
  // The binding never holds the code.
  await writePrivate(
    join(options.root, PAIRING_FILE),
    `${JSON.stringify(binding)}\n`,
  );
  await writePrivate(tokenFile, `${token}\n`);
  return { status: "paired", binding, tokenFile };
}
