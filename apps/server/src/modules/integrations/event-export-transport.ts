import { request } from "node:https";
import type {
  DeliveryOutcome,
  DeliveryTransport,
} from "./event-export-dispatch.ts";

/**
 * The outbound HTTP seam (#21).
 *
 * The one property that matters here is that the connection goes to an address
 * that was already judged. `lookup` is overridden to answer from the checked
 * list, so the TLS handshake still verifies the certificate against the real
 * hostname (SNI and `Host` are untouched) while the socket goes where the check
 * said. Resolving again inside the client would reopen the rebinding window the
 * check exists to close, and connecting to a bare IP would break certificate
 * verification - both are avoided by pinning the lookup rather than the URL.
 */

/** Most bytes of a receiver's response body this reads before discarding it. */
const RESPONSE_DRAIN_LIMIT = 8 * 1024;

/**
 * A `lookup` that answers only from the addresses already checked.
 *
 * Exported because it is the whole security property: a test can assert that it
 * never consults a resolver and never answers an address that was not passed in.
 */
export function pinnedLookup(addresses: readonly string[]) {
  const pinned = [...addresses];
  return (
    _hostname: string,
    options: { readonly all?: boolean } | number,
    callback: (...args: unknown[]) => void,
  ): void => {
    const wantsAll = typeof options === "object" && options?.all === true;
    const first = pinned[0];
    if (first === undefined) {
      // No checked address means no connection. Answering with a resolver
      // fallback here would be the rebinding hole in one line.
      const error = Object.assign(new Error("no checked address"), {
        code: "ENOTFOUND",
      });
      callback(error);
      return;
    }
    if (wantsAll) {
      callback(
        null,
        pinned.map((address) => ({
          address,
          family: address.includes(":") ? 6 : 4,
        })),
      );
      return;
    }
    callback(null, first, first.includes(":") ? 6 : 4);
  };
}

/** How long one delivery may take before it is treated as uncertain. */
export const EXPORT_TIMEOUT_MS = 10_000;

/**
 * Sends one export over HTTPS to a checked address.
 *
 * A 2xx is acknowledged. A 4xx is refused: the receiver understood and said no,
 * so retrying the same request cannot help. A 5xx, a timeout, or a connection
 * that dies mid-flight is uncertain - the receiver may have acted - and is the
 * only outcome that schedules a retry.
 */
export function createPinnedHttpsTransport(
  options: { readonly timeoutMs?: number } = {},
): DeliveryTransport {
  const timeoutMs = options.timeoutMs ?? EXPORT_TIMEOUT_MS;
  return {
    send(input) {
      return new Promise<DeliveryOutcome>((resolve) => {
        const url = new URL(`${input.origin}${input.path}`);
        let settled = false;
        const finish = (outcome: DeliveryOutcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };

        const outgoing = request(
          {
            protocol: "https:",
            hostname: url.hostname,
            port: url.port === "" ? 443 : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers: {
              ...input.headers,
              "content-type": "application/json",
              "content-length": String(input.raw.byteLength),
            },
            lookup: pinnedLookup(input.addresses) as never,
            timeout: timeoutMs,
          },
          (response) => {
            const status = response.statusCode ?? 0;
            response.on("data", () => {});
            response.on("end", () => {
              if (status >= 200 && status < 300) {
                finish({ kind: "acknowledged", status });
                return;
              }
              if (status >= 400 && status < 500) {
                finish({ kind: "refused", status });
                return;
              }
              finish({ kind: "uncertain", reason: "response_failed" });
            });
            response.on(
              "error",
              () => finish({ kind: "uncertain", reason: "response_failed" }),
            );
            // A receiver that streams forever must not hold the worker.
            response.on("close", () => {
              if (!response.complete) {
                finish({ kind: "uncertain", reason: "response_failed" });
              }
            });
            response.resume();
            void RESPONSE_DRAIN_LIMIT;
          },
        );

        outgoing.on("timeout", () => {
          outgoing.destroy();
          finish({ kind: "uncertain", reason: "no_response" });
        });
        outgoing.on(
          "error",
          () => finish({ kind: "uncertain", reason: "no_response" }),
        );
        outgoing.end(input.raw);
      });
    },
  };
}
