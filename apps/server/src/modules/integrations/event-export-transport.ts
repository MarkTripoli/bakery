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

/**
 * Most bytes of a receiver's response body this will read.
 *
 * A limit that is declared and never enforced is worse than no limit: the
 * constant read as if the hazard were handled while `void RESPONSE_DRAIN_LIMIT`
 * left a receiver streaming forever holding `send()` open. The byte count is now
 * enforced, and so is total time.
 */
export const RESPONSE_DRAIN_LIMIT = 8 * 1024;

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

/**
 * What a response status means.
 *
 * A 3xx is refused, not uncertain. The transport does not follow redirects, so a
 * redirect is a receiver answering "not here" - retrying the same request to the
 * same place cannot change that, and treating it as uncertain would retry it
 * forever. Only a 5xx or a lost connection is genuinely unknown.
 */
export function outcomeFor(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) return { kind: "acknowledged", status };
  if (status >= 300 && status < 500) return { kind: "refused", status };
  return { kind: "uncertain", reason: "server_error" };
}

/** The part of a response this reads, so the cap can be tested without TLS. */
export type DrainableResponse = {
  readonly statusCode?: number;
  on(
    event: "data",
    listener: (chunk: { readonly length: number }) => void,
  ): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  destroy(): void;
  resume(): void;
};

/**
 * The response handler, separated so the byte cap can be proved without TLS.
 *
 * A receiver that streams forever is a denial of service dressed as a slow
 * acknowledgement: the status is known immediately, so the body is drained only
 * as far as the cap and then the socket is dropped.
 */
export function createResponseHandler(
  status: number,
  finish: (outcome: DeliveryOutcome) => void,
): (response: DrainableResponse) => void {
  return (response) => {
    let drained = 0;
    // The exchange has one outcome. Without this guard a chunk that arrives while
    // the socket is being destroyed reports a second one, and a caller counting
    // outcomes would see the same attempt settle twice.
    let done = false;
    const settle = (outcome: DeliveryOutcome) => {
      if (done) return;
      done = true;
      finish(outcome);
    };
    response.on("data", (chunk) => {
      drained += chunk.length;
      if (drained > RESPONSE_DRAIN_LIMIT) {
        response.destroy();
        settle({ kind: "uncertain", reason: "response_too_large" });
      }
    });
    response.on("end", () => settle(outcomeFor(status)));
    response.on(
      "error",
      () => settle({ kind: "uncertain", reason: "response_failed" }),
    );
    response.on("close", () => {
      if (!response.resume) return;
    });
    response.resume();
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
          (response) =>
            createResponseHandler(response.statusCode ?? 0, finish)(response),
        );

        // Total time, not just socket idleness: a server that dribbles one byte
        // every few seconds never times out at the socket level. The timer runs
        // for the whole exchange and is cleared by whichever outcome lands first.
        const deadline = setTimeout(() => {
          outgoing.destroy();
          finish({ kind: "uncertain", reason: "deadline_exceeded" });
        }, timeoutMs);
        outgoing.on("close", () => clearTimeout(deadline));
        outgoing.on("timeout", () => {
          outgoing.destroy();
          clearTimeout(deadline);
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
