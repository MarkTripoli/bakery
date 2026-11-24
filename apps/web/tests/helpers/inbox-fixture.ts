import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export type InboxOptions = {
  total?: number;
  unread?: number;
  failRead?: boolean;
  failList?: boolean;
};

const KINDS = [
  { kind: "mention", targetKind: "conversation_message" },
  { kind: "run_completed", targetKind: "run" },
  { kind: "step_failed", targetKind: "run_step" },
  { kind: "document_version", targetKind: "document_version" },
  { kind: "question_asked", targetKind: "question" },
] as const;

type Row = {
  id: string;
  organizationId: string;
  recipientId: string;
  kind: string;
  targetKind: string;
  targetId: string;
  targetAnchor: string | null;
  conversationId: string | null;
  runId: string | null;
  taskId: string | null;
  actor: {
    principalId: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  destination: { available: boolean; title: string | null };
  read: boolean;
  revision: number;
  createdAt: string;
};

export const inboxRowId = (index: number) => uuid(1000 + index);

export const inboxRowSelector = (index: number) =>
  `[id="notification-${inboxRowId(index)}"]`;

export async function inboxFixture(page: Page, options: InboxOptions = {}) {
  await mockAuthenticatedSession(page);
  const total = options.total ?? 70;
  const unread = options.unread ?? 3;
  const now = Date.now();
  const rows: Row[] = Array.from({ length: total }, (_, index) => ({
    id: inboxRowId(index),
    organizationId: MOCK_ORGANIZATION_ID,
    recipientId: uuid(1),
    kind: KINDS[index % KINDS.length].kind,
    targetKind: KINDS[index % KINDS.length].targetKind,
    targetId: uuid(12),
    targetAnchor: null,
    conversationId: null,
    runId: null,
    taskId: uuid(12),
    actor: index % KINDS.length === 0
      ? { principalId: uuid(2), displayName: "Dana Teammate", avatarUrl: null }
      : null,
    destination: { available: true, title: `Task ${index}` },
    read: index >= unread,
    revision: 1,
    createdAt: new Date(now - (index * 40 + 5) * 60_000).toISOString(),
  }));
  const calls = { patches: [] as unknown[], undo: [] as unknown[] };
  let lastBatch: string[] = [];
  const unreadCount = () => rows.filter((row) => !row.read).length;
  const json = (route: import("@playwright/test").Route, body: unknown) =>
    route.fulfill(
      { status: 200, contentType: "application/json", json: body } as never,
    );

  await page.route(
    "**/v1/notifications/count*",
    (route) => json(route, { unread: unreadCount(), revision: 1 }),
  );
  await page.route("**/v1/notifications/read-all/undo", (route) => {
    calls.undo.push(route.request().postDataJSON());
    const restore = rows.filter((row) => lastBatch.includes(row.id));
    for (const row of restore) {
      row.read = false;
      row.revision += 1;
    }
    return json(route, {
      restored: restore.length,
      unread: unreadCount(),
      revision: 2,
    });
  });
  await page.route("**/v1/notifications/read-all", (route) => {
    const body = route.request().postDataJSON() as { readBefore: string };
    const marked = rows.filter((row) =>
      !row.read && new Date(row.createdAt) <= new Date(body.readBefore)
    );
    lastBatch = marked.map((row) => row.id);
    for (const row of marked) {
      row.read = true;
      row.revision += 1;
    }
    return json(route, {
      marked: marked.length,
      remainingUnread: unreadCount(),
      revision: 2,
      batchId: uuid(7000),
    });
  });
  await page.route(/\/v1\/notifications\/[0-9a-f-]{36}$/, (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    const body = request.postDataJSON() as { read: boolean };
    calls.patches.push(body);
    if (options.failRead) {
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "Failed",
          detail: "Failed.",
          status: 500,
          code: "INTERNAL_ERROR",
          retryable: false,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    }
    const id = request.url().split("/").at(-1)!;
    const row = rows.find((one) => one.id === id)!;
    row.read = body.read;
    row.revision += 1;
    return json(route, row);
  });
  await page.route("**/v1/notifications?*", (route) => {
    const url = new URL(route.request().url());
    if (options.failList) {
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "Failed",
          detail: "Failed.",
          status: 500,
          code: "INTERNAL_ERROR",
          retryable: false,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    }
    const filter = url.searchParams.get("filter") ?? "all";
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const filtered = rows.filter((row) =>
      filter === "unread"
        ? !row.read
        : filter === "mentions"
        ? row.kind === "mention"
        : true
    );
    const items = filtered.slice(start, start + limit);
    return json(route, {
      items,
      nextCursor: start + limit < filtered.length
        ? String(start + limit)
        : null,
    });
  });
  return { rows, calls };
}
