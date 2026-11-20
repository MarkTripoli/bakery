import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";
import { uuid } from "./issues-fixture.ts";

const STAMP = "2026-01-01T00:00:00.000Z";

export type Entry = {
  id: number;
  parent: number | null;
  path: string;
  name: string;
  kind: "folder" | "file";
  policy?: "record" | "working" | "scratch" | "library" | "personal" | "system";
  kindName?: string | null;
  mediaType?: string | null;
  sizeBytes?: number | null;
  displayName?: string | null;
  updatedAt?: string;
};

export type Version = {
  revision: number;
  isCurrent: boolean;
  sizeBytes: number;
  contentRemoved?: boolean;
  makerKind?: "person" | "step";
  makerName?: string | null;
  stepName?: string | null;
  workItemTitle?: string | null;
};

export type Use = {
  id: number;
  workItemTitle: string;
  inputName?: string | null;
  revision: number;
};

/** A small tree: the top folders, a project folder, and one document with history. */
export const TREE: Entry[] = [
  {
    id: 10,
    parent: null,
    path: "/projects",
    name: "projects",
    kind: "folder",
    policy: "working",
  },
  {
    id: 11,
    parent: null,
    path: "/shared",
    name: "shared",
    kind: "folder",
    policy: "working",
  },
  {
    id: 12,
    parent: null,
    path: "/users/me",
    name: "me",
    kind: "folder",
    policy: "personal",
    displayName: "Your files",
  },
  {
    id: 13,
    parent: null,
    path: "/library",
    name: "library",
    kind: "folder",
    policy: "library",
  },
  {
    id: 20,
    parent: 10,
    path: "/projects/web-app",
    name: "web-app",
    kind: "folder",
    policy: "record",
  },
  {
    id: 21,
    parent: 10,
    path: "/projects/api",
    name: "api",
    kind: "folder",
    policy: "record",
  },
  {
    id: 30,
    parent: 20,
    path: "/projects/web-app/docs",
    name: "docs",
    kind: "folder",
    policy: "record",
  },
  {
    id: 40,
    parent: 20,
    path: "/projects/web-app/plan.md",
    name: "plan.md",
    kind: "file",
    policy: "record",
    kindName: "Plan",
    mediaType: "text/markdown",
    sizeBytes: 4200,
    updatedAt: "2026-01-02T10:00:00.000Z",
  },
  {
    id: 41,
    parent: 20,
    path: "/projects/web-app/demo.mp4",
    name: "demo.mp4",
    kind: "file",
    policy: "record",
    kindName: null,
    mediaType: "video/mp4",
    sizeBytes: 3_400_000,
    updatedAt: "2026-01-03T10:00:00.000Z",
  },
];

export const VERSIONS: Version[] = [
  {
    revision: 2,
    isCurrent: true,
    sizeBytes: 4200,
    makerKind: "step",
    stepName: "plan",
    workItemTitle: "Fix the login redirect",
  },
  {
    revision: 1,
    isCurrent: false,
    sizeBytes: 3900,
    makerKind: "person",
    makerName: "Ana Reyes",
  },
];

export const USES: Use[] = [
  {
    id: 1,
    workItemTitle: "Fix the login redirect",
    inputName: "/projects/web-app/plan.md",
    revision: 2,
  },
];

export type FilesOptions = {
  tree?: Entry[];
  versions?: Version[];
  uses?: Use[];
  /** Entries per page, to show Load more. */
  pageSize?: number;
  /** A folder read that fails. */
  entriesFail?: boolean;
};

const page_ = (items: unknown[], nextCursor: string | null = null) =>
  JSON.stringify({ items, nextCursor });

const item = (entry: Entry) => ({
  id: uuid(entry.id),
  parentId: entry.parent === null ? null : uuid(entry.parent),
  path: entry.path,
  name: entry.name,
  displayName: entry.displayName ?? null,
  kind: entry.kind,
  policy: entry.policy ?? "record",
  kindName: entry.kindName ?? null,
  mediaType: entry.mediaType ?? null,
  sizeBytes: entry.kind === "file" ? entry.sizeBytes ?? 0 : null,
  artifactId: null,
  contentRemoved: false,
  updatedAt: entry.updatedAt ?? STAMP,
});

/** Stubs the session and the four files reads; returns what was asked. */
export async function filesFixture(page: Page, options: FilesOptions = {}) {
  await mockAuthenticatedSession(page);
  const tree = options.tree ?? TREE;
  const seen = {
    entries: [] as string[],
    versions: 0,
    uses: 0,
    /** The revision each content read asked for; null for the current one. */
    contents: [] as (string | null)[],
    /** The query string of each search read. */
    searches: [] as string[],
  };
  const json = (route: import("@playwright/test").Route, body: string) =>
    route.fulfill({ status: 200, contentType: "application/json", body });

  await page.route(
    (url) => url.pathname === "/v1/storage/roots",
    (route) =>
      json(
        route,
        page_(tree.filter((entry) => entry.parent === null).map(item)),
      ),
  );
  await page.route(
    (url) => /^\/v1\/storage\/folders\/[^/]+\/entries$/.test(url.pathname),
    (route) => {
      const url = new URL(route.request().url());
      const id = url.pathname.split("/")[4]!;
      seen.entries.push(id);
      if (options.entriesFail) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Internal Server Error",
            status: 500,
            code: "INTERNAL",
            retryable: false,
            detail: "failed",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      const all = tree
        .filter((entry) => entry.parent !== null && uuid(entry.parent) === id)
        .sort((a, b) =>
          a.kind === b.kind
            ? a.name.localeCompare(b.name)
            : a.kind === "folder"
            ? -1
            : 1
        );
      const size = options.pageSize ?? 50;
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const slice = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : null;
      return json(route, page_(slice.map(item), next));
    },
  );
  await page.route(
    (url) => /^\/v1\/storage\/files\/[^/]+\/versions$/.test(url.pathname),
    (route) => {
      seen.versions += 1;
      return json(
        route,
        page_((options.versions ?? VERSIONS).map((version) => ({
          id: uuid(500 + version.revision),
          revision: version.revision,
          isCurrent: version.isCurrent,
          createdAt: "2026-01-02T10:00:00.000Z",
          sizeBytes: version.sizeBytes,
          mediaType: "text/markdown",
          sha256: "0".repeat(64),
          contentRemoved: version.contentRemoved ?? false,
          removedAt: version.contentRemoved ? "2026-01-05T10:00:00.000Z" : null,
          makerKind: version.makerKind ?? "person",
          makerPrincipalId: uuid(8800),
          makerName: version.makerName ?? null,
          stepId: version.makerKind === "step" ? uuid(600) : null,
          stepName: version.stepName ?? null,
          runId: version.makerKind === "step" ? uuid(601) : null,
          workItemId: version.makerKind === "step" ? uuid(602) : null,
          workItemTitle: version.workItemTitle ?? null,
          sessionId: null,
        }))),
      );
    },
  );
  await page.route(
    (url) => /^\/v1\/storage\/file-versions\/[^/]+$/.test(url.pathname),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[4]!;
      // The versions of the plan: revision 1 is uuid(501), the current 2 is uuid(502).
      const revision = id === uuid(501) ? 1 : id === uuid(502) ? 2 : null;
      const plan = tree.find((entry) => entry.id === 40);
      if (revision === null || plan === undefined) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Not Found",
            status: 404,
            code: "RESOURCE_NOT_FOUND",
            retryable: false,
            detail: "No such version.",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      return json(
        route,
        JSON.stringify({
          file: item(plan),
          versionId: id,
          revision,
          isCurrent: revision === 2,
        }),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/files/search",
    (route) => {
      const url = new URL(route.request().url());
      seen.searches.push(url.search);
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const under = url.searchParams.get("path");
      const group = url.searchParams.get("mediaGroup");
      const groupOf = (type: string | null | undefined) =>
        type === undefined || type === null
          ? null
          : type.startsWith("video/")
          ? "video"
          : type.startsWith("image/")
          ? "image"
          : type.startsWith("audio/")
          ? "audio"
          : type.startsWith("text/")
          ? "text"
          : "other";
      const hits = tree
        .filter((entry) => entry.kind === "file")
        .filter((entry) => entry.name.toLowerCase().includes(query))
        .filter((entry) => under === null || entry.path.startsWith(`${under}/`))
        .filter((entry) => group === null || groupOf(entry.mediaType) === group)
        .map((entry) => ({
          source: "files",
          entryId: uuid(entry.id),
          path: entry.path,
          name: entry.name,
          kind: entry.kindName ?? "File",
          mediaType: entry.mediaType ?? null,
          mediaGroup: groupOf(entry.mediaType),
          sizeBytes: entry.sizeBytes ?? null,
          versionId: uuid(500 + entry.id),
          producerId: uuid(8800),
          producerKind: "person",
          producerName: "Ana Reyes",
          producerTaskId: null,
          producerTaskTitle: null,
          nameMatchStart: null,
          nameMatchLength: null,
          createdAt: STAMP,
        }));
      return json(route, page_(hits));
    },
  );
  await page.route(
    (url) => /^\/v1\/storage\/files\/[^/]+\/content$/.test(url.pathname),
    (route) => {
      const revision = new URL(route.request().url()).searchParams.get(
        "revision",
      );
      seen.contents.push(revision);
      const bytes = Buffer.from(
        revision === "1"
          ? "# Plan\n\nThe first draft of the plan."
          : "# Plan\n\nThe current plan: fix the redirect, then add the test.",
      );
      return route.fulfill({
        status: 200,
        body: bytes,
        headers: {
          "content-type": "text/markdown",
          "content-length": String(bytes.length),
          etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
        },
      });
    },
  );
  await page.route(
    (url) => /^\/v1\/storage\/files\/[^/]+\/uses$/.test(url.pathname),
    (route) => {
      seen.uses += 1;
      return json(
        route,
        page_((options.uses ?? USES).map((use) => ({
          id: uuid(700 + use.id),
          workItemId: uuid(602),
          workItemTitle: use.workItemTitle,
          runId: uuid(601),
          inputName: use.inputName ?? null,
          versionId: uuid(500 + use.revision),
          revision: use.revision,
          usedAt: "2026-01-04T10:00:00.000Z",
        }))),
      );
    },
  );
  return { seen, organizationId: MOCK_ORGANIZATION_ID };
}
