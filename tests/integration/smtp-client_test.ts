import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  isBlockedAddress,
  isLoopbackAddress,
  sendMail,
  type SmtpConnection,
  type SmtpMessage,
} from "../../apps/server/src/modules/work/smtp-client.ts";
import { serveSmtp } from "../helpers/smtp-loopback.ts";

/**
 * The SMTP submission client against a scripted loopback server. Every mail
 * server problem is one fixed outcome; nothing the server says is returned; a
 * host is resolved and checked at send time, and the checked address is the
 * one connected to. This runs in the integration lane because it needs
 * loopback network access, which the unit lane deliberately does not have.
 */

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

const fixture = { allowPlainLoopback: true, timeoutMs: 800 };

Deno.test("a message is delivered with the login, the envelope and a dot-stuffed body", async () => {
  const server = serveSmtp({});
  try {
    assertEquals(
      await sendMail(connection(server.port), message, fixture),
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

Deno.test("a password with non-Latin-1 characters is sent as UTF-8, not thrown", async () => {
  const server = serveSmtp({});
  try {
    const password = "pässwörd-🙂-é";
    assertEquals(
      await sendMail(
        connection(server.port, { username: "bäkery", password }),
        message,
        fixture,
      ),
      "delivered",
    );
    const auth = server.received.find((line) => line.startsWith("AUTH PLAIN"));
    const bytes = Uint8Array.from(
      atob(auth!.slice("AUTH PLAIN ".length)),
      (character) => character.charCodeAt(0),
    );
    assertEquals(new TextDecoder().decode(bytes), `\0bäkery\0${password}`);
  } finally {
    await server.close();
  }
});

Deno.test("each mail server problem is one fixed outcome", async () => {
  const refused = serveSmtp({ auth: "535 5.7.8 bad credentials" });
  try {
    assertEquals(
      await sendMail(connection(refused.port), message, fixture),
      "auth_refused",
    );
  } finally {
    await refused.close();
  }

  const sender = serveSmtp({ mailFrom: "550 sender not allowed" });
  try {
    assertEquals(
      await sendMail(connection(sender.port), message, fixture),
      "from_refused",
    );
  } finally {
    await sender.close();
  }

  const silent = serveSmtp({ silent: true });
  try {
    assertEquals(
      await sendMail(connection(silent.port), message, {
        ...fixture,
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
    await sendMail(connection(port), message, fixture),
    "unreachable",
  );
});

Deno.test("it never sends without encryption: a refused STARTTLS ends the exchange before login", async () => {
  // The fixture may be reached, but over an encrypted channel only: the server
  // refuses STARTTLS, so nothing sensitive is sent.
  const server = serveSmtp({});
  try {
    assertEquals(
      await sendMail(connection(server.port), message, {
        allowLoopback: true,
        timeoutMs: 800,
      }),
      "tls_failed",
    );
    assert(!server.received.some((line) => line.startsWith("AUTH")));
    assert(!server.received.some((line) => line.startsWith("MAIL FROM")));
  } finally {
    await server.close();
  }
});

Deno.test("a header cannot be split by a newline in the sender name", async () => {
  const server = serveSmtp({});
  try {
    const outcome = await sendMail(
      connection(server.port),
      { ...message, fromName: "Bakery\r\nBcc: x@example.com" },
      fixture,
    );
    assertEquals(outcome, "server_error");
    assert(!server.received.some((line) => line.startsWith("DATA:")));
  } finally {
    await server.close();
  }
});

Deno.test("addresses in internal space are blocked, in every spelling", () => {
  const blocked = [
    "0.0.0.0",
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
  ];
  for (const address of blocked) {
    assert(isBlockedAddress(address), `${address} must be blocked`);
  }
  const allowed = [
    "93.184.216.34",
    "8.8.8.8",
    "172.32.0.1",
    "172.15.255.255",
    "192.169.0.1",
    "100.128.0.1",
    "2606:4700:4700::1111",
  ];
  for (const address of allowed) {
    assert(!isBlockedAddress(address), `${address} must be allowed`);
  }
  assert(isLoopbackAddress("127.0.0.2"));
  assert(isLoopbackAddress("::1"));
  assert(isLoopbackAddress("::ffff:127.0.0.1"));
  assert(!isLoopbackAddress("10.0.0.1"));
});

Deno.test("a host that resolves into internal space is never connected to", async () => {
  // The server listens on loopback, so a client that connected would show up
  // as a connection. None of these may.
  const server = serveSmtp({});
  try {
    // A numeric spelling and a name, each resolving to loopback; and a name
    // that resolves to BOTH a public and a loopback address.
    const cases: [string, readonly string[]][] = [
      ["decimal-ip", ["127.0.0.1"]],
      ["hex-ip", ["127.0.0.1"]],
      ["dns-rebind.example", ["127.0.0.1"]],
      ["both.example", ["93.184.216.34", "127.0.0.1"]],
      ["mapped.example", ["::ffff:127.0.0.1"]],
    ];
    for (const [host, addresses] of cases) {
      assertEquals(
        await sendMail(connection(server.port, { host }), message, {
          timeoutMs: 800,
          resolve: () => Promise.resolve(addresses),
        }),
        "unreachable",
        host,
      );
    }
    // The real resolver turns these numeric spellings into the address they
    // mean; if it cannot, the host is just unreachable. Neither connects.
    for (const host of ["2130706433", "0x7f000001", "127.1", "localhost"]) {
      assertEquals(
        await sendMail(connection(server.port, { host }), message, {
          timeoutMs: 800,
        }),
        "unreachable",
        host,
      );
    }
    assertEquals(server.connections(), 0);
  } finally {
    await server.close();
  }
});

Deno.test("it connects to the address it checked, not to the name it was given", async () => {
  // The name does not resolve on its own; only the resolver knows it. A client
  // that connected by name would fail, and one that re-resolved could be sent
  // somewhere other than where it checked.
  const server = serveSmtp({});
  try {
    assertEquals(
      await sendMail(
        connection(server.port, { host: "fixture.invalid" }),
        message,
        { ...fixture, resolve: () => Promise.resolve(["127.0.0.1"]) },
      ),
      "delivered",
    );
    assertEquals(server.connections(), 1);
  } finally {
    await server.close();
  }
});

Deno.test("an aborted request stops the exchange instead of waiting out the server", async () => {
  const silent = serveSmtp({ silent: true });
  try {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sendMail(connection(silent.port), message, {
      allowPlainLoopback: true,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await assertRejects(() => pending);
    assert(Date.now() - started < 3000, "the abort was not honoured");
  } finally {
    await silent.close();
  }
});
