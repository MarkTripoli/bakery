import { assert, assertEquals } from "@std/assert";
import {
  sendMail,
  type SmtpConnection,
  type SmtpMessage,
} from "../../apps/server/src/modules/work/smtp-client.ts";

/**
 * The SMTP submission client against a scripted loopback server. Every mail
 * server problem is one fixed outcome; nothing the server says is returned.
 */

type Script = {
  auth?: string;
  mailFrom?: string;
  silent?: boolean;
  noTls?: boolean;
};

const encoder = new TextEncoder();

/** Serves one SMTP conversation and records what the client sent. */
function serve(script: Script) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const received: string[] = [];
  const done = (async () => {
    const conn = await listener.accept();
    if (script.silent) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      conn.close();
      return;
    }
    const send = (text: string) => conn.write(encoder.encode(`${text}\r\n`));
    const decoder = new TextDecoder();
    let buffer = "";
    let inData = false;
    await send("220 fixture ESMTP");
    const chunk = new Uint8Array(8192);
    try {
      for (;;) {
        const read = await conn.read(chunk);
        if (read === null) break;
        buffer += decoder.decode(chunk.subarray(0, read));
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end === -1) break;
            received.push(`DATA:${buffer.slice(0, end)}`);
            buffer = buffer.slice(end + 5);
            inData = false;
            await send("250 queued");
            continue;
          }
          const newline = buffer.indexOf("\r\n");
          if (newline === -1) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          received.push(line);
          if (line.startsWith("EHLO")) {
            await send("250-fixture\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME");
          } else if (line === "STARTTLS") {
            await send("454 TLS not available");
          } else if (line.startsWith("AUTH PLAIN")) {
            await send(script.auth ?? "235 ok");
          } else if (line.startsWith("MAIL FROM")) {
            await send(script.mailFrom ?? "250 ok");
          } else if (line.startsWith("RCPT TO")) {
            await send("250 ok");
          } else if (line === "DATA") {
            inData = true;
            await send("354 go");
          } else if (line === "QUIT") {
            await send("221 bye");
            conn.close();
            return;
          }
        }
      }
    } catch {
      // The client closed first.
    }
  })();
  return {
    port,
    received,
    close: async () => {
      listener.close();
      await done.catch(() => undefined);
    },
  };
}

const message: SmtpMessage = {
  fromAddress: "bakery@example.com",
  fromName: "Bakery",
  to: "sam@example.com",
  subject: "Bakery test email",
  text: "Line one\n.leading dot line\nLine three",
};

function connection(port: number, extra: Partial<SmtpConnection> = {}) {
  return {
    host: "127.0.0.1",
    port,
    security: "starttls",
    username: "bakery",
    password: "s3cret",
    ...extra,
  } satisfies SmtpConnection;
}

const options = { allowPlainLoopback: true, timeoutMs: 800 };

Deno.test("a message is delivered with the login, the envelope and a dot-stuffed body", async () => {
  const server = serve({});
  try {
    assertEquals(
      await sendMail(connection(server.port), message, options),
      "delivered",
    );
    const auth = server.received.find((line) => line.startsWith("AUTH PLAIN"));
    assertEquals(atob(auth!.slice("AUTH PLAIN ".length)), "\0bakery\0s3cret");
    assert(server.received.includes("MAIL FROM:<bakery@example.com>"));
    assert(server.received.includes("RCPT TO:<sam@example.com>"));
    const data = server.received.find((line) => line.startsWith("DATA:"))!;
    assert(data.includes('From: "Bakery" <bakery@example.com>'));
    assert(data.includes("\r\n..leading dot line\r\n"));
  } finally {
    await server.close();
  }
});

Deno.test("each mail server problem is one fixed outcome", async () => {
  const refused = serve({ auth: "535 5.7.8 bad credentials" });
  try {
    assertEquals(
      await sendMail(connection(refused.port), message, options),
      "auth_refused",
    );
  } finally {
    await refused.close();
  }

  const sender = serve({ mailFrom: "550 sender not allowed" });
  try {
    assertEquals(
      await sendMail(connection(sender.port), message, options),
      "from_refused",
    );
  } finally {
    await sender.close();
  }

  const silent = serve({ silent: true });
  try {
    assertEquals(
      await sendMail(connection(silent.port), message, {
        ...options,
        timeoutMs: 250,
      }),
      "timeout",
    );
  } finally {
    await silent.close();
  }

  // Nothing is listening on a port that was just closed.
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (closed.addr as Deno.NetAddr).port;
  closed.close();
  assertEquals(
    await sendMail(connection(port), message, options),
    "unreachable",
  );
});

Deno.test("it never sends without encryption outside a test fixture", async () => {
  // A server that cannot start TLS is not sent to: no loopback allowance, so
  // STARTTLS is required and refusing it ends the exchange.
  const server = serve({});
  try {
    assertEquals(
      await sendMail(connection(server.port), message, { timeoutMs: 800 }),
      "tls_failed",
    );
    assert(!server.received.some((line) => line.startsWith("AUTH")));
    assert(!server.received.some((line) => line.startsWith("MAIL FROM")));
  } finally {
    await server.close();
  }
});

Deno.test("a header cannot be split by a newline in the sender name", async () => {
  const server = serve({});
  try {
    const outcome = await sendMail(
      connection(server.port),
      { ...message, fromName: "Bakery\r\nBcc: x@example.com" },
      options,
    );
    assertEquals(outcome, "server_error");
    assert(!server.received.some((line) => line.startsWith("DATA:")));
  } finally {
    await server.close();
  }
});
