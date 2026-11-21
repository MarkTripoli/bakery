import { Buffer } from "node:buffer";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import {
  ADDRESS_REFUSED,
  ADDRESS_REFUSED_REASON,
  createGuardedLookup,
  isNonPublicIp,
} from "./address-policy.ts";

/** The most of a receiver's answer the sender keeps; the rest is dropped unread. */
export const PINNED_BODY_MAX_BYTES = 16 * 1024;

/** Statuses a Response may not carry a body for. */
const NO_BODY = new Set([204, 205, 304]);

function refusal(): Error & { code: string } {
  return Object.assign(new Error(ADDRESS_REFUSED_REASON), {
    code: ADDRESS_REFUSED,
  });
}

/** Whether a failed send was refused because its address is not public. */
export function isAddressRefusal(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === ADDRESS_REFUSED;
}

/**
 * A `fetch` for outbound alert and telemetry sends that cannot be rebound.
 *
 * `fetch` resolves the name itself, so a check made before it can be answered
 * differently when it connects. This one uses `node:https` with a guarded
 * `lookup`: the name is resolved once, every address is checked, and the
 * connection dials only what was approved, with the original host name for TLS.
 * It follows no redirect and keeps at most `maxBodyBytes` of the answer, so a
 * hostile receiver cannot make the server buffer a stream.
 */
export function createPinnedFetch(options: {
  lookup?: LookupFunction;
  /** Replaceable so a test can watch what is dialled without a network. */
  request?: typeof httpsRequest;
  maxBodyBytes?: number;
} = {}): typeof fetch {
  const lookup = options.lookup ?? createGuardedLookup();
  const request = options.request ?? httpsRequest;
  const maxBody = options.maxBodyBytes ?? PINNED_BODY_MAX_BYTES;
  return ((input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url,
      );
      const host = url.hostname.replace(/^\[|\]$/g, "");
      // A literal address never consults `lookup`, so it is checked here.
      if (
        url.protocol !== "https:" || (isIP(host) !== 0 && isNonPublicIp(host))
      ) {
        reject(refusal());
        return;
      }
      const body = init.body;
      if (body !== undefined && body !== null && typeof body !== "string") {
        reject(new TypeError("A pinned send takes a text body only."));
        return;
      }
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      if (typeof body === "string") {
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      const req = request({
        method: init.method ?? "GET",
        protocol: "https:",
        hostname: host,
        port: url.port === "" ? 443 : Number(url.port),
        path: url.pathname + url.search,
        headers,
        agent: false,
        lookup,
        signal: init.signal ?? undefined,
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const status = res.statusCode ?? 0;
          const answer = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const part of value) answer.append(name, part);
            } else if (value !== undefined) answer.set(name, value);
          }
          resolve(
            new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), {
              status,
              statusText: res.statusMessage ?? "",
              headers: answer,
            }),
          );
        };
        res.on("data", (chunk: Buffer) => {
          if (size >= maxBody) return;
          chunks.push(chunk.subarray(0, maxBody - size));
          size += chunk.length;
          // Enough: drop the connection instead of reading a stream.
          if (size >= maxBody) res.destroy();
        });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      });
      req.on("error", reject);
      req.end(typeof body === "string" ? body : undefined);
    })) as typeof fetch;
}

/**
 * The first `maxChars` characters of a response's body, read from the stream
 * and then cancelled, so a receiver that keeps sending is never buffered whole.
 */
export async function readAnswer(
  response: Response,
  maxChars: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // An unreadable body is an empty answer, not a failed send.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, maxChars);
}
