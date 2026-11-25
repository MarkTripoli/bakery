import type { Page, Route } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const EDIT = {
  skill: uuid(701),
  version: uuid(711),
  created: uuid(702),
  file: (n: number) => uuid(720 + n),
} as const;

export type EditFile = {
  readonly path: string;
  readonly text: string;
  readonly mediaType?: string;
  readonly isExecutable?: boolean;
};

export type EditProblem = {
  readonly file: string | null;
  readonly line: number | null;
  readonly code: string;
  readonly message: string;
};

export type EditOptions = {
  readonly role?: "admin" | "developer";
  readonly scope?: "global" | "organization" | "personal";
  readonly hasDraft?: boolean;
  readonly baseRevision?: number | null;
  readonly files?: readonly EditFile[];
  readonly problems?: readonly EditProblem[];
  readonly draftStatus?: number;
  readonly createStatus?: number;
  readonly saveStatus?: number;
};

export type Call = {
  readonly method: string;
  readonly path: string;
  readonly ifMatch: string | null;
  readonly body: Record<string, unknown> | null;
};

const DEFAULT_FILES: readonly EditFile[] = [
  {
    path: "SKILL.md",
    text: "# House style\n\nWrite in plain words.\n",
    mediaType: "text/markdown",
  },
  {
    path: "examples/good-answer.md",
    text: "A short, clear answer.\n",
    mediaType: "text/markdown",
  },
  {
    path: "assets/logo.bin",
    text: "binary",
    mediaType: "application/octet-stream",
  },
];

const STAMP = "2026-11-22T12:00:00.000Z";
const HASH = "a".repeat(64);

export async function skillEditorFixture(
  page: Page,
  options: EditOptions = {},
) {
  await mockAuthenticatedSession(page);
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organizationId: MOCK_ORGANIZATION_ID,
          role: options.role ?? "developer",
          capabilities: [],
        }),
      }),
  );
  const calls: Call[] = [];
  const state = {
    open: options.hasDraft ?? true,
    version: 1,
    entryPath: "SKILL.md",
    license: null as string | null,
    activeRevision: 2,
    files: (options.files ?? DEFAULT_FILES).map((file, index) => ({
      id: EDIT.file(index),
      path: file.path,
      mediaType: file.mediaType ?? "text/markdown",
      isExecutable: file.isExecutable ?? false,
      content: Buffer.from(file.text, "utf8"),
    })),
    nextFile: 50,
    conflictOnce: false,
  };
  const draft = () => ({
    id: uuid(703),
    skillId: EDIT.skill,
    baseVersionId: options.baseRevision === null ? null : EDIT.version,
    baseRevision: options.baseRevision === undefined ? 2 : options.baseRevision,
    entryPath: state.entryPath,
    license: state.license,
    files: state.files.map((file) => ({
      id: file.id,
      path: file.path,
      mediaType: file.mediaType,
      isExecutable: file.isExecutable,
      sizeBytes: file.content.length,
      sha256: HASH,
    })),
    totalBytes: state.files.reduce((sum, file) => sum + file.content.length, 0),
    version: state.version,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  const skill = (id: string, name: string) => ({
    id,
    sourceId: null,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    description: null,
    activeVersionId: state.activeRevision === 0 ? null : EDIT.version,
    activeRevision: state.activeRevision === 0 ? null : state.activeRevision,
    enabled: true,
    scope: options.scope ?? "personal",
    ownerPrincipalId: (options.scope ?? "personal") === "personal"
      ? MOCK_PRINCIPAL_ID
      : null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: STAMP,
    version: 1,
    copiedFromSkillId: null,
    copiedFromVersionId: null,
  });
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  const problem = (route: Route, status: number) =>
    route.fulfill({
      status,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Problem",
        status,
        detail: "Problem",
      }),
    });

  await page.route("**/v1/skills**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (method !== "GET") {
      calls.push({
        method,
        path,
        ifMatch: request.headers()["if-match"] ?? null,
        body: request.postDataJSON() as Record<string, unknown> | null,
      });
    }
    const draftBase = `/v1/skills/${EDIT.skill}/draft`;
    if (path === "/v1/skills" && method === "POST") {
      if (options.createStatus !== undefined) {
        return problem(route, options.createStatus);
      }
      const body = request.postDataJSON() as { name: string };
      return json(route, skill(EDIT.created, body.name), 201);
    }
    if (path === `/v1/skills/${EDIT.created}/draft` && method === "POST") {
      state.open = true;
      state.files = [];
      state.entryPath = "SKILL.md";
      return json(route, {
        ...draft(),
        skillId: EDIT.created,
        baseRevision: null,
        baseVersionId: null,
      });
    }
    if (path === `/v1/skills/${EDIT.created}`) {
      return json(route, skill(EDIT.created, "New skill"));
    }
    if (path === `/v1/skills/${EDIT.skill}`) {
      return json(route, skill(EDIT.skill, "House style"));
    }
    if (path === draftBase && method === "GET") {
      if (options.draftStatus !== undefined) {
        return problem(route, options.draftStatus);
      }
      return state.open ? json(route, draft()) : problem(route, 404);
    }
    if (path === draftBase && method === "POST") {
      state.open = true;
      return json(route, draft());
    }
    if (path === draftBase && method === "PATCH") {
      const body = request.postDataJSON() as {
        entryPath?: string;
        license?: string;
      };
      if (body.entryPath !== undefined) state.entryPath = body.entryPath;
      if (body.license !== undefined) state.license = body.license;
      state.version += 1;
      return json(route, draft());
    }
    if (path === draftBase && method === "DELETE") {
      state.open = false;
      return route.fulfill({ status: 204 });
    }
    if (path === `${draftBase}/check`) {
      const problems = options.problems ?? [];
      return json(route, {
        ok: problems.length === 0,
        problems,
        draftVersion: state.version,
      });
    }
    if (path === `${draftBase}/publish`) {
      state.activeRevision += 1;
      state.open = false;
      return json(route, {
        id: uuid(712),
        skillId: EDIT.skill,
        revision: state.activeRevision,
        sourceRevision: "draft",
        digest: "sha256:abcdef",
        entryPath: state.entryPath,
        manifest: { schemaVersion: 1, entryPath: state.entryPath, files: [] },
        status: "published",
        createdBy: MOCK_PRINCIPAL_ID,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
        publishedAt: STAMP,
        label: null,
      });
    }
    if (path === `${draftBase}/files` && method === "POST") {
      if (options.saveStatus !== undefined || state.conflictOnce) {
        state.conflictOnce = false;
        return problem(route, options.saveStatus ?? 412);
      }
      const body = request.postDataJSON() as {
        path: string;
        mediaType: string;
        isExecutable?: boolean;
        contentBase64: string;
      };
      const content = Buffer.from(body.contentBase64, "base64");
      const existing = state.files.find((file) => file.path === body.path);
      if (existing) {
        existing.content = content;
        existing.mediaType = body.mediaType;
        existing.isExecutable = body.isExecutable ?? false;
      } else {
        state.files.push({
          id: EDIT.file(state.nextFile++),
          path: body.path,
          mediaType: body.mediaType,
          isExecutable: body.isExecutable ?? false,
          content,
        });
      }
      state.version += 1;
      return json(route, draft());
    }
    if (path === `${draftBase}/files/rename`) {
      const body = request.postDataJSON() as { path: string; newPath: string };
      const file = state.files.find((item) => item.path === body.path);
      if (file) file.path = body.newPath;
      state.version += 1;
      return json(route, draft());
    }
    const fileMatch = path.match(/\/draft\/files\/([0-9a-f-]{36})$/);
    if (fileMatch) {
      const file = state.files.find((item) => item.id === fileMatch[1]);
      if (!file) return problem(route, 404);
      if (method === "DELETE") {
        state.files = state.files.filter((item) => item !== file);
        state.version += 1;
        return json(route, draft());
      }
      return json(route, {
        id: file.id,
        path: file.path,
        mediaType: file.mediaType,
        isExecutable: file.isExecutable,
        sizeBytes: file.content.length,
        sha256: HASH,
        contentBase64: file.content.toString("base64"),
      });
    }
    if (path.endsWith("/versions") || path.endsWith("/used-by")) {
      return json(route, { items: [], nextCursor: null });
    }
    if (path.endsWith("/use-grants")) {
      return json(route, { items: [], nextCursor: null });
    }
    if (path === "/v1/skills" && method === "GET") {
      return json(route, {
        items: [skill(EDIT.skill, "House style")],
        nextCursor: null,
      });
    }
    return problem(route, 404);
  });
  return {
    calls,
    state,
    failNextSaveWithConflict: () => {
      state.conflictOnce = true;
    },
  };
}
