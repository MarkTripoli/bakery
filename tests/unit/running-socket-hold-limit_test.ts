import { assertEquals } from "@std/assert";
import { proxyPreviewSocket } from "../../apps/server/src/modules/knowledge/previews/running-socket.ts";

// #19: the socket proxy to a running preview. These tests use a stand-in for the
// app's socket, so they need no network. A real app and a real socket are
// covered by tests/integration/serve-private-previews-*.

type Frame = string | ArrayBuffer;

/** The app's side: opens on its own and then does what the test scripts. */
class FakeAppSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeAppSocket | null = null;
  /** What the app does a moment after it opens, as a later event, like a real frame. */
  static afterOpen: (socket: FakeAppSocket) => void = () => {};

  readyState: number = FakeAppSocket.CONNECTING;
  binaryType = "blob";
  protocol = "";
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: Frame }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly closes: (number | undefined)[] = [];

  constructor(readonly url: URL | string, _options?: unknown) {
    FakeAppSocket.last = this;
    setTimeout(() => {
      this.readyState = FakeAppSocket.OPEN;
      this.onopen?.();
      setTimeout(() => FakeAppSocket.afterOpen(this), 0);
    }, 0);
  }

  send(_data: Frame) {}

  close(code?: number) {
    this.closes.push(code);
    this.readyState = FakeAppSocket.CLOSED;
  }
}

/** The person's socket, which never finishes connecting, and how it was closed. */
function stuckBrowserSocket() {
  const closed: (number | undefined)[] = [];
  const socket = {
    readyState: WebSocket.CONNECTING as number,
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    sent: [] as unknown[],
    send(data: unknown) {
      this.sent.push(data);
    },
    close(code?: number) {
      closed.push(code);
      this.readyState = WebSocket.CLOSED;
    },
  };
  return { socket, closed };
}

async function withFakeAppSocket(run: () => Promise<void>) {
  const real = globalThis.WebSocket;
  globalThis.WebSocket = FakeAppSocket as unknown as typeof WebSocket;
  FakeAppSocket.last = null;
  try {
    await run();
  } finally {
    globalThis.WebSocket = real;
    FakeAppSocket.afterOpen = () => {};
  }
}

function options(
  request: Request,
  browser: { socket: unknown },
  onEnd: () => void,
) {
  return {
    request,
    target: new URL("ws://127.0.0.1:1/"),
    headers: new Headers(),
    timeoutMs: 5000,
    recheckMs: 60_000,
    stillAllowed: () => Promise.resolve(true),
    upgradeWebSocket: () => ({
      socket: browser.socket as WebSocket,
      response: new Response(null, { status: 200 }),
    }),
    onEnd,
    unreachable: () => new Response("not answering", { status: 502 }),
  };
}

async function until(done: () => boolean, ms = 3000) {
  for (let waited = 0; !done() && waited < ms; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

Deno.test("frames an app sends before the person's socket opens are held only up to the limit", () =>
  withFakeAppSocket(async () => {
    // Nine 1 MiB frames: more than the 8 MiB the proxy may hold.
    FakeAppSocket.afterOpen = (app) => {
      for (let sent = 0; sent < 9; sent++) {
        app.onmessage?.({ data: new ArrayBuffer(1024 * 1024) });
      }
    };
    const browser = stuckBrowserSocket();
    let ended = 0;
    const response = await proxyPreviewSocket(
      options(new Request("http://preview.localhost/"), browser, () => ended++),
    );
    assertEquals(response.status, 200);
    await until(() => browser.closed.length > 0);
    // The person's socket is closed for being too big, nothing was sent to a
    // socket that never opened, the app's socket is closed, and the pair is over.
    assertEquals(browser.closed, [1009]);
    assertEquals(browser.socket.sent, []);
    assertEquals(FakeAppSocket.last?.closes, [1000]);
    assertEquals(ended, 1);
  }));

Deno.test("frames under the limit are held, then sent in order when the person's socket opens", () =>
  withFakeAppSocket(async () => {
    FakeAppSocket.afterOpen = (app) => {
      for (const data of ["hello-1", "hello-2"]) app.onmessage?.({ data });
    };
    const browser = stuckBrowserSocket();
    const response = await proxyPreviewSocket(
      options(new Request("http://preview.localhost/"), browser, () => {}),
    );
    assertEquals(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing is sent while the person's socket is still connecting.
    assertEquals(browser.socket.sent, []);
    browser.socket.readyState = WebSocket.OPEN;
    (browser.socket as unknown as { onopen: () => void }).onopen();
    assertEquals(browser.socket.sent, ["hello-1", "hello-2"]);
    browser.socket.close();
  }));

Deno.test("opening the app's socket leaves no abort listener on the request behind", () =>
  withFakeAppSocket(async () => {
    const signal = new AbortController().signal;
    let added = 0;
    let removed = 0;
    const addEventListener = signal.addEventListener.bind(signal);
    const removeEventListener = signal.removeEventListener.bind(signal);
    signal.addEventListener = (
      ...args: Parameters<typeof addEventListener>
    ) => {
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
    await proxyPreviewSocket(
      options(
        { signal, headers: new Headers() } as unknown as Request,
        browser,
        () => {},
      ),
    );
    assertEquals([added, removed], [1, 1]);
    browser.socket.close();
  }));
