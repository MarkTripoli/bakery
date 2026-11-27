import type { Page } from "@playwright/test";
import {
  MOCK_ORGANIZATION_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";
import { CONNECTION_ID, uuid } from "./projects-fixture.ts";

/** Stubs for one repository's page: its reads, its profile versions, the connection, and what is written. */

const STAMP = "2026-01-01T00:00:00.000Z";
export const REPOSITORY_ID = uuid(250);
export const APPLICATION_ID = uuid(150);

export type Profile = {
  revision: number;
  branches: string[];
  folder?: string;
  /** The version states rules of its own (the Rules page publishes such versions); a string names the rule, so two versions can state different ones. */
  rules?: boolean | string;
  /** The version carries a fixed policy, which locks its branches. */
  fixed?: boolean;
  /** Made by a readiness check (schema 2 with its check policy); a person's version is schema 1. */
  checkMade?: boolean;
  /** A failed check's candidate: stored (it holds a revision) but not listed. */
  hidden?: boolean;
};

export type Options = {
  role?: "admin" | "developer";
  /** The versions of the working settings, oldest first. */
  profiles?: Profile[];
  /** The number of the version in use (none when absent). */
  active?: number;
  archived?: boolean;
  defaultBranch?: string;
  /** The connection's state; "missing" answers 404. */
  connection?: "enabled" | "revoked" | "missing";
  /** What creating a version answers: ok, a 409 (the number is taken), a server fault or a 400. */
  save?: "ok" | "conflict" | "down" | "rejected";
  /** The server refuses a save that changes the branches with a 422 (`repository_branches_locked`) although the version in use shows no policy. */
  branchesLocked?: boolean;
  /** What putting a version in use answers: ok, a 412 whatever the version, or a server fault. */
  use?: "ok" | "conflict" | "down";
  /** The repository read answers this status instead of the repository. */
  repositoryStatus?: 403 | 404 | 500;
  /** Versions per page, to prove every page is read. */
  pageSize?: number;
  /**
   * What the readiness check does once started: the check passes, a required
   * check fails, optional checks fail, the check fails or is cancelled as a
   * whole, it never leaves the queue, or its progress cannot be read.
   */
  check?:
    | "ready"
    | "blocked"
    | "optional"
    | "failed"
    | "canceled"
    | "stuck"
    | "unreadable"
    | "stale";
  /** What starting a check answers instead of the check. */
  start?: "forbidden" | "conflict" | "down";
  /** A check that already exists, named by the address (`?check=`). */
  existingCheck?: boolean;
  /**
   * The real server publishes the next version of the settings and puts it in
   * use when a check completes: the same here, so the page must read the
   * repository and its versions again to judge the result against it.
   */
  completionPublishes?: boolean;
  /** The names (role bindings) of the application, of this and other repositories. */
  names?: Name[];
  /** What writing a name answers. */
  nameWrite?: "conflict" | "down";
  /** What testing a name finds. */
  resolve?: "this" | "other" | "none" | "archived" | "ambiguous" | "foreign";
};

export type Name = {
  id?: string;
  role: string;
  alias?: string | null;
  note?: string | null;
  /** The repository the name points at; this page's repository when absent. */
  other?: boolean;
  archived?: boolean;
  version?: number;
};
export const OTHER_REPOSITORY_ID = uuid(251);

export const CHECK_ID = uuid(700);
export const JOB_ID = uuid(701);
const OBSERVATION_ID = uuid(702);

const SOURCE = {
  mappingRevision: "1",
  mappingDigest: "e".repeat(64),
  baseSha: "c".repeat(40),
  manifestDigest: "f".repeat(64),
  envelopeDigest: "9".repeat(64),
  envelopeBytes: 100,
  decodedBytes: 200,
  entryCount: 3,
};
type CheckRow = {
  id: string;
  template: string;
  required: boolean;
  status: string;
  reason: string;
};
const PASSING: CheckRow[] = [
  {
    id: "source",
    template: "source.integrity.v1",
    required: true,
    status: "passed",
    reason: "verified",
  },
  {
    id: "tools",
    template: "tool.version.v1",
    required: true,
    status: "passed",
    reason: "verified",
  },
  {
    id: "node",
    template: "node.syntax.v1",
    required: true,
    status: "passed",
    reason: "verified",
  },
];
const rowsFor = (mode: string): CheckRow[] =>
  mode === "blocked"
    ? [
      PASSING[0],
      { ...PASSING[1], status: "missing", reason: "tool_missing" },
      { ...PASSING[2], status: "failed", reason: "exit_nonzero" },
      {
        id: "deno",
        template: "deno.check.v1",
        required: false,
        status: "failed",
        reason: "deadline",
      },
    ]
    : mode === "optional"
    ? [
      ...PASSING,
      {
        id: "deno",
        template: "deno.check.v1",
        required: false,
        status: "unsupported",
        reason: "unsupported_command",
      },
    ]
    : PASSING;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const problem = (status: number, code: string, issueCode?: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({
    type: "https://bakery.example/problems/test",
    title: "Problem",
    detail: "Problem.",
    status,
    code,
    ...(issueCode === undefined ? {} : {
      issues: [{ path: ["config"], code: issueCode, message: "Refused." }],
    }),
    retryable: status >= 500,
    requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
  }),
});

const profileId = (revision: number) => uuid(3000 + revision);

const configOf = (profile: Profile, base: string) => ({
  schemaVersion: 1,
  workflow: { kind: "fixed" },
  branches: { base, allowedPatterns: profile.branches },
  worktree: { root: profile.folder ?? "." },
  ...(profile.rules
    ? {
      repositoryRules: {
        entries: [{
          ruleKey: typeof profile.rules === "string"
            ? profile.rules
            : "commits.format",
        }],
      },
    }
    : {}),
  ...(profile.fixed
    ? {
      fixedPolicy: {
        lockedConfiguration: { branches: true, worktree: true, checker: true },
      },
    }
    : {}),
  ...(profile.checkMade ? { schemaVersion: 2, checkPolicy: {} } : {}),
});

/** Stubs the session, role and every read and write of the repository page; returns what it saw. */
export async function repositoryFixture(page: Page, options: Options = {}) {
  await mockAuthenticatedSession(page);
  const base = options.defaultBranch ?? "main";
  const profiles = (options.profiles ?? []).map((profile) => ({ ...profile }));
  const state = {
    active: options.active ?? null as number | null,
    version: 1,
    archived: options.archived ?? false,
    name: "api-service",
    branch: null as string | null,
  };
  const checkState = {
    started: options.existingCheck === true,
    polls: 0,
    published: false,
    /** The version the check was for, once it published one (else the one in use). */
    observed: null as number | null,
  };
  const observedRevision = () => checkState.observed ?? state.active ?? 1;
  const nameRows = (options.names ?? []).map((name, index) => ({
    id: name.id ?? uuid(5000 + index),
    role: name.role,
    alias: name.alias ?? null,
    provenance: name.note ?? null,
    repositoryId: name.other ? OTHER_REPOSITORY_ID : REPOSITORY_ID,
    archivedAt: name.archived ? STAMP : null as string | null,
    version: name.version ?? 1,
  }));
  const nameBody = (row: (typeof nameRows)[number]) => ({
    ...row,
    organizationId: MOCK_ORGANIZATION_ID,
    applicationId: APPLICATION_ID,
    repositorySlug: "api-service",
  });
  const seen = {
    starts: [] as (string | null)[],
    nameWrites: [] as {
      method: string;
      id: string | null;
      ifMatch: string | null;
      key: string | null;
      body: Record<string, unknown>;
    }[],
    resolves: [] as Record<string, unknown>[],
    createdProfiles: [] as Record<string, unknown>[],
    createKeys: [] as (string | null)[],
    /** The If-Match each save over a version that carries rules was sent with. */
    createIfMatch: [] as (string | null)[],
    updates: [] as {
      ifMatch: string | null;
      key: string | null;
      body: Record<string, unknown>;
    }[],
    profileReads: 0,
  };
  const profileBody = (profile: Profile) => ({
    id: profileId(profile.revision),
    repositoryId: REPOSITORY_ID,
    revision: profile.revision,
    config: configOf(profile, base),
    digest: "a".repeat(64),
    createdBy: uuid(1),
    createdAt: `2026-01-0${Math.min(profile.revision, 9)}T00:00:00.000Z`,
    updatedAt: STAMP,
    version: 1,
  });
  const repositoryBody = () => ({
    id: REPOSITORY_ID,
    applicationId: APPLICATION_ID,
    slug: "api-service",
    integrationConnectionId: CONNECTION_ID,
    providerRepoId: "5001",
    owner: "acme",
    name: state.name,
    defaultBranch: state.branch ?? base,
    activeProfileId: state.active === null ? null : profileId(state.active),
    // The highest stored revision plus one: a hidden failed candidate holds one.
    nextProfileRevision: Math.max(0, ...profiles.map((item) => item.revision)) +
      1,
    archivedAt: state.archived ? STAMP : null,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: state.version,
  });
  await page.route(
    `**/v1/organizations/${MOCK_ORGANIZATION_ID}/effective-access`,
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: options.role ?? "admin",
        capabilities: [],
      })),
  );
  await page.route(
    (url) => url.pathname === `/v1/repositories/${REPOSITORY_ID}`,
    (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        if (options.repositoryStatus !== undefined) {
          return route.fulfill(problem(options.repositoryStatus, "TEST"));
        }
        return route.fulfill(json(repositoryBody()));
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      seen.updates.push({
        ifMatch: request.headers()["if-match"] ?? null,
        key: request.headers()["idempotency-key"] ?? null,
        body,
      });
      // The server answers 412 to a stale version: the page must hold the
      // repository's current one (a first version is put in use by the server
      // itself, which moves the version).
      if (
        options.use === "conflict" ||
        request.headers()["if-match"] !== `"v${state.version}"`
      ) {
        return route.fulfill(problem(412, "PRECONDITION_FAILED"));
      }
      if (options.use === "down") {
        return route.fulfill(problem(500, "INTERNAL"));
      }
      if ("archivedAt" in body) state.archived = body.archivedAt !== null;
      if (typeof body.name === "string") state.name = body.name;
      if (typeof body.defaultBranch === "string") {
        state.branch = body.defaultBranch;
      }
      const wanted = profiles.find((profile) =>
        profileId(profile.revision) === body.activeProfileId
      );
      if (wanted) state.active = wanted.revision;
      state.version += 1;
      return route.fulfill(json(repositoryBody()));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/applications/${APPLICATION_ID}`,
    (route) =>
      route.fulfill(json({
        id: APPLICATION_ID,
        slug: "checkout",
        name: "Checkout",
        description: "The checkout service",
        archivedAt: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      })),
  );
  await page.route(
    (url) => url.pathname === `/v1/integration-connections/${CONNECTION_ID}`,
    (route) => {
      if (options.connection === "missing") {
        return route.fulfill(problem(404, "NOT_FOUND"));
      }
      return route.fulfill(json({
        id: CONNECTION_ID,
        provider: "github",
        label: "acme-org",
        externalAccountId: "7000001",
        config: {},
        secretId: null,
        health: "healthy",
        grantedScopeNames: null,
        grantedScopes: { metadata: "read", contents: "write" },
        createdBy: uuid(1),
        status: options.connection ?? "enabled",
        lastCheckedAt: STAMP,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      }));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/repositories/${REPOSITORY_ID}/profiles`,
    (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as {
          revision: number;
          keepRepositoryRules?: boolean;
          config: {
            branches: { allowedPatterns: string[] };
            worktree: { root: string };
          };
        };
        seen.createdProfiles.push(body as never);
        seen.createKeys.push(request.headers()["idempotency-key"] ?? null);
        if (options.save === "conflict") {
          return route.fulfill(problem(409, "STATE_CONFLICT"));
        }
        if (options.save === "down") {
          return route.fulfill(problem(500, "INTERNAL"));
        }
        if (options.save === "rejected") {
          return route.fulfill(problem(400, "MALFORMED_REQUEST"));
        }
        // The strict version-1 parser refuses the check's own key.
        if (
          (body.config as Record<string, unknown>).checkPolicy !== undefined
        ) {
          return route.fulfill(problem(422, "UNPROCESSABLE"));
        }
        const inUse = profiles.find((item) => item.revision === state.active);
        const carries = inUse?.rules === true;
        // The server refuses a save that both keeps the rules and states some.
        if (
          body.keepRepositoryRules === true &&
          (body.config as Record<string, unknown>).repositoryRules !== undefined
        ) {
          return route.fulfill(
            problem(422, "UNPROCESSABLE", "repository_rules_keep_conflict"),
          );
        }
        let keeps = false;
        if (carries) {
          // Replacing a version that carries rules activates the new one under If-Match.
          const ifMatch = request.headers()["if-match"];
          seen.createIfMatch.push(ifMatch ?? null);
          if (ifMatch === undefined) {
            return route.fulfill(problem(428, "PRECONDITION_REQUIRED"));
          }
          if (ifMatch !== `"v${state.version}"`) {
            return route.fulfill(problem(412, "PRECONDITION_FAILED"));
          }
          if (body.keepRepositoryRules === true) {
            // A branches-only save: nothing else of the version in use may change.
            const retainedFolder = inUse?.folder ?? ".";
            if (body.config.worktree.root !== retainedFolder) {
              return route.fulfill(
                problem(
                  422,
                  "UNPROCESSABLE",
                  "repository_rules_must_retain_config",
                ),
              );
            }
            if (
              options.branchesLocked &&
              JSON.stringify(body.config.branches.allowedPatterns) !==
                JSON.stringify(inUse?.branches)
            ) {
              return route.fulfill(
                problem(422, "UNPROCESSABLE", "repository_branches_locked"),
              );
            }
            keeps = true;
          }
        }
        const created: Profile = {
          revision: body.revision,
          branches: body.config.branches.allowedPatterns,
          folder: body.config.worktree.root === "."
            ? undefined
            : body.config.worktree.root,
          // The rules in force are copied into the new version, as the server does.
          ...(keeps ? { rules: inUse?.rules } : {}),
        };
        profiles.push(created);
        // The server puts the first version of a repository in use itself, and
        // one that keeps the rules in force.
        if (state.active === null || keeps) {
          state.active = created.revision;
          state.version += 1;
        }
        return route.fulfill(json(profileBody(created), 201));
      }
      seen.profileReads += 1;
      const url = new URL(request.url());
      const size = options.pageSize ?? 100;
      const offset = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
      // A failed check's candidate is stored but not listed.
      const listed = profiles.filter((item) => !item.hidden);
      return route.fulfill(json({
        items: listed.slice(offset, offset + size).map(profileBody),
        nextCursor: offset + size < listed.length ? `c${offset + size}` : null,
      }));
    },
  );
  const onboardingBody = (status: string, withResult: boolean) => ({
    id: CHECK_ID,
    repositoryId: REPOSITORY_ID,
    jobId: JOB_ID,
    status,
    profileId: withResult
      ? (options.check === "stale"
        ? profileId(0)
        : profileId(observedRevision()))
      : null,
    observationId: withResult ? OBSERVATION_ID : null,
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: STAMP,
  });
  await page.route(
    (url) =>
      url.pathname === `/v1/repositories/${REPOSITORY_ID}/onboarding-runs`,
    (route) => {
      seen.starts.push(route.request().headers()["idempotency-key"] ?? null);
      if (options.start === "forbidden") {
        return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
      }
      if (options.start === "conflict") {
        return route.fulfill(problem(409, "STATE_CONFLICT"));
      }
      if (options.start === "down") {
        return route.fulfill(problem(500, "INTERNAL"));
      }
      checkState.started = true;
      checkState.polls = 0;
      return route.fulfill(json(onboardingBody("queued", false), 202));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/repository-onboardings/${CHECK_ID}`,
    (route) => {
      if (!checkState.started) return route.fulfill(problem(404, "NOT_FOUND"));
      if (options.check === "unreadable") {
        return route.fulfill(problem(500, "INTERNAL"));
      }
      checkState.polls += 1;
      const mode = options.check ?? "ready";
      if (mode === "stuck") {
        return route.fulfill(json(onboardingBody("queued", false)));
      }
      // Queued, then running, then done.
      if (checkState.polls === 1 && !options.existingCheck) {
        return route.fulfill(json(onboardingBody("running", false)));
      }
      if (mode === "failed") {
        return route.fulfill(json(onboardingBody("failed", false)));
      }
      if (mode === "canceled") {
        return route.fulfill(json(onboardingBody("canceled", false)));
      }
      if (options.completionPublishes && !checkState.published) {
        checkState.published = true;
        const from = profiles.find((item) => item.revision === state.active) ??
          profiles[profiles.length - 1];
        const next: Profile = {
          revision: Math.max(0, ...profiles.map((item) => item.revision)) + 1,
          branches: from?.branches ?? ["main"],
          folder: from?.folder,
          // A check's candidate is check-made; one that did not pass is not listed.
          checkMade: true,
          hidden: mode === "blocked",
        };
        profiles.push(next);
        checkState.observed = next.revision;
        // A check that passes puts the version it published in use; one that
        // does not pass leaves the version in use as it was (the real server).
        if (mode !== "blocked") {
          state.active = next.revision;
          state.version += 1;
        }
      }
      return route.fulfill(json(onboardingBody("completed", true)));
    },
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/repository-profile-observations/${OBSERVATION_ID}`,
    (route) => {
      const mode = options.check ?? "ready";
      const rows = rowsFor(mode);
      const observed = mode === "stale" ? 1 : observedRevision();
      return route.fulfill(json({
        id: OBSERVATION_ID,
        repositoryId: REPOSITORY_ID,
        profileId: mode === "stale" ? profileId(0) : profileId(observed),
        profileRevision: observed,
        profileDigest: "a".repeat(64),
        observationDigest: "b".repeat(64),
        baseSha: "c".repeat(40),
        payload: {
          schemaVersion: 1,
          inspectionId: CHECK_ID,
          jobId: JOB_ID,
          organizationId: MOCK_ORGANIZATION_ID,
          applicationId: APPLICATION_ID,
          repositoryId: REPOSITORY_ID,
          profileId: mode === "stale" ? profileId(0) : profileId(observed),
          profileRevision: observed,
          profileDigest: "a".repeat(64),
          source: SOURCE,
          receipt: {
            inspectionId: CHECK_ID,
            jobId: JOB_ID,
            organizationId: MOCK_ORGANIZATION_ID,
            applicationId: APPLICATION_ID,
            repositoryId: REPOSITORY_ID,
            inputDigest: "d".repeat(64),
            source: SOURCE,
            attemptId: uuid(703),
            fence: "1",
            workerHostId: uuid(900),
            workerSessionId: uuid(704),
            workerSessionGeneration: "1",
            expiresAt: "2026-01-02T11:00:00.000Z",
          },
          host: {
            workerHostId: uuid(900),
            os: "linux",
            architecture: "x64",
            tools: [
              {
                tool: "git",
                status: "available",
                version: "2.40",
                outputDigest: null,
              },
              {
                tool: "deno",
                status: mode === "blocked" ? "missing" : "available",
                version: null,
                outputDigest: null,
              },
              {
                tool: "node",
                status: "available",
                version: "22.0",
                outputDigest: null,
              },
            ],
          },
          checks: rows.map((row) => ({
            ...row,
            exitCode: null,
            outputDigest: null,
            durationMs: 12,
          })),
          readiness: mode === "blocked" ? "blocked" : "eligible",
          observedAt: "2026-01-02T10:05:00.000Z",
        },
      }));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/applications/${APPLICATION_ID}/roles`,
    (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        seen.nameWrites.push({
          method: "POST",
          id: null,
          ifMatch: null,
          key: request.headers()["idempotency-key"] ?? null,
          body,
        });
        if (options.nameWrite === "conflict") {
          return route.fulfill(problem(409, "STATE_CONFLICT"));
        }
        if (options.nameWrite === "down") {
          return route.fulfill(problem(500, "INTERNAL"));
        }
        const row = {
          id: uuid(5500 + nameRows.length),
          role: String(body.role),
          alias: (body.alias as string | null) ?? null,
          provenance: (body.provenance as string | null) ?? null,
          repositoryId: String(body.repositoryId),
          archivedAt: null as string | null,
          version: 1,
        };
        nameRows.push(row);
        return route.fulfill(json(nameBody(row), 201));
      }
      return route.fulfill(
        json({ items: nameRows.map(nameBody), nextCursor: null }),
      );
    },
  );
  await page.route(
    (url) =>
      new RegExp(`^/v1/applications/${APPLICATION_ID}/roles/[0-9a-f-]{36}$`)
        .test(
          url.pathname,
        ),
    (route) => {
      const request = route.request();
      const id = new URL(request.url()).pathname.split("/").pop() ?? "";
      const body = request.postDataJSON() as Record<string, unknown>;
      seen.nameWrites.push({
        method: request.method(),
        id,
        ifMatch: request.headers()["if-match"] ?? null,
        key: request.headers()["idempotency-key"] ?? null,
        body,
      });
      if (options.nameWrite === "conflict") {
        return route.fulfill(problem(409, "STATE_CONFLICT"));
      }
      const row = nameRows.find((item) => item.id === id);
      if (!row) return route.fulfill(problem(404, "NOT_FOUND"));
      if (typeof body.role === "string") row.role = body.role;
      if ("alias" in body) row.alias = (body.alias as string | null) ?? null;
      if ("provenance" in body) {
        row.provenance = (body.provenance as string | null) ?? null;
      }
      if ("archivedAt" in body) {
        row.archivedAt = (body.archivedAt as string | null) ?? null;
      }
      row.version += 1;
      return route.fulfill(json(nameBody(row)));
    },
  );
  await page.route(
    (url) =>
      url.pathname === `/v1/applications/${APPLICATION_ID}/roles/resolve`,
    (route) => {
      seen.resolves.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      const mode = options.resolve ?? "this";
      if (mode === "foreign") return route.fulfill(problem(404, "NOT_FOUND"));
      if (mode === "none") {
        return route.fulfill(
          json({ status: "unavailable", reason: "no_matching_binding" }),
        );
      }
      if (mode === "archived") {
        return route.fulfill(
          json({ status: "unavailable", reason: "repository_archived" }),
        );
      }
      if (mode === "ambiguous") {
        const candidate = (repositoryId: string, n: number) => ({
          bindingId: uuid(6000 + n),
          repositoryId,
          role: "api",
          alias: null,
          provenance: null,
          repositoryArchived: false,
          profileRevision: null,
          hasEligibleObservation: false,
        });
        return route.fulfill(json({
          status: "ambiguous",
          candidates: [
            candidate(REPOSITORY_ID, 1),
            candidate(OTHER_REPOSITORY_ID, 2),
          ],
          truncated: false,
        }));
      }
      return route.fulfill(json({
        status: "resolved",
        binding: {
          organizationId: MOCK_ORGANIZATION_ID,
          applicationId: APPLICATION_ID,
          repositoryId: mode === "other" ? OTHER_REPOSITORY_ID : REPOSITORY_ID,
          repositoryProfileId: null,
          repositoryProfileRevision: null,
          repositoryProfileDigest: null,
          observationId: null,
          observationDigest: null,
          baseSha: null,
        },
      }));
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/repositories/${OTHER_REPOSITORY_ID}`,
    (route) =>
      route.fulfill(json({
        id: OTHER_REPOSITORY_ID,
        applicationId: APPLICATION_ID,
        slug: "billing",
        integrationConnectionId: CONNECTION_ID,
        providerRepoId: "5002",
        owner: "acme",
        name: "billing",
        defaultBranch: "main",
        activeProfileId: null,
        archivedAt: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        version: 1,
      })),
  );
  return { seen, state, profiles };
}
