import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { DEMO_WEBM, STANDUP_WEBM } from "./media-fixtures.ts";
import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";
import { uuid } from "./issues-fixture.ts";

/** A table of the CRC-32 the PNG format asks for each chunk. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A 720x405 picture of three boxes joined by lines, built here so the fixture
 * carries no binary: opening it full size has to look like something.
 */
function diagramPng(): Buffer {
  const width = 720;
  const height = 405;
  const boxes = [
    { x: 60, y: 140, w: 170, h: 120, color: [91, 110, 225] },
    { x: 275, y: 140, w: 170, h: 120, color: [74, 160, 140] },
    { x: 490, y: 140, w: 170, h: 120, color: [225, 150, 80] },
  ];
  const row = Buffer.alloc(1 + width * 3);
  const raw = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) {
    row.fill(0);
    for (let x = 0; x < width; x++) {
      let color = [244, 246, 250];
      if (y >= 196 && y <= 203 && x >= 230 && x <= 490) color = [150, 158, 175];
      for (const box of boxes) {
        if (
          x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
        ) {
          color = box.color;
        }
      }
      row[1 + x * 3] = color[0]!;
      row[2 + x * 3] = color[1]!;
      row[3 + x * 3] = color[2]!;
    }
    row.copy(raw, y * (1 + width * 3));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

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
  artifactId?: number | null;
  contentRemoved?: boolean;
  pinned?: boolean;
};

export type Version = {
  revision: number;
  isCurrent: boolean;
  sizeBytes: number;
  contentRemoved?: boolean;
  makerKind?: "person" | "step" | "agent";
  makerName?: string | null;
  agentName?: string | null;
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
    artifactId: 700,
    updatedAt: "2026-01-02T10:00:00.000Z",
  },
  {
    id: 41,
    parent: 20,
    path: "/projects/web-app/demo.webm",
    name: "demo.webm",
    kind: "file",
    policy: "record",
    kindName: null,
    mediaType: "video/webm",
    sizeBytes: 3_400_000,
    updatedAt: "2026-01-03T10:00:00.000Z",
  },
  {
    id: 31,
    parent: 20,
    path: "/projects/web-app/media",
    name: "media",
    kind: "folder",
    policy: "record",
  },
  {
    id: 42,
    parent: 31,
    path: "/projects/web-app/media/notes.txt",
    name: "notes.txt",
    kind: "file",
    policy: "record",
    kindName: "Note",
    mediaType: "text/plain",
    sizeBytes: 5_000_000,
    updatedAt: "2026-01-04T10:00:00.000Z",
  },
  {
    id: 43,
    parent: 31,
    path: "/projects/web-app/media/diagram.png",
    name: "diagram.png",
    kind: "file",
    policy: "record",
    kindName: "Image",
    mediaType: "image/png",
    sizeBytes: 90,
    updatedAt: "2026-01-04T11:00:00.000Z",
  },
  {
    id: 44,
    parent: 31,
    path: "/projects/web-app/media/old.md",
    name: "old.md",
    kind: "file",
    policy: "record",
    kindName: "Note",
    mediaType: "text/markdown",
    sizeBytes: 300,
    contentRemoved: true,
    updatedAt: "2026-01-04T12:00:00.000Z",
  },
  {
    id: 45,
    parent: 31,
    path: "/projects/web-app/media/broken.md",
    name: "broken.md",
    kind: "file",
    policy: "record",
    kindName: "Note",
    mediaType: "text/markdown",
    sizeBytes: 300,
    updatedAt: "2026-01-04T13:00:00.000Z",
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

/** An agent's version with no person recorded, beside one with no agent name. */
export const AGENT_NO_PERSON_VERSIONS: Version[] = [
  {
    revision: 2,
    isCurrent: true,
    sizeBytes: 4200,
    makerKind: "agent",
    makerName: null,
    agentName: "Reviewer",
  },
  {
    revision: 1,
    isCurrent: false,
    sizeBytes: 3900,
    makerKind: "agent",
    makerName: null,
    agentName: null,
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
  /** Every folder read after the first page fails. */
  failAfterFirstPage?: boolean;
  /** More people than one page of 100, to show the Made by filter reads every page. */
  principalCount?: number;
  /** An account that was switched off, whose files are still there. */
  disabledPrincipal?: boolean;
  /** More kinds than one page of 100, to show the Kind filter reads every page. */
  kindCount?: number;
  /**
   * A file whose stored bytes do not hash to the digest its record names, so
   * every read of it is refused as a mismatch (#437).
   */
  mismatchId?: number;
};

/** A list as the server pages it: `limit` at a time, the cursor an offset. */
const paged = (items: unknown[], url: URL) => {
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const offset = Number(url.searchParams.get("cursor") ?? 0);
  const next = offset + limit;
  return JSON.stringify({
    items: items.slice(offset, next),
    nextCursor: next < items.length ? String(next) : null,
  });
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
  artifactId: entry.artifactId === undefined || entry.artifactId === null
    ? null
    : uuid(entry.artifactId),
  pinned: entry.pinned ?? false,
  contentRemoved: entry.contentRemoved ?? false,
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
    /** The query string of each facts read. */
    facts: [] as string[],
    /** The Range header of each content read that sent one: what a player asked for. */
    ranges: [] as string[],
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
      if (
        options.entriesFail ||
        (options.failAfterFirstPage && url.searchParams.has("cursor"))
      ) {
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
          sessionId: version.makerKind === "agent" ? uuid(603) : null,
          agentName: version.agentName ?? null,
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
    (url) => url.pathname === "/v1/files/library",
    (route) => {
      const path = new URL(route.request().url()).searchParams.get("path") ??
        "/library";
      const item = (
        section: string,
        slug: string,
        name: string,
        kind: string,
        id: number,
      ) => ({
        type: "item",
        id: uuid(id),
        path: `/library/${section}/${slug}`,
        name,
        kind,
        createdAt: STAMP,
      });
      const sections: Record<string, unknown[]> = {
        "/library/kinds": [
          item("kinds", "plan", "Plan", "kind", 7004),
          item("kinds", "review", "Review", "kind", 7005),
          ...Array.from(
            { length: options.kindCount ?? 0 },
            (_, n) =>
              item(
                "kinds",
                `kind-${n + 1}`,
                `Kind ${n + 1}`,
                "kind",
                8000 + n + 1,
              ),
          ),
        ],
        "/library/workflows": [
          item("workflows", "ship", "Ship a change", "workflow", 7001),
          item("workflows", "triage", "Triage issues", "workflow", 7002),
        ],
        "/library/agents": [item("agents", "coder", "Coder", "agent", 7003)],
        "/library": ["workflows", "agents"].map((slug) => ({
          type: "folder",
          id: null,
          path: `/library/${slug}`,
          name: slug,
          kind: null,
          createdAt: null,
        })),
      };
      const entries = sections[path];
      if (entries === undefined) {
        return route.fulfill({
          status: 404,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Not Found",
            status: 404,
            code: "RESOURCE_NOT_FOUND",
            retryable: false,
            detail: "not found",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      return json(route, paged(entries, new URL(route.request().url())));
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/principals",
    (route) =>
      json(
        route,
        paged(
          [
            { id: 8800, type: "human", name: "Ana Reyes", off: false },
            { id: 8801, type: "worker", name: "Build worker", off: false },
            ...(options.disabledPrincipal
              ? [{ id: 8802, type: "worker", name: "Old Bot", off: true }]
              : []),
            ...Array.from({ length: options.principalCount ?? 0 }, (_, n) => ({
              id: 9000 + n + 1,
              type: "human",
              name: `Person ${n + 1}`,
              off: false,
            })),
          ].map((principal) => ({
            id: uuid(principal.id),
            principalType: principal.type,
            displayName: principal.name,
            createdByPrincipalId: null,
            disabledAt: principal.off ? STAMP : null,
            createdAt: STAMP,
            updatedAt: STAMP,
            version: 1,
          })),
          new URL(route.request().url()),
        ),
      ),
  );
  // What the plan files record, as the facts list answers it: each key with
  // each value it holds and how many files hold it. plan.md holds risk:high.
  const FACTS = [
    { kind: "plan", key: "risk", value: "high", files: 1 },
    { kind: "plan", key: "risk", value: "low", files: 2 },
    { kind: "plan", key: "team", value: "web", files: 1 },
  ];
  await page.route(
    (url) => url.pathname === "/v1/files/facts",
    (route) => {
      const url = new URL(route.request().url());
      seen.facts.push(url.search);
      const kind = url.searchParams.get("kind");
      return json(
        route,
        page_(FACTS.filter((fact) => kind === null || fact.kind === kind)),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/v1/files/search",
    (route) => {
      const url = new URL(route.request().url());
      seen.searches.push(url.search);
      const kindFilter = url.searchParams.get("kind");
      const producerFilter = url.searchParams.get("producerId");
      const factKey = url.searchParams.get("factKey");
      const factValue = url.searchParams.get("factValue");
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
      if (
        under !== null &&
        (under === "/library" || under.startsWith("/library/"))
      ) {
        const libraryHits = [
          ["workflows", "ship", "Ship a change", "workflow", 7001],
          ["workflows", "triage", "Triage issues", "workflow", 7002],
          ["agents", "coder", "Coder", "agent", 7003],
        ]
          .map(([section, slug, name, kind, id]) => ({
            source: "library",
            entryId: null,
            itemId: uuid(id as number),
            path: `/library/${section}/${slug}`,
            name: name!,
            kind: kind!,
            mediaType: null,
            mediaGroup: null,
            sizeBytes: null,
            versionId: null,
            producerId: null,
            producerKind: null,
            producerName: null,
            producerTaskId: null,
            producerTaskTitle: null,
            nameMatchStart: null,
            nameMatchLength: null,
            createdAt: STAMP,
          }))
          .filter((hit) => hit.path.startsWith(`${under}/`))
          .filter((hit) => hit.name.toLowerCase().includes(query));
        return json(route, page_(libraryHits));
      }
      const hits = tree
        .filter((entry) => entry.kind === "file")
        .filter((entry) => entry.name.toLowerCase().includes(query))
        .filter((entry) => under === null || entry.path.startsWith(`${under}/`))
        .filter((entry) => group === null || groupOf(entry.mediaType) === group)
        .filter((entry) =>
          kindFilter === null || entry.kindName?.toLowerCase() === kindFilter
        )
        .filter(() => producerFilter === null || producerFilter === uuid(8800))
        // Only plan.md records a fact in this tree: risk is high.
        .filter((entry) =>
          factKey === null ||
          (entry.name === "plan.md" && factKey === "risk" &&
            factValue === "high")
        )
        .map((entry) => ({
          source: "files",
          entryId: uuid(entry.id),
          itemId: null,
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
      const fileId = new URL(route.request().url()).pathname.split("/")[4]!;
      if (
        options.mismatchId !== undefined &&
        fileId === uuid(options.mismatchId)
      ) {
        return route.fulfill({
          status: 409,
          // The client only reads a failure as a problem when it is served as
          // one; any other content type becomes an unexplained protocol error.
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Conflict",
            status: 409,
            code: "ARTIFACT_CONTENT_MISMATCH",
            retryable: false,
            detail: "the stored bytes do not hash to the recorded digest",
            requestId: crypto.randomUUID(),
            traceId: crypto.randomUUID(),
          }),
        });
      }
      if (fileId === uuid(45)) {
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
      // A player's reads: the whole file, or the Range it asked for, as a real
      // server answers it (206 with Content-Range; 416 past the end).
      const media = fileId === uuid(41)
        ? { bytes: DEMO_WEBM, type: "video/webm" }
        : fileId === uuid(47)
        ? { bytes: STANDUP_WEBM, type: "audio/webm" }
        // A file that says it is video and is not: no player can decode it.
        : fileId === uuid(48)
        ? {
          bytes: Buffer.from(
            "This is not a video, so no player can decode it.",
          ),
          type: "video/webm",
        }
        : null;
      if (media !== null) {
        const range = route.request().headers()["range"];
        const total = media.bytes.length;
        const common = {
          "content-type": media.type,
          "accept-ranges": "bytes",
        };
        if (range === undefined) {
          return route.fulfill({
            status: 200,
            body: media.bytes,
            headers: { ...common, "content-length": String(total) },
          });
        }
        seen.ranges.push(range);
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = match?.[2]
          ? Math.min(Number(match[2]), total - 1)
          : total - 1;
        if (start >= total || start > end) {
          return route.fulfill({
            status: 416,
            headers: { ...common, "content-range": `bytes */${total}` },
          });
        }
        const slice = media.bytes.subarray(start, end + 1);
        return route.fulfill({
          status: 206,
          body: slice,
          headers: {
            ...common,
            "content-length": String(slice.length),
            "content-range": `bytes ${start}-${end}/${total}`,
          },
        });
      }
      if (fileId === uuid(49)) {
        // Forty lines: more than the panel shows, so opening it has something to add.
        const text = Buffer.from(
          Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join(
            "\n",
          ),
        );
        return route.fulfill({
          status: 200,
          body: text,
          headers: {
            "content-type": "text/plain",
            "content-length": String(text.length),
            etag: `"${createHash("sha256").update(text).digest("hex")}"`,
          },
        });
      }
      if (fileId === uuid(43)) {
        // A real picture, wide enough that opening it full size is visible.
        const png = diagramPng();
        return route.fulfill({
          status: 200,
          body: png,
          headers: {
            "content-type": "image/png",
            "content-length": String(png.length),
            etag: `"${createHash("sha256").update(png).digest("hex")}"`,
          },
        });
      }
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
