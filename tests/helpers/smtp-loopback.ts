const encoder = new TextEncoder();

export type ReceivedMail = Readonly<{
  subject: string;
  text: string | undefined;
  html: string | undefined;
  longestLine: number;
}>;

const utf8 = (base64: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(base64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)),
  );

export function readMail(data: string): ReceivedMail {
  const parts = new Map<string, string>();
  for (
    const [, type, body] of data.matchAll(
      /Content-Type: (text\/\w+); charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g,
    )
  ) parts.set(type, utf8(body));
  const folded = /\r\nSubject: ((?:[^\r\n]|\r\n )*)/.exec(data)?.[1] ?? "";
  const subject = folded.split("\r\n ").map((word) => {
    const encoded = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word);
    return encoded ? utf8(encoded[1]) : word;
  }).join("");
  return {
    subject,
    text: parts.get("text/plain"),
    html: parts.get("text/html"),
    longestLine: Math.max(...data.split("\r\n").map((line) => line.length)),
  };
}

export type SmtpScript = {
  auth?: string;
  mailFrom?: string;
  silent?: boolean;
};

export function serveSmtp(script: SmtpScript = {}) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const received: string[] = [];
  let connections = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = (async () => {
    for (;;) {
      let conn: Deno.Conn;
      try {
        conn = await listener.accept();
      } catch {
        return;
      }
      connections += 1;
      if (script.silent) {
        await held;
        conn.close();
        continue;
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
              break;
            }
          }
        }
      } catch {
        continue;
      }
    }
  })();
  return {
    port,
    received,
    connections: () => connections,
    close: async () => {
      release();
      listener.close();
      await done.catch(() => undefined);
    },
  };
}
