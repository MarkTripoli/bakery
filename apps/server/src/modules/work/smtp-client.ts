import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A small SMTP submission client (issue #458, chapter 25 section 19).
 *
 * Bakery sends only a link and a line of text, never the content of work, so
 * this is plain text submission: resolve, connect, secure the connection,
 * authenticate, send one message. It never sends without encryption. The only
 * exception is a loopback fixture in a test environment, which the caller opts
 * into explicitly; a production caller never passes that flag.
 *
 * The host an administrator typed is not trusted. It is resolved here, at send
 * time, every address is checked, and the connection goes to the address that
 * was checked: a name that points at loopback, link-local, private or
 * unspecified space (or a numeric form such as `2130706433`) is never
 * connected to. Every connect, write and read is bounded by one deadline and
 * the request's abort signal.
 *
 * Every failure is mapped to one fixed outcome. The server's own reply, the
 * host and the credentials never leave this module, so a page or a log cannot
 * echo them back.
 */

export const SmtpOutcome = Object.freeze(
  {
    Delivered: "delivered",
    Unreachable: "unreachable",
    AuthRefused: "auth_refused",
    FromRefused: "from_refused",
    TlsFailed: "tls_failed",
    Timeout: "timeout",
    ServerError: "server_error",
  } as const,
);
export type SmtpOutcome = typeof SmtpOutcome[keyof typeof SmtpOutcome];

export type SmtpSecurity = "starttls" | "tls";

export type SmtpConnection = Readonly<{
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
}>;

export type SmtpMessage = Readonly<{
  fromAddress: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}>;

export type SmtpOptions = Readonly<{
  signal?: AbortSignal;
  /** Whole-exchange budget. */
  timeoutMs?: number;
  /**
   * Test environments only: a loopback fixture may speak plain SMTP. Ignored
   * for any other address.
   */
  allowPlainLoopback?: boolean;
  /**
   * Test environments only: a loopback fixture may be connected to, but the
   * connection must still be encrypted. Ignored for any other address.
   */
  allowLoopback?: boolean;
  /** Replaces DNS in tests; returns every address the name resolves to. */
  resolve?: (host: string) => Promise<readonly string[]>;
}>;

export const SMTP_DEFAULT_TIMEOUT_MS = 15_000;

class SmtpFailure extends Error {
  constructor(readonly outcome: SmtpOutcome) {
    super(outcome);
  }
}

type Reply = { code: number; lines: string[] };

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? octets
    : null;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, or null. */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** Whether an address is loopback: 127/8 or ::1, including a mapped form. */
export function isLoopbackAddress(address: string): boolean {
  const inner = mappedIpv4(address) ?? address;
  const octets = ipv4Octets(inner);
  if (octets !== null) return octets[0] === 127;
  return inner === "::1";
}

/**
 * Whether Bakery refuses to connect to an address: unspecified, loopback,
 * link-local, private, carrier-grade NAT, multicast and reserved space, for
 * IPv4 and IPv6, including IPv4-mapped IPv6. A mail server that is meant to be
 * reached lives at a public address.
 */
export function isBlockedAddress(address: string): boolean {
  const inner = mappedIpv4(address) ?? address;
  const octets = ipv4Octets(inner);
  if (octets !== null) {
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }
  const lower = inner.toLowerCase();
  if (isIP(lower) !== 6) return true;
  if (lower === "::" || lower === "::1") return true;
  // fe80::/10 link-local, fc00::/7 unique local, ff00::/8 multicast.
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00 ||
    (first & 0xff00) === 0xff00;
}

async function defaultResolve(host: string): Promise<readonly string[]> {
  // getaddrinfo semantics, so numeric forms such as 2130706433 or 127.1 resolve
  // to the address they really mean and are checked like any other.
  const found = await lookup(host, { all: true });
  return found.map((entry) => entry.address);
}

/** A header value must be one line: refuse CR and LF rather than strip them. */
function headerSafe(value: string): string {
  if (/[\r\n]/.test(value)) throw new SmtpFailure(SmtpOutcome.ServerError);
  return value;
}

/** Quotes a display name, so a comma or quote cannot change the header. */
function displayName(name: string): string {
  return `"${
    headerSafe(name).replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  }"`;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const ENCODED_WORD_BYTES = 39;
const BODY_LINE_CHARS = 76;

export function encodedHeaderText(value: string): string {
  if (PRINTABLE_ASCII.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const character of value) {
    const grown = chunk + character;
    if (Buffer.byteLength(grown, "utf8") > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = character;
    } else {
      chunk = grown;
    }
  }
  if (chunk !== "") words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${utf8Base64(word)}?=`).join("\r\n ");
}

function fromHeader(name: string, address: string): string {
  const safe = headerSafe(name);
  const shown = PRINTABLE_ASCII.test(safe)
    ? displayName(safe)
    : encodedHeaderText(safe);
  return `From: ${shown} <${address}>`;
}

function base64Lines(value: string): string {
  const encoded = utf8Base64(
    value.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"),
  );
  const lines: string[] = [];
  for (let start = 0; start < encoded.length; start += BODY_LINE_CHARS) {
    lines.push(encoded.slice(start, start + BODY_LINE_CHARS));
  }
  return lines.join("\r\n");
}

export function mimeBody(
  message: Pick<SmtpMessage, "text" | "html">,
  boundary: string = `bakery-${crypto.randomUUID()}`,
): string[] {
  const part = (type: string, content: string) => [
    `Content-Type: ${type}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(content),
  ];
  if (message.html === undefined) return part("text/plain", message.text);
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...part("text/plain", message.text),
    `--${boundary}`,
    ...part("text/html", message.html),
    `--${boundary}--`,
  ];
}

/** Base64 of the UTF-8 bytes, so a password with é or an emoji is sent as is. */
function utf8Base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** One deadline and one abort signal for every step of the exchange. */
class Budget {
  constructor(
    private readonly deadline: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  remaining(): number {
    const left = this.deadline - Date.now();
    if (left <= 0) throw new SmtpFailure(SmtpOutcome.Timeout);
    return left;
  }

  /** Races a promise against the deadline and the abort signal. */
  async run<T>(work: Promise<T>, onExpire?: () => void): Promise<T> {
    this.signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onExpire?.();
        reject(new SmtpFailure(SmtpOutcome.Timeout));
      }, this.remaining());
      abort = () => {
        onExpire?.();
        reject(this.signal?.reason ?? new Error("aborted"));
      };
      this.signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
      if (abort) this.signal?.removeEventListener("abort", abort);
    }
  }
}

class Session {
  private buffer = "";
  private failure: Error | null = null;
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(
    private socket: Socket | TLSSocket,
    private readonly budget: Budget,
  ) {
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.wake?.();
    });
    socket.on("error", (error: Error) => {
      this.failure = error;
      this.wake?.();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake?.();
    });
  }

  /** Waits until something arrives, or the budget runs out. */
  private async more(): Promise<void> {
    if (this.failure) throw new SmtpFailure(SmtpOutcome.ServerError);
    if (this.closed) throw new SmtpFailure(SmtpOutcome.ServerError);
    await this.budget.run(
      new Promise<void>((resolve) => {
        this.wake = resolve;
      }),
      () => this.socket.destroy(),
    );
    this.wake = null;
  }

  /** One complete reply: lines `250-...` continue, `250 ...` ends. */
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      let newline = this.buffer.indexOf("\r\n");
      while (newline === -1) {
        await this.more();
        newline = this.buffer.indexOf("\r\n");
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 2);
      lines.push(line);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) throw new SmtpFailure(SmtpOutcome.ServerError);
      if (match[2] === " ") return { code: Number(match[1]), lines };
    }
  }

  async send(command: string): Promise<void> {
    await this.budget.run(
      new Promise<void>((resolve, reject) => {
        this.socket.write(
          `${command}\r\n`,
          (error) => error ? reject(error) : resolve(),
        );
      }),
      () => this.socket.destroy(),
    );
  }

  async command(command: string): Promise<Reply> {
    await this.send(command);
    return await this.reply();
  }

  /** Upgrades the live connection to TLS for STARTTLS. */
  async upgrade(servername: string): Promise<void> {
    const raw = this.socket;
    raw.removeAllListeners("data");
    raw.removeAllListeners("error");
    raw.removeAllListeners("close");
    const secured = await this.budget.run(
      new Promise<TLSSocket>((resolve, reject) => {
        const tls = tlsConnect({
          socket: raw,
          servername: servername === "" ? undefined : servername,
        });
        tls.once("secureConnect", () => resolve(tls));
        tls.once("error", reject);
      }),
      () => raw.destroy(),
    );
    this.socket = secured;
    this.buffer = "";
    this.closed = false;
    this.failure = null;
    this.attach(secured);
  }

  close(): void {
    this.socket.destroy();
  }
}

function expect(reply: Reply, ok: readonly number[], failure: SmtpOutcome) {
  if (!ok.includes(reply.code)) throw new SmtpFailure(failure);
}

/** Resolves a host and picks the one address that may be connected to. */
async function chooseAddress(
  host: string,
  budget: Budget,
  options: SmtpOptions,
): Promise<{ address: string; plain: boolean }> {
  let addresses: readonly string[];
  try {
    addresses = await budget.run((options.resolve ?? defaultResolve)(host));
  } catch (error) {
    if (error instanceof SmtpFailure || options.signal?.aborted) throw error;
    throw new SmtpFailure(SmtpOutcome.Unreachable);
  }
  // Every address is checked, not just the first: a name that resolves to both
  // a public and an internal address is refused, so a later retry or fallback
  // can never reach the internal one.
  for (const address of addresses) {
    if (
      isLoopbackAddress(address) &&
      (options.allowPlainLoopback === true || options.allowLoopback === true)
    ) {
      continue;
    }
    if (isBlockedAddress(address)) {
      throw new SmtpFailure(SmtpOutcome.Unreachable);
    }
  }
  const chosen = addresses[0];
  if (chosen === undefined) throw new SmtpFailure(SmtpOutcome.Unreachable);
  return {
    address: chosen,
    plain: options.allowPlainLoopback === true && isLoopbackAddress(chosen),
  };
}

async function openSocket(
  target: { address: string; plain: boolean },
  connection: SmtpConnection,
  budget: Budget,
): Promise<Socket | TLSSocket> {
  const secure = connection.security === "tls" && !target.plain;
  const attempt = new Promise<Socket | TLSSocket>((resolve, reject) => {
    if (secure) {
      // The address was checked; the name is only for the certificate.
      const socket = tlsConnect({
        host: target.address,
        port: connection.port,
        servername: isIP(connection.host) === 0 ? connection.host : undefined,
      });
      socket.once("secureConnect", () => resolve(socket));
      socket.once("error", (error) => {
        const code = String((error as { code?: string }).code ?? "");
        reject(
          new SmtpFailure(
            /^E(CONN|HOST|NET|TIMED)/.test(code)
              ? SmtpOutcome.Unreachable
              : SmtpOutcome.TlsFailed,
          ),
        );
      });
    } else {
      const socket = netConnect({
        host: target.address,
        port: connection.port,
      });
      socket.once("connect", () => resolve(socket));
      socket.once(
        "error",
        () => reject(new SmtpFailure(SmtpOutcome.Unreachable)),
      );
    }
  });
  return await budget.run(attempt);
}

/**
 * Sends one message. Returns an outcome, never throws for a mail-server
 * problem; an aborted signal rethrows so the request ends as aborted.
 */
export async function sendMail(
  connection: SmtpConnection,
  message: SmtpMessage,
  options: SmtpOptions = {},
): Promise<SmtpOutcome> {
  const budget = new Budget(
    Date.now() + (options.timeoutMs ?? SMTP_DEFAULT_TIMEOUT_MS),
    options.signal,
  );
  let session: Session | undefined;
  try {
    const target = await chooseAddress(connection.host, budget, options);
    session = new Session(
      await openSocket(target, connection, budget),
      budget,
    );
    expect(await session.reply(), [220], SmtpOutcome.ServerError);
    const ehlo = async () => {
      const reply = await session!.command("EHLO bakery.local");
      expect(reply, [250], SmtpOutcome.ServerError);
      return reply.lines.join("\n").toUpperCase();
    };
    let capabilities = await ehlo();

    if (connection.security === "starttls" && !target.plain) {
      expect(
        await session.command("STARTTLS"),
        [220],
        SmtpOutcome.TlsFailed,
      );
      try {
        await session.upgrade(
          isIP(connection.host) === 0 ? connection.host : "",
        );
      } catch (error) {
        if (error instanceof SmtpFailure) throw error;
        throw new SmtpFailure(SmtpOutcome.TlsFailed);
      }
      capabilities = await ehlo();
    }

    if (connection.password !== null) {
      const user = connection.username ?? "";
      const plainAuth = utf8Base64(`\0${user}\0${connection.password}`);
      const auth = capabilities.includes("AUTH") &&
          !/AUTH[^\n]*PLAIN/.test(capabilities) &&
          /AUTH[^\n]*LOGIN/.test(capabilities)
        ? await loginAuth(session, user, connection.password)
        : await session.command(`AUTH PLAIN ${plainAuth}`);
      expect(auth, [235], SmtpOutcome.AuthRefused);
    }

    expect(
      await session.command(`MAIL FROM:<${headerSafe(message.fromAddress)}>`),
      [250],
      SmtpOutcome.FromRefused,
    );
    expect(
      await session.command(`RCPT TO:<${headerSafe(message.to)}>`),
      [250, 251],
      SmtpOutcome.ServerError,
    );
    expect(await session.command("DATA"), [354], SmtpOutcome.ServerError);
    const raw = [
      fromHeader(message.fromName, message.fromAddress),
      `To: <${message.to}>`,
      `Subject: ${encodedHeaderText(headerSafe(message.subject))}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@bakery.local>`,
      "MIME-Version: 1.0",
      ...mimeBody(message),
    ].join("\r\n");
    await session.send(`${raw}\r\n.`);
    expect(await session.reply(), [250], SmtpOutcome.ServerError);
    await session.send("QUIT").catch(() => undefined);
    return SmtpOutcome.Delivered;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof SmtpFailure) return error.outcome;
    return SmtpOutcome.ServerError;
  } finally {
    session?.close();
  }
}

async function loginAuth(
  session: Session,
  username: string,
  password: string,
): Promise<Reply> {
  const first = await session.command("AUTH LOGIN");
  if (first.code !== 334) return first;
  const second = await session.command(utf8Base64(username));
  if (second.code !== 334) return second;
  return await session.command(utf8Base64(password));
}
