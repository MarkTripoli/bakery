/**
 * WebSocket through a running preview's own origin, for the app's live reload
 * and its own sockets. The browser's socket ends here; a second socket goes to
 * the registered port on the configured host, and messages are copied both
 * ways. Nothing in the request chooses where the second socket goes.
 */

/** Largest amount waiting to be sent on either side before the pair is closed. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const GOING_AWAY = 1001;
const POLICY = 1008;
const TOO_BIG = 1009;
const INTERNAL = 1011;

/** What a person sees when a socket is closed for a rule, not by the app. */
const POLICY_REASON = "preview ended";

/** Headers the socket library sets itself, or that never reach the app. */
const NOT_FORWARDED_TO_SOCKET = new Set([
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-accept",
]);

export type PreviewSocketUpgrade = (
  request: Request,
  options: Deno.UpgradeWebSocketOptions,
) => Deno.WebSocketUpgrade;

export type PreviewSocketOptions = {
  readonly request: Request;
  /** `ws://` URL on the registered port: built from configuration, not input. */
  readonly target: URL;
  /** Request headers already filtered the way the plain proxy filters them. */
  readonly headers: Headers;
  readonly timeoutMs: number;
  readonly recheckMs: number;
  /** False once the preview or the grantor's right to it has ended. */
  readonly stillAllowed: () => Promise<boolean>;
  readonly upgradeWebSocket: PreviewSocketUpgrade;
  /** Called once when the pair is over, however it ended. */
  readonly onEnd: () => void;
  /** Returns the page for an app that did not accept the socket. */
  readonly unreachable: () => Response;
};

/** The subprotocols a client asked for, in its order. */
export function requestedProtocols(header: string | null): string[] {
  if (header === null) return [];
  return header.split(",").map((value) => value.trim()).filter((value) =>
    value !== ""
  );
}

/** A close code a socket may send: 1005, 1006 and 1015 are never put on the wire. */
export function sendableCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) return 1000;
  if (code >= 1000 && code <= 1003) return code;
  if (code >= 1007 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return INTERNAL;
}

/**
 * A socket this process opened (the one to the app) may only close with 1000
 * or 3000-4999; any other code throws. The reason a rule ended it still goes to
 * the person on their own socket, which may use any sendable code.
 */
export function clientCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

function closeQuietly(socket: WebSocket, code: number, reason: string) {
  try {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(code, reason.slice(0, 100));
    }
  } catch (_error) {
    // Already closing: nothing more to do.
  }
}

/** Opens the app's socket, then answers the browser's. Never half-opens. */
export async function proxyPreviewSocket(
  options: PreviewSocketOptions,
): Promise<Response> {
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    options.onEnd();
  };
  const headers: Record<string, string> = {};
  for (const [name, value] of options.headers) {
    if (!NOT_FORWARDED_TO_SOCKET.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  const protocols = requestedProtocols(
    options.request.headers.get("sec-websocket-protocol"),
  );

  let upstream: WebSocket;
  try {
    upstream = new WebSocket(
      options.target,
      { protocols, headers } as unknown as string[],
    );
  } catch (_error) {
    end();
    return options.unreachable();
  }
  upstream.binaryType = "arraybuffer";

  const opened = await new Promise<boolean>((resolve) => {
    // Every way out clears the timer and removes the listener, once.
    const timer = setTimeout(() => settle(false), options.timeoutMs);
    const abort = () => settle(false);
    const settle = (value: boolean) => {
      clearTimeout(timer);
      options.request.signal.removeEventListener("abort", abort);
      resolve(value);
    };
    options.request.signal.addEventListener("abort", abort, { once: true });
    upstream.onopen = () => settle(true);
    upstream.onerror = () => settle(false);
    upstream.onclose = () => settle(false);
  });
  if (!opened) {
    closeQuietly(upstream, GOING_AWAY, "");
    end();
    return options.unreachable();
  }

  let upgraded: Deno.WebSocketUpgrade;
  try {
    // The browser is told the subprotocol the app chose, never one it guessed.
    upgraded = options.upgradeWebSocket(options.request, {
      protocol: upstream.protocol === "" ? undefined : upstream.protocol,
    });
  } catch (_error) {
    closeQuietly(upstream, INTERNAL, "");
    end();
    return options.unreachable();
  }
  const { socket: browser, response } = upgraded;
  browser.binaryType = "arraybuffer";

  // Held in an object because `finish` can run before the interval starts.
  const watch: { timer?: ReturnType<typeof setInterval> } = {};
  const finish = (code: number, reason: string) => {
    clearInterval(watch.timer);
    end();
    closeQuietly(browser, code, reason);
    closeQuietly(upstream, clientCloseCode(code), reason);
  };

  const send = (to: WebSocket, data: string | ArrayBuffer) => {
    if (to.readyState !== WebSocket.OPEN) return;
    if (to.bufferedAmount > MAX_BUFFERED_BYTES) {
      finish(TOO_BIG, "too much waiting to be sent");
      return;
    }
    try {
      to.send(data);
    } catch (_error) {
      finish(INTERNAL, "");
    }
  };

  // The person's socket is still connecting when the upgrade returns, and a
  // frame sent to it then would be dropped: the app's first frames (a greeting)
  // wait here, in order, until it opens.
  const waiting: (string | ArrayBuffer)[] = [];
  let waitingBytes = 0;
  const toBrowser = (data: string | ArrayBuffer) => {
    if (browser.readyState !== WebSocket.CONNECTING) {
      send(browser, data);
      return;
    }
    waitingBytes += typeof data === "string" ? data.length : data.byteLength;
    if (waitingBytes > MAX_BUFFERED_BYTES) {
      finish(TOO_BIG, "too much waiting to be sent");
      return;
    }
    waiting.push(data);
  };
  browser.onopen = () => {
    for (const data of waiting.splice(0)) send(browser, data);
    waitingBytes = 0;
  };
  // No frame can arrive between the app's socket opening and this line: the
  // code after the open runs as a microtask, before the next frame is read.
  upstream.onmessage = (event) => toBrowser(event.data);
  browser.onmessage = (event) => send(upstream, event.data);
  browser.onclose = (event) =>
    finish(sendableCloseCode(event.code), event.reason);
  upstream.onclose = (event) =>
    finish(sendableCloseCode(event.code), event.reason);
  browser.onerror = () => finish(INTERNAL, "");
  upstream.onerror = () => finish(INTERNAL, "");

  // A socket outlives the request that opened it, so the preview and the
  // grantor's right to it are asked again while it is open. A stop, an
  // expiry, a revoke or a demotion ends it within one interval.
  let asking = false;
  watch.timer = setInterval(async () => {
    if (asking) return;
    asking = true;
    try {
      if (!await options.stillAllowed()) finish(POLICY, POLICY_REASON);
    } catch (_error) {
      finish(INTERNAL, "");
    } finally {
      asking = false;
    }
  }, options.recheckMs);

  return response;
}
