/**
 * A small SMTP submission client (issue #458, chapter 25 section 19).
 *
 * Bakery sends only a link and a line of text, never the content of work, so
 * this is plain text submission: connect, secure the connection, authenticate,
 * send one message. It never sends without encryption. The only exception is a
 * loopback fixture in a test environment, which the caller opts into
 * explicitly; a production caller never passes that flag.
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
}>;

export type SmtpOptions = Readonly<{
  signal?: AbortSignal;
  /** Whole-exchange budget. */
  timeoutMs?: number;
  /**
   * Test environments only: a loopback fixture may speak plain SMTP. Ignored
   * for any other host.
   */
  allowPlainLoopback?: boolean;
}>;

export const SMTP_DEFAULT_TIMEOUT_MS = 15_000;

class SmtpFailure extends Error {
  constructor(readonly outcome: SmtpOutcome) {
    super(outcome);
  }
}

type Reply = { code: number; lines: string[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
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

class Session {
  private buffer = "";
  constructor(
    private conn: Deno.Conn,
    private readonly deadline: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  swap(conn: Deno.Conn): void {
    this.conn = conn;
    this.buffer = "";
  }

  private remaining(): number {
    const left = this.deadline - Date.now();
    if (left <= 0) throw new SmtpFailure(SmtpOutcome.Timeout);
    return left;
  }

  private async readChunk(): Promise<string> {
    this.signal?.throwIfAborted();
    const chunk = new Uint8Array(4096);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SmtpFailure(SmtpOutcome.Timeout)),
        this.remaining(),
      );
    });
    try {
      const read = await Promise.race([this.conn.read(chunk), timeout]);
      if (read === null) throw new SmtpFailure(SmtpOutcome.ServerError);
      return decoder.decode(chunk.subarray(0, read));
    } finally {
      clearTimeout(timer);
    }
  }

  /** One complete reply: lines `250-...` continue, `250 ...` ends. */
  async reply(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      let newline = this.buffer.indexOf("\r\n");
      while (newline === -1) {
        this.buffer += await this.readChunk();
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
    this.remaining();
    await this.conn.write(encoder.encode(`${command}\r\n`));
  }

  async command(command: string): Promise<Reply> {
    await this.send(command);
    return await this.reply();
  }

  close(): void {
    try {
      this.conn.close();
    } catch {
      // Already closed.
    }
  }
}

function expect(reply: Reply, ok: readonly number[], failure: SmtpOutcome) {
  if (!ok.includes(reply.code)) throw new SmtpFailure(failure);
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
  const deadline = Date.now() + (options.timeoutMs ?? SMTP_DEFAULT_TIMEOUT_MS);
  let session: Session | undefined;
  try {
    const plain = options.allowPlainLoopback === true &&
      isLoopback(connection.host);
    let conn: Deno.Conn;
    try {
      conn = connection.security === "tls" && !plain
        ? await Deno.connectTls({
          hostname: connection.host,
          port: connection.port,
        })
        : await Deno.connect({
          hostname: connection.host,
          port: connection.port,
        });
    } catch (error) {
      // A refused TLS handshake is not an unreachable server.
      const text = String(error);
      throw new SmtpFailure(
        /tls|certificate|handshake|invalid peer/i.test(text)
          ? SmtpOutcome.TlsFailed
          : SmtpOutcome.Unreachable,
      );
    }
    session = new Session(conn, deadline, options.signal);
    expect(await session.reply(), [220], SmtpOutcome.ServerError);
    const ehlo = async () => {
      const reply = await session!.command("EHLO bakery.local");
      expect(reply, [250], SmtpOutcome.ServerError);
      return reply.lines.join("\n").toUpperCase();
    };
    let capabilities = await ehlo();

    if (connection.security === "starttls" && !plain) {
      expect(
        await session.command("STARTTLS"),
        [220],
        SmtpOutcome.TlsFailed,
      );
      try {
        session.swap(
          await Deno.startTls(conn as Deno.TcpConn, {
            hostname: connection.host,
          }),
        );
      } catch {
        throw new SmtpFailure(SmtpOutcome.TlsFailed);
      }
      capabilities = await ehlo();
    }

    if (connection.password !== null) {
      const user = connection.username ?? "";
      const token = btoa(`\0${user}\0${connection.password}`);
      const auth = capabilities.includes("AUTH") &&
          !/AUTH[^\n]*PLAIN/.test(capabilities) &&
          /AUTH[^\n]*LOGIN/.test(capabilities)
        ? await loginAuth(session, user, connection.password)
        : await session.command(`AUTH PLAIN ${token}`);
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
    const body = message.text
      .replaceAll("\r\n", "\n")
      .split("\n")
      .map((line) => line.startsWith(".") ? `.${line}` : line)
      .join("\r\n");
    const raw = [
      `From: ${displayName(message.fromName)} <${message.fromAddress}>`,
      `To: <${message.to}>`,
      `Subject: ${headerSafe(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@bakery.local>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
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
  const second = await session.command(btoa(username));
  if (second.code !== 334) return second;
  return await session.command(btoa(password));
}
