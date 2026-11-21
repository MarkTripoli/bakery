import { assertEquals } from "@std/assert";
import { proxyPreviewSocket } from "../../apps/server/src/modules/knowledge/previews/running-socket.ts";

// #19: frames the app sends before the person's socket opens are held, but only
// up to a limit, so an app cannot make the server hold an unbounded amount.

/** A person's socket that never finishes connecting, and records how it was closed. */
function stuckBrowserSocket() {
  const closed: { code: number | undefined; reason: string | undefined }[] = [];
  const socket = {
    readyState: WebSocket.CONNECTING,
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    sent: [] as unknown[],
    send(data: unknown) {
      this.sent.push(data);
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      this.readyState = WebSocket.CLOSED;
    },
  };
  return { socket, closed };
}

Deno.test("an app that floods frames before the person's socket opens is cut off at the hold limit", async () => {
  const appSockets: WebSocket[] = [];
  const app = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      appSockets.push(socket);
      // Nine 1 MiB frames on open: more than the 8 MiB the proxy may hold.
      socket.onopen = () => {
        for (let sent = 0; sent < 9; sent++) {
          socket.send(new Uint8Array(1024 * 1024));
        }
      };
      return response;
    },
  );
  const browser = stuckBrowserSocket();
  let ended = 0;
  try {
    const response = await proxyPreviewSocket({
      request: new Request("http://preview.localhost/"),
      target: new URL(`ws://127.0.0.1:${(app.addr as Deno.NetAddr).port}/`),
      headers: new Headers(),
      timeoutMs: 5000,
      recheckMs: 60_000,
      stillAllowed: () => Promise.resolve(true),
      upgradeWebSocket: () => ({
        socket: browser.socket as unknown as WebSocket,
        response: new Response(null, { status: 200 }),
      }),
      onEnd: () => ended++,
      unreachable: () => new Response("not answering", { status: 502 }),
    });
    assertEquals(response.status, 200);
    for (
      let waited = 0;
      browser.closed.length === 0 && waited < 5000;
      waited += 50
    ) await new Promise((resolve) => setTimeout(resolve, 50));
    // Closed for being too big, nothing was sent to a socket that never opened,
    // and the pair is over.
    assertEquals(browser.closed.map((close) => close.code), [1009]);
    assertEquals(browser.socket.sent, []);
    assertEquals(ended, 1);
  } finally {
    for (const socket of appSockets) socket.close();
    await app.shutdown();
  }
});

Deno.test("opening the app's socket leaves no abort listener on the request behind", async () => {
  const app = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => Deno.upgradeWebSocket(request).response,
  );
  const signal = new AbortController().signal;
  let added = 0;
  let removed = 0;
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args: Parameters<typeof addEventListener>) => {
    added++;
    addEventListener(...args);
  };
  signal.removeEventListener = (
    ...args: Parameters<typeof removeEventListener>
  ) => {
    removed++;
    removeEventListener(...args);
  };
  const browser = stuckBrowserSocket();
  try {
    await proxyPreviewSocket({
      request: { signal, headers: new Headers() } as unknown as Request,
      target: new URL(`ws://127.0.0.1:${(app.addr as Deno.NetAddr).port}/`),
      headers: new Headers(),
      timeoutMs: 5000,
      recheckMs: 60_000,
      stillAllowed: () => Promise.resolve(true),
      upgradeWebSocket: () => ({
        socket: browser.socket as unknown as WebSocket,
        response: new Response(null, { status: 200 }),
      }),
      onEnd: () => {},
      unreachable: () => new Response("not answering", { status: 502 }),
    });
    assertEquals([added, removed], [1, 1]);
  } finally {
    browser.socket.close();
    await app.shutdown();
  }
});
