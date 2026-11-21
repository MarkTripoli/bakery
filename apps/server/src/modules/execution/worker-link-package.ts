import { type Context } from "hono";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  WORKER_LINK_BIN,
  WORKER_LINK_SOURCE_DIGEST,
} from "../../../../../packages/worker-bootstrap/generated/link-bundle.ts";

/**
 * `GET /v1/worker/link.tgz` (#70): until the owner picks an npm scope, the
 * Bakery origin serves the `link` command itself, as an npm tarball that
 * `npx -y <origin>/v1/worker/link.tgz link ...` installs and runs under
 * Node. The tarball holds a package.json and the bootstrap bundled into one
 * ES module (`pnpm worker-link:generate`). It is built once per process from
 * that committed bundle with fixed times, owners and modes, so the same
 * commit always serves the same bytes.
 */

const VERSION = `0.0.0-link.${WORKER_LINK_SOURCE_DIGEST.slice(0, 12)}`;

export const WORKER_LINK_PACKAGE_JSON = {
  name: "@bakery/worker",
  version: VERSION,
  description:
    "Links this machine to Bakery with one pasted command (served by the Bakery origin).",
  type: "module",
  bin: { "bakery-worker": "bin/bakery-worker.mjs" },
  engines: { node: ">=22" },
  license: "UNLICENSED",
};

const encoder = new TextEncoder();

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** One ustar entry: header, then the data padded to whole 512-byte blocks. */
function tarEntry(path: string, mode: number, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const put = (offset: number, text: string) =>
    header.set(encoder.encode(text), offset);
  put(0, path);
  put(100, octal(mode, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(data.byteLength, 12));
  put(136, octal(0, 12));
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
  padded.set(data);
  const entry = new Uint8Array(512 + padded.byteLength);
  entry.set(header);
  entry.set(padded, 512);
  return entry;
}

function buildTarball(): Uint8Array<ArrayBuffer> {
  const entries = [
    tarEntry(
      "package/package.json",
      0o644,
      encoder.encode(`${JSON.stringify(WORKER_LINK_PACKAGE_JSON, null, 2)}\n`),
    ),
    tarEntry(
      "package/bin/bakery-worker.mjs",
      0o755,
      encoder.encode(WORKER_LINK_BIN),
    ),
  ];
  const size = entries.reduce((total, entry) => total + entry.byteLength, 0);
  const tar = new Uint8Array(size + 1024);
  let at = 0;
  for (const entry of entries) {
    tar.set(entry, at);
    at += entry.byteLength;
  }
  // gzip from node:zlib writes a zero modification time.
  return new Uint8Array(gzipSync(tar, { level: 9 }));
}

let cached: { bytes: Uint8Array<ArrayBuffer>; etag: string } | undefined;

export function workerLinkTarball(): {
  bytes: Uint8Array<ArrayBuffer>;
  etag: string;
} {
  if (!cached) {
    const bytes = buildTarball();
    cached = {
      bytes,
      etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
    };
  }
  return cached;
}

/** Public and cacheable: it holds no secret, only the code every machine runs. */
export function workerLinkTarballRoute(context: Context): Response {
  const { bytes, etag } = workerLinkTarball();
  const headers = {
    "content-type": "application/gzip",
    "cache-control": "public, max-age=300",
    etag,
  };
  if (context.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { status: 200, headers });
}
