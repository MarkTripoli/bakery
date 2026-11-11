import { expect, test } from "@playwright/test";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const email = required("BAKERY_BROWSER_EMAIL");
const password = required("BAKERY_BROWSER_PASSWORD");

const socketTimeoutMs = 5_000;

test("browser websocket authorizes bounded events and cursor replay", async ({ page }) => {
  await page.goto("/__test__/auth");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed in.");

  await page.goto("/__test__/events");
  const fixture = page.locator("main");
  const organizationId = await fixture.getAttribute("data-organization-id");
  const applicationId = await fixture.getAttribute("data-application-id");
  expect(organizationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(applicationId).toMatch(/^[0-9a-f-]{36}$/);

  const firstConnection = await page.evaluate(
    async ({ organizationId, applicationId, timeoutMs }) => {
      const socket = new WebSocket(
        `ws://${location.host}/v1/events?organizationId=${
          encodeURIComponent(organizationId)
        }`,
      );
      const frames: Array<Record<string, unknown>> = [];
      const pending: Array<{
        predicate: (frame: Record<string, unknown>) => boolean;
        resolve: (frame: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timer: Parameters<typeof clearTimeout>[0];
      }> = [];
      const failPending = (error: Error) => {
        for (const entry of pending.splice(0)) {
          clearTimeout(entry.timer);
          entry.reject(error);
        }
      };
      socket.addEventListener("message", (event) => {
        let frame: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(String(event.data));
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
          }
          frame = value as Record<string, unknown>;
        } catch {
          return;
        }
        const index = pending.findIndex((entry) => entry.predicate(frame));
        if (index >= 0) {
          const entry = pending.splice(index, 1)[0];
          if (!entry) return;
          clearTimeout(entry.timer);
          entry.resolve(frame);
        } else {
          frames.push(frame);
        }
      });
      socket.addEventListener("error", () => {
        failPending(new Error("SOCKET_ERROR"));
      });
      socket.addEventListener("close", (event) => {
        failPending(new Error(`SOCKET_CLOSED_${event.code}`));
      });

      const openedResolvers = Promise.withResolvers<void>();
      const openTimer = setTimeout(
        () => openedResolvers.reject(new Error("SOCKET_OPEN_TIMEOUT")),
        timeoutMs,
      );
      socket.addEventListener("open", () => {
        clearTimeout(openTimer);
        openedResolvers.resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(openTimer);
        openedResolvers.reject(new Error("SOCKET_OPEN_ERROR"));
      }, { once: true });
      const opened = openedResolvers.promise;
      const waitFor = (
        predicate: (frame: Record<string, unknown>) => boolean,
      ): Promise<Record<string, unknown>> => {
        const index = frames.findIndex(predicate);
        if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!);
        const resolvers = Promise.withResolvers<Record<string, unknown>>();
        const timer = setTimeout(
          () => resolvers.reject(new Error("SOCKET_FRAME_TIMEOUT")),
          timeoutMs,
        );
        pending.push({
          predicate,
          resolve: resolvers.resolve,
          reject: resolvers.reject,
          timer,
        });
        return resolvers.promise;
      };
      const closeSocket = async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const resolvers = Promise.withResolvers<void>();
        const timer = setTimeout(() => resolvers.resolve(), 1_000);
        socket.addEventListener("close", () => {
          clearTimeout(timer);
          resolvers.resolve();
        }, { once: true });
        socket.close();
        await resolvers.promise;
      };

      try {
        await opened;
        const hello = await waitFor((frame) => frame.type === "hello");
        const subscribeRequestId = crypto.randomUUID();
        socket.send(JSON.stringify({
          type: "subscribe",
          requestId: subscribeRequestId,
          scopes: [{ type: "application", id: applicationId }],
          after: null,
        }));
        const cursor = await waitFor((frame) =>
          frame.type === "cursor" && frame.requestId === subscribeRequestId
        );
        const pingRequestId = crypto.randomUUID();
        socket.send(JSON.stringify({ type: "ping", requestId: pingRequestId }));
        const ping = await waitFor((frame) =>
          frame.type === "ping" && frame.requestId === pingRequestId
        );
        const executeRequestId = crypto.randomUUID();
        socket.send(JSON.stringify({
          type: "execute",
          requestId: executeRequestId,
          operation: "tasks.create",
        }));
        const problem = await waitFor((frame) =>
          frame.type === "problem" && frame.requestId === executeRequestId
        );
        return { hello, cursor, ping, problem };
      } finally {
        await closeSocket();
      }
    },
    {
      organizationId: organizationId!,
      applicationId: applicationId!,
      timeoutMs: socketTimeoutMs,
    },
  );

  expect(firstConnection.hello).toMatchObject({
    type: "hello",
    protocolVersion: 1,
  });
  expect(firstConnection.cursor).toMatchObject({ type: "cursor" });
  expect(firstConnection.cursor.cursor).toEqual(expect.any(String));
  expect(firstConnection.ping).toMatchObject({ type: "ping" });
  expect(firstConnection.problem).toMatchObject({
    type: "problem",
    problem: { code: "MALFORMED_REQUEST" },
  });

  const cursor = String(firstConnection.cursor.cursor);
  const replayConnection = await page.evaluate(
    async ({ organizationId, cursor, timeoutMs }) => {
      const socket = new WebSocket(
        `ws://${location.host}/v1/events?organizationId=${
          encodeURIComponent(organizationId)
        }&after=${encodeURIComponent(cursor)}`,
      );
      const frames: Array<Record<string, unknown>> = [];
      const pending: Array<{
        predicate: (frame: Record<string, unknown>) => boolean;
        resolve: (frame: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timer: Parameters<typeof clearTimeout>[0];
      }> = [];
      const failPending = (error: Error) => {
        for (const entry of pending.splice(0)) {
          clearTimeout(entry.timer);
          entry.reject(error);
        }
      };
      socket.addEventListener("message", (event) => {
        let frame: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(String(event.data));
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
          }
          frame = value as Record<string, unknown>;
        } catch {
          return;
        }
        const index = pending.findIndex((entry) => entry.predicate(frame));
        if (index >= 0) {
          const entry = pending.splice(index, 1)[0];
          if (!entry) return;
          clearTimeout(entry.timer);
          entry.resolve(frame);
        } else {
          frames.push(frame);
        }
      });
      socket.addEventListener("error", () => {
        failPending(new Error("SOCKET_ERROR"));
      });
      socket.addEventListener("close", (event) => {
        failPending(new Error(`SOCKET_CLOSED_${event.code}`));
      });
      const openedResolvers = Promise.withResolvers<void>();
      const openTimer = setTimeout(
        () => openedResolvers.reject(new Error("SOCKET_OPEN_TIMEOUT")),
        timeoutMs,
      );
      socket.addEventListener("open", () => {
        clearTimeout(openTimer);
        openedResolvers.resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(openTimer);
        openedResolvers.reject(new Error("SOCKET_OPEN_ERROR"));
      }, { once: true });
      const opened = openedResolvers.promise;
      const waitFor = (
        predicate: (frame: Record<string, unknown>) => boolean,
      ): Promise<Record<string, unknown>> => {
        const index = frames.findIndex(predicate);
        if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!);
        const resolvers = Promise.withResolvers<Record<string, unknown>>();
        const timer = setTimeout(
          () => resolvers.reject(new Error("SOCKET_FRAME_TIMEOUT")),
          timeoutMs,
        );
        pending.push({
          predicate,
          resolve: resolvers.resolve,
          reject: resolvers.reject,
          timer,
        });
        return resolvers.promise;
      };
      const closeSocket = async () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        const resolvers = Promise.withResolvers<void>();
        const timer = setTimeout(() => resolvers.resolve(), 1_000);
        socket.addEventListener("close", () => {
          clearTimeout(timer);
          resolvers.resolve();
        }, { once: true });
        socket.close();
        await resolvers.promise;
      };
      try {
        await opened;
        const hello = await waitFor((frame) => frame.type === "hello");
        const replayCursor = await waitFor((frame) => frame.type === "cursor");
        return { hello, cursor: replayCursor };
      } finally {
        await closeSocket();
      }
    },
    { organizationId: organizationId!, cursor, timeoutMs: socketTimeoutMs },
  );

  expect(replayConnection.hello).toMatchObject({
    type: "hello",
    protocolVersion: 1,
  });
  expect(replayConnection.cursor).toMatchObject({ type: "cursor" });
  expect(replayConnection.cursor.cursor).toEqual(expect.any(String));

  const revokedReconnect = await page.evaluate(
    async ({ organizationId, cursor, timeoutMs }) => {
      const signOut = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const socket = new WebSocket(
        `ws://${location.host}/v1/events?organizationId=${
          encodeURIComponent(organizationId)
        }&after=${encodeURIComponent(cursor)}`,
      );
      const outcomeResolvers = Promise.withResolvers<
        { error: boolean; closeCode: number | null }
      >();
      let error = false;
      const timer = setTimeout(
        () => outcomeResolvers.resolve({ error, closeCode: null }),
        timeoutMs,
      );
      socket.addEventListener("error", () => {
        error = true;
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        outcomeResolvers.resolve({ error, closeCode: event.code });
      }, { once: true });
      const outcome = await outcomeResolvers.promise;
      return { signOutStatus: signOut.status, ...outcome };
    },
    { organizationId: organizationId!, cursor, timeoutMs: socketTimeoutMs },
  );

  expect(revokedReconnect.signOutStatus).toBe(200);
  expect(revokedReconnect.error).toBe(true);
  expect(revokedReconnect.closeCode).toBe(1006);
});
