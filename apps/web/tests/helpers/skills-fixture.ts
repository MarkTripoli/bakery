import type { Page, Route } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

/**
 * Stubs for the Skills tab and one skill (#74 slice 1): the list with its
 * scope filter and name search, one skill, its versions, what uses it, who may
 * use a private one, and a source. Every object has the full contract shape:
 * the client checks responses as they arrive.
 */

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A fixed moment the tab's "changed" times are measured against. */
export const NOW = "2026-11-22T12:00:00.000Z";
const hoursAgo = (hours: number) =>
  new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

export const IDS = {
  /** Shared by Bakery, added from a git source. */
  writingGuide: uuid(101),
  /** The organization's, written here, with a description and users. */
  releaseNotes: uuid(102),
  /** Private, copied from Writing guide version 1, shared with a workflow. */
  houseStyle: uuid(103),
  /** The organization's, turned off. */
  oldChecklist: uuid(104),
  /** Private, no version in use yet. */
  scratch: uuid(105),
  /** The organization's, with a very long name. */
  longName: uuid(106),
  /** Private, copied from a skill the reader cannot open. */
  toneOfVoice: uuid(107),
  source: uuid(301),
  /** A skill nobody can see. */
  missing: uuid(999),
} as const;

export const LONG_NAME =
  "Summarise a customer conversation thread into a short handover note for the next person on the support rota";

type Skill = {
  id: string;
  sourceId: string | null;
  slug: string;
  name: string;
  description: string | null;
  activeVersionId: string | null;
  activeRevision: number | null;
  enabled: boolean;
  scope: "global" | "organization" | "personal";
  ownerPrincipalId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  copiedFromSkillId: string | null;
  copiedFromVersionId: string | null;
};

/** The id of revision `revision` of a skill, the same everywhere it is named. */
export const versionId = (skill: string, revision: number) =>
  uuid(Number(skill.slice(-3)) * 100 + 10_000 + revision);

const skill = (
  id: string,
  name: string,
  scope: Skill["scope"],
  revision: number | null,
  changedHoursAgo: number,
  extra: Partial<Skill> = {},
): Skill => ({
  id,
  sourceId: null,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60),
  name,
  description: null,
  activeVersionId: revision === null ? null : versionId(id, revision),
  activeRevision: revision,
  enabled: true,
  scope,
  ownerPrincipalId: scope === "personal" ? MOCK_PRINCIPAL_ID : null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: hoursAgo(changedHoursAgo),
  version: 1,
  copiedFromSkillId: null,
  copiedFromVersionId: null,
  ...extra,
});

function versionsOf(
  entry: Skill,
  count: number,
  licenses: Readonly<Record<string, string>>,
) {
  return Array.from({ length: count }, (_, index) => {
    const revision = index + 1;
    return {
      id: versionId(entry.id, revision),
      skillId: entry.id,
      revision,
      sourceRevision: `r${revision}`,
      digest: `sha256:${String(revision).repeat(4)}abcdef0123456789`,
      entryPath: "SKILL.md",
      manifest: {
        schemaVersion: 1,
        entryPath: "SKILL.md",
        ...(licenses[entry.id] === undefined
          ? {}
          : { license: licenses[entry.id] }),
        files: [
          {
            path: "SKILL.md",
            mediaType: "text/markdown",
            sizeBytes: 2048,
            sha256: "a".repeat(64),
            isExecutable: false,
          },
          ...(entry.id === IDS.releaseNotes ? [] : [
            {
              path: "examples/good-answer.md",
              mediaType: "text/markdown",
              sizeBytes: 640,
              sha256: "b".repeat(64),
              isExecutable: false,
            },
            {
              path: "scripts/check.sh",
              mediaType: "text/x-shellscript",
              sizeBytes: 1_250_000,
              sha256: "c".repeat(64),
              isExecutable: true,
            },
          ]),
        ],
      },
      status: entry.activeRevision === revision
        ? "published"
        : revision > (entry.activeRevision ?? 0)
        ? "draft"
        : "retired",
      createdBy: MOCK_PRINCIPAL_ID,
      createdAt: `2026-11-${
        String(10 + revision).padStart(2, "0")
      }T09:00:00.000Z`,
      updatedAt: `2026-11-${
        String(10 + revision).padStart(2, "0")
      }T09:00:00.000Z`,
      version: 1,
      publishedAt: entry.activeRevision !== null &&
          revision <= entry.activeRevision
        ? `2026-11-${String(10 + revision).padStart(2, "0")}T10:00:00.000Z`
        : null,
      label: revision === 2 && entry.id === IDS.writingGuide
        ? "Spring release"
        : null,
    };
  });
}

export type SkillsOptions = {
  /** No skill at all. */
  readonly empty?: boolean;
  /** Scopes that have no skills. */
  readonly emptyScopes?: readonly Skill["scope"][];
  /** More organization skills, for Load more. */
  readonly extra?: number;
  /** The list read fails with this status. */
  readonly listStatus?: number;
  /** Who-can-use-it answers with this status. */
  readonly grantsStatus?: number;
  /** What-uses-it answers with this status. */
  readonly usedByStatus?: number;
  /** The licence each skill's own version declares, by skill id; Writing guide is MIT. */
  readonly ownLicenses?: Readonly<Record<string, string>>;
  /** The licence the source of Writing guide declares; MIT unless this says otherwise. */
  readonly sourceLicense?: string | null;
  /** What the reader may do in the organization; developer unless this says admin. */
  readonly role?: "admin" | "developer";
  /** Renaming or turning a skill on or off answers with this status instead of succeeding. */
  readonly updateStatus?: number;
  /** Making a copy answers with this status instead of succeeding. */
  readonly copyStatus?: number;
  /** Stopping a workflow using the skill answers with this status instead of succeeding. */
  readonly stopStatus?: number;
};

export type Seen = {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  /** The If-Match header of a write. */
  readonly ifMatch?: string | null;
  /** The JSON body of a write. */
  readonly body?: Record<string, unknown> | null;
};

export async function skillsFixture(page: Page, options: SkillsOptions = {}) {
  await mockAuthenticatedSession(page);
  await page.clock.setSystemTime(new Date(NOW));
  // The shell asks what this person may do; an unstubbed read answers 401 and signs the page out.
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
  const licenses: Readonly<Record<string, string>> = {
    [IDS.writingGuide]: "MIT",
    ...options.ownLicenses,
  };
  const all: Skill[] = options.empty ? [] : [
    skill(IDS.writingGuide, "Writing guide", "global", 3, 30 * 24, {
      sourceId: IDS.source,
      description:
        "How Bakery writes for people: plain words, short sentences.",
    }),
    skill(IDS.releaseNotes, "Release notes", "organization", 1, 3, {
      description: "Writes the release notes from the merged pull requests.",
    }),
    skill(IDS.houseStyle, "House style", "personal", 2, 26, {
      copiedFromSkillId: IDS.writingGuide,
      copiedFromVersionId: versionId(IDS.writingGuide, 1),
    }),
    skill(IDS.oldChecklist, "Old checklist", "organization", 1, 4 * 24, {
      enabled: false,
    }),
    skill(IDS.scratch, "Scratch idea", "personal", null, 0.2),
    skill(IDS.longName, LONG_NAME, "organization", 4, 12 * 24),
    skill(IDS.toneOfVoice, "Tone of voice", "personal", 1, 50, {
      copiedFromSkillId: IDS.missing,
      copiedFromVersionId: uuid(998),
    }),
    ...Array.from(
      { length: options.extra ?? 0 },
      (_, index) =>
        skill(
          uuid(500 + index),
          `Checklist ${String(index + 1).padStart(2, "0")}`,
          "organization",
          1,
          48,
        ),
    ),
  ];
  const skills = all.filter((entry) =>
    !(options.emptyScopes ?? []).includes(entry.scope)
  );
  const versionCount = (entry: Skill) =>
    entry.activeRevision === null ? 1 : entry.activeRevision + 1;
  const seen: Seen[] = [];
  const stopped = new Set<string>();
  const record = (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    seen.push({
      method,
      path: url.pathname,
      search: url.search,
      ...(method === "GET" ? {} : {
        ifMatch: request.headers()["if-match"] ?? null,
        body: request.postDataJSON() as Record<string, unknown> | null,
      }),
    });
    return url;
  };
  const json = (route: Route, body: unknown) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  const problem = (route: Route, status: number, code: string) =>
    route.fulfill({
      status,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: `https://bakery.example/problems/${code.toLowerCase()}`,
        title: code,
        status,
        detail: code,
        code,
        requestId: "00000000-0000-4000-8000-0000000000e1",
        traceId: "00000000-0000-4000-8000-0000000000e2",
        retryable: false,
      }),
    });
  const pageOf = <T>(items: T[], url: URL) => {
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const from = Number(url.searchParams.get("cursor") ?? 0);
    const next = from + limit;
    return {
      items: items.slice(from, next),
      nextCursor: next < items.length ? String(next) : null,
    };
  };
  const statusOf = (status: number) =>
    status === 403
      ? "AUTH_FORBIDDEN"
      : status === 404
      ? "RESOURCE_NOT_FOUND"
      : "SERVER_ERROR";
  const find = (id: string | undefined) =>
    skills.find((entry) => entry.id === id) ??
      all.find((entry) => entry.id === id);

  // The workflow a grant names: one version whose first step is "Write the task brief".
  await page.route(
    (url) => /^\/v1\/workflows\/[^/]+\/versions$/.test(url.pathname),
    (route) => {
      const workflowId = new URL(route.request().url()).pathname.split("/")[3];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{
            id: uuid(1002),
            workflowId,
            revision: 2,
            sourceYaml: "kind: fixed\n",
            normalizedSpec: {
              kind: "fixed",
              workflow: { kind: "fixed" },
              steps: [{ id: "brief", uses: "task.brief" }],
            },
            digest: "02".repeat(32),
            status: "published",
            createdBy: uuid(1),
            createdAt: "2026-11-01T10:00:00.000Z",
            updatedAt: "2026-11-01T10:00:00.000Z",
            version: 1,
            starts: [],
          }],
          nextCursor: null,
        }),
      });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith("/v1/skill"),
    (route) => {
      const url = record(route);
      const method = route.request().method();
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        method === "DELETE" && parts[1] === "skills" &&
        parts[3] === "use-grants"
      ) {
        if (options.stopStatus !== undefined) {
          return problem(
            route,
            options.stopStatus,
            statusOf(options.stopStatus),
          );
        }
        if (stopped.has(parts[4] ?? "")) {
          return problem(route, 404, "RESOURCE_NOT_FOUND");
        }
        stopped.add(parts[4] ?? "");
        return route.fulfill({ status: 204 });
      }
      if (method !== "GET") {
        const target = parts[1] === "skills" ? find(parts[2]) : undefined;
        const body = route.request().postDataJSON() as
          | { name?: string; enabled?: boolean; scope?: Skill["scope"] }
          | null;
        if (method === "PATCH" && parts.length === 3 && target) {
          if (options.updateStatus !== undefined) {
            return problem(
              route,
              options.updateStatus,
              statusOf(options.updateStatus),
            );
          }
          if (
            body?.name !== undefined &&
            all.some((other) =>
              other.id !== target.id && other.name === body.name
            )
          ) {
            return problem(route, 409, "STATE_CONFLICT");
          }
          Object.assign(target, {
            ...(body?.name === undefined ? {} : { name: body.name }),
            ...(body?.enabled === undefined ? {} : { enabled: body.enabled }),
            version: target.version + 1,
            updatedAt: NOW,
          });
          return json(route, target);
        }
        if (method === "POST" && parts[3] === "copy" && target) {
          if (options.copyStatus !== undefined) {
            return problem(
              route,
              options.copyStatus,
              statusOf(options.copyStatus),
            );
          }
          if (all.some((other) => other.name === body?.name)) {
            return problem(route, 409, "STATE_CONFLICT");
          }
          const made = skill(
            uuid(900 + all.length),
            body?.name ?? "Copy",
            body?.scope ?? "personal",
            target.activeRevision,
            0,
            {
              copiedFromSkillId: target.id,
              copiedFromVersionId: target.activeVersionId,
            },
          );
          all.push(made);
          skills.push(made);
          return route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify(made),
          });
        }
        return problem(route, 405, "MALFORMED_REQUEST");
      }
      if (parts[1] === "skill-sources" && parts.length === 3) {
        return parts[2] === IDS.source
          ? json(route, {
            id: IDS.source,
            name: "Bakery skills",
            sourceType: "git",
            locator: "https://github.com/example/bakery-skills.git",
            publisher: "Bakery",
            license: options.sourceLicense === undefined
              ? "MIT"
              : options.sourceLicense,
            lastCheckedAt: "2026-11-21T08:30:00.000Z",
            enabled: true,
            createdAt: "2026-10-01T09:00:00.000Z",
            updatedAt: "2026-11-21T08:30:00.000Z",
            version: 3,
          })
          : problem(route, 404, "RESOURCE_NOT_FOUND");
      }
      if (parts[1] !== "skills") {
        return problem(route, 404, "RESOURCE_NOT_FOUND");
      }
      if (parts.length === 2) {
        if (options.listStatus !== undefined) {
          return problem(
            route,
            options.listStatus,
            statusOf(options.listStatus),
          );
        }
        const scope = url.searchParams.get("scope");
        const q = url.searchParams.get("q")?.toLowerCase();
        const rows = skills
          .filter((entry) => scope === null || entry.scope === scope)
          .filter((entry) =>
            q === undefined || entry.name.toLowerCase().includes(q)
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        return json(route, pageOf(rows, url));
      }
      const entry = find(parts[2]);
      if (entry === undefined) return problem(route, 404, "RESOURCE_NOT_FOUND");
      if (parts.length === 3) return json(route, entry);
      switch (parts[3]) {
        case "versions":
          return json(
            route,
            pageOf(versionsOf(entry, versionCount(entry), licenses), url),
          );
        case "used-by": {
          if (options.usedByStatus !== undefined) {
            return problem(
              route,
              options.usedByStatus,
              statusOf(options.usedByStatus),
            );
          }
          const items = entry.id === IDS.releaseNotes
            ? [
              {
                kind: "agent",
                definitionId: uuid(601),
                definitionName: "Reviewer",
                versionId: uuid(611),
                revision: 4,
                skillVersionIds: [versionId(entry.id, 1)],
                createdAt: "2026-11-15T09:00:00.000Z",
              },
              {
                kind: "workflow",
                definitionId: uuid(602),
                definitionName: "Release",
                versionId: uuid(612),
                revision: 2,
                skillVersionIds: [versionId(entry.id, 1)],
                createdAt: "2026-11-16T09:00:00.000Z",
              },
              {
                kind: "workflow",
                definitionId: uuid(603),
                definitionName: "Nightly build",
                versionId: uuid(613),
                revision: 7,
                skillVersionIds: [
                  versionId(entry.id, 2),
                  versionId(entry.id, 1),
                ],
                createdAt: "2026-11-17T09:00:00.000Z",
              },
            ]
            : [];
          return json(route, pageOf(items, url));
        }
        case "use-grants": {
          if (options.grantsStatus !== undefined) {
            return problem(
              route,
              options.grantsStatus,
              statusOf(options.grantsStatus),
            );
          }
          if (entry.scope !== "personal") {
            return problem(route, 403, "AUTH_FORBIDDEN");
          }
          const items = entry.id === IDS.houseStyle && !stopped.has(uuid(701))
            ? [
              {
                id: uuid(701),
                skillId: entry.id,
                skillVersionId: versionId(entry.id, 2),
                // Required since #912: the revision of the granted version.
                revision: 2,
                workflowId: uuid(702),
                workflowName: "Weekly digest",
                // Required since the server records it on the grant (#74 run admission).
                revisionDigest: "sha256:2222abcdef0123456789",
                stepPath: "/steps/0",
                grantedBy: MOCK_PRINCIPAL_ID,
                createdAt: "2026-11-18T09:00:00.000Z",
                version: 1,
              },
            ]
            : [];
          return json(route, pageOf(items, url));
        }
        default:
          return problem(route, 404, "RESOURCE_NOT_FOUND");
      }
    },
  );
  return { seen };
}
