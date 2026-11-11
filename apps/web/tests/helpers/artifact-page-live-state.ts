import { expect, test, type WebSocketRoute } from "@playwright/test";
import {
  ARTIFACT,
  ARTIFACT_ID,
  COMMENT_ID,
  CONTENT,
  json,
  openComments,
  PATH,
  stubArtifactPage,
  version,
  VERSION_ID,
} from "./artifact-page-fixture.ts";

const NEWEST_VERSION_ID = "00000000-0000-4000-8000-000000000109";

type Stream = {
  readonly subscribes: Record<string, unknown>[];
  readonly connections: () => number;
  readonly push: () => void;
  readonly drop: () => void;
  /** The server rejects the subscription: a problem frame, then close. */
  readonly reject: () => void;
  /** While set, every new subscription is answered with the problem frame. */
  readonly rejectSubscriptions: (on: boolean) => void;
};

/** A task-scope event socket: each push is a cursor frame, as the server sends. */
async function mockEvents(
  page: import("@playwright/test").Page,
): Promise<Stream> {
  const sockets: WebSocketRoute[] = [];
  const requests = new Map<WebSocketRoute, string>();
  const subscribes: Record<string, unknown>[] = [];
  let sequence = 1;
  let rejecting = false;
  const problem = (socket: WebSocketRoute) => {
    socket.send(JSON.stringify({
      type: "problem",
      requestId: requests.get(socket),
      problem: {
        type: "https://bakery.example/problems/forbidden",
        title: "FORBIDDEN",
        detail: "Stubbed FORBIDDEN.",
        status: 403,
        code: "FORBIDDEN",
        requestId: ARTIFACT.taskId,
        traceId: ARTIFACT_ID,
        retryable: false,
      },
    }));
    socket.close();
  };
  const cursor = (socket: WebSocketRoute) => {
    sequence += 1;
    socket.send(JSON.stringify({
      type: "cursor",
      requestId: requests.get(socket),
      cursor: `cursor-${sequence}`,
      highwater: String(sequence),
    }));
  };
  await page.routeWebSocket(/\/v1\/events/, (socket) => {
    sockets.push(socket);
    socket.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectionId: crypto.randomUUID(),
      highwater: "1",
      retainedFrom: "0",
    }));
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type !== "subscribe") return;
      subscribes.push(frame);
      requests.set(socket, String(frame.requestId));
      if (rejecting) problem(socket);
      else cursor(socket);
    });
  });
  return {
    subscribes,
    connections: () => sockets.length,
    push: () => {
      const socket = sockets.at(-1);
      if (socket) cursor(socket);
    },
    drop: () => sockets.at(-1)?.close(),
    reject: () => {
      const socket = sockets.at(-1);
      if (socket) problem(socket);
    },
    rejectSubscriptions: (on) => {
      rejecting = on;
    },
  };
}

/** After this call the server reports revision 3 as the artifact's newest. */
async function publishNewest(page: import("@playwright/test").Page) {
  const newest = {
    ...version(CONTENT),
    id: NEWEST_VERSION_ID,
    revision: 3,
  };
  const original = version(CONTENT);
  await page.route(
    `**/v1/artifacts/${ARTIFACT_ID}`,
    (route) =>
      route.fulfill(json({ ...ARTIFACT, currentVersionId: NEWEST_VERSION_ID })),
  );
  await page.route(
    `**/v1/artifacts/${ARTIFACT_ID}/versions**`,
    (route) =>
      route.fulfill(json({
        items: [newest, original, {
          ...original,
          id: "00000000-0000-4000-8000-000000000103",
          revision: 1,
        }],
        nextCursor: null,
      })),
  );
}

test("a newer revision shows the stale notice and keeps the viewed revision and deep links", async ({ page }) => {
  await stubArtifactPage(page);
  const stream = await mockEvents(page);
  await page.goto(`${PATH}?version=${VERSION_ID}&comment=${COMMENT_ID}`);
  await expect.poll(() => stream.subscribes.length).toBe(1);
  expect(stream.subscribes[0].scopes).toEqual([
    { type: "task", id: ARTIFACT.taskId },
  ]);
  await openComments(page);
  await expect(page.getByText("A newer revision is available")).toHaveCount(0);

  await publishNewest(page);
  stream.push();
  await expect(page.getByText("A newer revision is available", {
    exact: true,
  })).toBeVisible();
  await expect(
    page.getByText(/You are reading revision 2\. Your selection and comment/),
  ).toBeVisible();
  // The reader stays on the immutable revision and its deep links.
  const search = new URL(page.url()).searchParams;
  expect(search.get("version")).toBe(VERSION_ID);
  expect(search.get("comment")).toBe(COMMENT_ID);
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toContainText(CONTENT.trim());

  const link = page.getByTestId("artifact-retrieval-open-newest");
  await expect(link).toHaveText("Open revision 3");
  await expect(link).toHaveAttribute(
    "href",
    `${PATH}?version=${NEWEST_VERSION_ID}`,
  );
  await link.click();
  await expect(page).toHaveURL(new RegExp(`version=${NEWEST_VERSION_ID}`));
  await expect(page.getByText("A newer revision is available")).toHaveCount(0);
});

test("a dropped event socket shows the reconnecting notice until the stream resumes", async ({ page }) => {
  await stubArtifactPage(page);
  const stream = await mockEvents(page);
  await page.goto(PATH);
  await expect.poll(() => stream.subscribes.length).toBe(1);
  await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
  await expect(page.getByText("Reconnecting", { exact: true })).toHaveCount(0);

  stream.drop();
  await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Showing the last durable state\. Live updates resume/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry connection" }))
    .toBeVisible();
  // The page keeps serving the last verified revision while it reconnects.
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toContainText(CONTENT.trim());

  await expect.poll(() => stream.connections(), { timeout: 10_000 })
    .toBeGreaterThan(1);
  await expect(page.getByText("Reconnecting", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
});

test("a socket that never connected stays silent and the page keeps working", async ({ page }) => {
  await stubArtifactPage(page);
  await page.routeWebSocket(/\/v1\/events/, (socket) => socket.close());
  await page.goto(PATH);
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toContainText(CONTENT.trim());
  await expect(page.getByText("Reconnecting", { exact: true })).toHaveCount(0);
});

test("retry after the server rejects the socket reconnects and clears the notice", async ({ page }) => {
  await stubArtifactPage(page);
  const stream = await mockEvents(page);
  await page.goto(PATH);
  await expect.poll(() => stream.subscribes.length).toBe(1);

  stream.reject();
  await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();
  // A terminal rejection is never retried on its own.
  await page.waitForTimeout(2500);
  expect(stream.connections()).toBe(1);

  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect.poll(() => stream.connections()).toBe(2);
  await expect.poll(() => stream.subscribes.length).toBe(2);
  await expect(page.getByText("Reconnecting", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toContainText(CONTENT.trim());
});

test("a retry that is rejected again keeps the reconnecting notice", async ({ page }) => {
  await stubArtifactPage(page);
  const stream = await mockEvents(page);
  await page.goto(PATH);
  await expect.poll(() => stream.subscribes.length).toBe(1);

  stream.rejectSubscriptions(true);
  stream.reject();
  await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect.poll(() => stream.connections()).toBe(2);
  await expect.poll(() => stream.subscribes.length).toBe(2);
  // The second socket was refused too: the page is still disconnected.
  await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry connection" }))
    .toBeVisible();
  await expect(page.locator('[data-ui-component="artifactViewer"]'))
    .toContainText(CONTENT.trim());
});

test("an in-flight download survives a newer revision arriving", async ({ page }) => {
  await stubArtifactPage(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let armed = false;
  let held = 0;
  await page.route("**/v1/artifact-versions/**/content", async (route) => {
    if (armed && held === 0) {
      held += 1;
      await gate;
      const current = version(CONTENT);
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": current.mediaType,
          "content-length": String(current.sizeBytes),
          "content-disposition": 'attachment; filename="artifact.txt"',
          etag: `"${current.sha256}"`,
        },
        body: CONTENT,
      });
      return;
    }
    await route.fallback();
  });
  const stream = await mockEvents(page);
  await page.goto(PATH);
  await expect.poll(() => stream.subscribes.length).toBe(1);
  await expect(page.getByTestId("artifact-retrieval-download")).toBeEnabled();

  armed = true;
  const download = page.waitForEvent("download");
  await page.getByTestId("artifact-retrieval-download").click();
  await expect.poll(() => held).toBe(1);
  await publishNewest(page);
  stream.push();
  await expect(page.getByText("A newer revision is available", {
    exact: true,
  })).toBeVisible();
  release();
  expect((await download).suggestedFilename()).toMatch(/-r2\./);
  await expect(page.getByTestId("artifact-retrieval-download-verified"))
    .toBeVisible();
});
