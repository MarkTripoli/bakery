import dns from "node:dns/promises";
import dgram from "node:dgram";

export type TxtDns = {
  publish(name: string, value: string): void;
  close(): void;
};

/**
 * A real UDP DNS server answering TXT queries from a table, installed as the
 * process resolver so Better Auth's domain verification performs a genuine
 * `resolveTxt` against it. Unknown names get an empty answer.
 */
export async function startTxtDns(): Promise<TxtDns> {
  const records = new Map<string, string>();
  const socket = dgram.createSocket("udp4");
  const previous = dns.getServers();
  socket.on(
    "message",
    (query: Uint8Array, remote: { port: number; address: string }) => {
      let offset = 12;
      const labels: string[] = [];
      while (query[offset] !== 0) {
        const length = query[offset];
        labels.push(
          new TextDecoder().decode(
            query.slice(offset + 1, offset + 1 + length),
          ),
        );
        offset += length + 1;
      }
      const questionEnd = offset + 1 + 4;
      const value = records.get(labels.join("."));
      const header = new Uint8Array(12);
      header.set(query.slice(0, 2));
      header[2] = 0x81;
      header[3] = 0x80;
      header[5] = 1;
      header[7] = value ? 1 : 0;
      const parts: Uint8Array[] = [header, query.slice(12, questionEnd)];
      if (value) {
        const data = new TextEncoder().encode(value);
        const rdlength = data.length + 1;
        parts.push(
          new Uint8Array([
            0xc0,
            0x0c,
            0,
            16,
            0,
            1,
            0,
            0,
            0,
            60,
            rdlength >> 8,
            rdlength & 255,
            data.length,
          ]),
          data,
        );
      }
      const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      socket.send(out, remote.port, remote.address);
    },
  );
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  dns.setServers([`127.0.0.1:${socket.address().port}`]);
  return {
    publish: (name, value) => records.set(name, value),
    close() {
      dns.setServers(previous);
      socket.close();
    },
  };
}
