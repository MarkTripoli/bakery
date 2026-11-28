import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { libraryFixture, uuid } from "./helpers/library-fixture.ts";
import { MOCK_ORGANIZATION_ID } from "./helpers/mock-session.ts";
import { registerPageHealth } from "./helpers/page-health.ts";
import { shot } from "./helpers/real-api.ts";

registerPageHealth(test);

/**
 * The Memory tab (design-ux, #72, slice 1): remembered facts with one badge
 * each, where each came from, and a read-only panel for one fact. The entry
 * carries its current revision, so the list is one read, not one per fact.
 */
const STAMP = "2026-11-01T10:00:00.000Z";
const API = uuid(900);
const WEB = uuid(901);

type Source = "available" | "deleted" | "no_access" | "unknown";
type Fact = {
  n: number;
  body: string;
  status?: "proposed" | "active" | "retired";
  source?: Source;
  repository?: string;
  /** How many wordings the fact has had. */
  revisions?: number;
  confidence?: string;
  expiresAt?: string | null;
  artifact?: string;
  /** Fetchable by id, but not in the list (as when the list was cut short). */
  unlisted?: boolean;
  artifactVersion?: number;
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const revisionOf = (fact: Fact, revision: number) => {
  const state = fact.source ?? "available";
  const named = state === "available" || state === "deleted";
  return {
    id: uuid(fact.n * 100 + revision),
    memoryId: uuid(fact.n),
    revision,
    body: revision === (fact.revisions ?? 1)
      ? fact.body
      : `${fact.body} (earlier wording ${revision})`,
    reason: revision === 1 ? null : `Correction ${revision - 1}`,
    sourceArtifactVersionId: state === "no_access" ? null : uuid(7000 + fact.n),
    sourceState: state,
    sourceName: named ? fact.artifact ?? "Runbook" : null,
    sourceRevision: named ? fact.artifactVersion ?? 3 : null,
    supersedesId: revision === 1 ? null : uuid(fact.n * 100 + revision - 1),
    confidence: fact.confidence ?? "0.900000",
    expiresAt: fact.expiresAt ?? null,
    createdBy: uuid(revision === 1 ? 1 : 2),
    createdByName: revision === 1 ? "Ada Admin" : "Grace Hopper",
    createdAt: `2026-11-0${revision}T10:00:00.000Z`,
    updatedAt: STAMP,
    version: 1,
  };
};

const entryOf = (fact: Fact, version = 1) => {
  const last = fact.revisions ?? 1;
  const current = revisionOf(fact, last);
  return {
    id: uuid(fact.n),
    repositoryId: fact.repository ?? API,
    topic: `topic-${fact.n}`,
    tags: [],
    currentRevisionId: current.id,
    currentRevision: current,
    sourceState: fact.source ?? "available",
    status: fact.status ?? "active",
    createdAt: STAMP,
    updatedAt: STAMP,
    version: version,
  };
};

const repository = (id: string, name: string) => ({
  id,
  applicationId: uuid(800),
  slug: name,
  integrationConnectionId: uuid(801),
  providerRepoId: "5001",
  owner: "acme",
  name,
  defaultBranch: "main",
  activeProfileId: null,
  nextProfileRevision: 1,
  archivedAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
});

const WORLD: Fact[] = [
  {
    n: 1,
    body: "Deploys run from main, never from a branch.",
    revisions: 3,
    expiresAt: "2027-01-15T00:00:00.000Z",
  },
  {
    n: 2,
    body: "The staging database is reset every Monday.",
    status: "proposed",
    confidence: "0.600000",
  },
  {
    n: 3,
    body: "Releases are tagged by the on-call engineer.",
    source: "deleted",
    repository: WEB,
    confidence: "0.300000",
  },
  {
    n: 4,
    body: "Billing code lives in the payments package.",
    source: "no_access",
  },
  { n: 5, body: "Feature flags are read once at start-up.", status: "retired" },
];

type FixtureOptions = {
  fail?: boolean;
  role?: "admin" | "developer";
  /** Every change to a fact is refused with this rule slug (409). */
  refuse?: string;
};

const DOCUMENTS = [
  { n: 7100, name: "Deploy runbook" },
  { n: 7110, name: "Release checklist" },
].map(({ n, name }) => ({
  id: uuid(n),
  taskId: uuid(7200),
  artifactType: "plan",
  name,
  currentVersionId: uuid(n + 1),
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
  pinnedAt: null,
  pinnedBy: null,
}));

async function memoryFixture(
  page: Page,
  facts: Fact[] = WORLD,
  options: FixtureOptions = {},
) {
  await libraryFixture(page, { role: options.role });
  // The facts and their versions change as the page changes them.
  const live = facts.map((fact) => ({ ...fact }));
  const versions = new Map<string, number>();
  const versionOf = (id: string) => versions.get(id) ?? 1;
  const bump = (id: string) => versions.set(id, versionOf(id) + 1);
  const seen = {
    revisionReads: [] as string[],
    listReads: 0,
    updates: [] as {
      id: string;
      ifMatch: string | null;
      key: string | null;
      body: { status?: string };
    }[],
    revisions: [] as {
      id: string;
      key: string | null;
      body: {
        content: string;
        reason: string;
        sourceArtifactVersionId: string;
      };
    }[],
    /** Another person corrects a fact: the next read shows the new wording. */
    correct: (n: number, content: string) => {
      const fact = live.find((item) => item.n === n);
      if (!fact) throw new Error(`no fact ${n}`);
      fact.revisions = (fact.revisions ?? 1) + 1;
      fact.body = content;
      bump(uuid(n));
    },
    /** The cited document is deleted: the next read says so. */
    deleteSource: (n: number) => {
      const fact = live.find((item) => item.n === n);
      if (!fact) throw new Error(`no fact ${n}`);
      fact.source = "deleted";
    },
    /** A source that could not be checked can be: the next read says so. */
    recover: (n: number) => {
      const fact = live.find((item) => item.n === n);
      if (!fact) throw new Error(`no fact ${n}`);
      fact.source = "available";
    },
  };
  const refused = () =>
    options.refuse === undefined ? null : {
      status: 409,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "https://bakery.example/problems/test",
        title: "STATE_CONFLICT",
        detail: "STATE_CONFLICT",
        status: 409,
        code: "STATE_CONFLICT",
        retryable: false,
        requestId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        reason: options.refuse,
      }),
    };
  const problemOf = (status: number, code: string) => ({
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({
      type: "https://bakery.example/problems/test",
      title: code,
      detail: code,
      status,
      code,
      retryable: false,
      requestId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
    }),
  });
  // Two pages each, so a name or a document on the second page proves the
  // lists are read to the end.
  await page.route("**/v1/repositories**", (route) => {
    const second = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill(json({
      items: [
        repository(second ? WEB : API, second ? "web-app" : "api-service"),
      ],
      nextCursor: second ? null : "page-2",
    }));
  });
  await page.route("**/v1/artifacts**", (route) => {
    const second = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill(json({
      items: [DOCUMENTS[second ? 1 : 0]],
      nextCursor: second ? null : "page-2",
    }));
  });
  // Registered after the artifacts list, so it wins for a document's versions.
  await page.route("**/v1/artifacts/*/versions**", (route) => {
    const artifactId = new URL(route.request().url()).pathname.split("/")[3];
    const document = DOCUMENTS.find((item) => item.id === artifactId);
    return route.fulfill(json({
      items: document
        ? [{
          id: document.currentVersionId,
          artifactId: document.id,
          revision: document.name === "Deploy runbook" ? 4 : 2,
          runStepId: null,
          authorId: uuid(1),
          mediaType: "text/markdown",
          sizeBytes: 10,
          sha256: "a".repeat(64),
          subjectHeadSha: null,
          subjectBaseSha: null,
          metadata: null,
          createdAt: STAMP,
          updatedAt: STAMP,
          version: 1,
        }]
        : [],
      nextCursor: null,
    }));
  });
  await page.route("**/v1/memories**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const revisions = url.pathname.match(/\/v1\/memories\/([^/]+)\/revisions$/);
    const one = url.pathname.match(/\/v1\/memories\/([^/]+)$/);
    if (revisions) {
      const fact = live.find((item) => uuid(item.n) === revisions[1]);
      if (request.method() === "POST") {
        seen.revisions.push({
          id: revisions[1],
          key: request.headers()["idempotency-key"] ?? null,
          body: request.postDataJSON(),
        });
        const refusal = refused();
        if (refusal) return route.fulfill(refusal);
        if (!fact) return route.fulfill(json({}, 404));
        const input = request.postDataJSON() as { content: string };
        fact.revisions = (fact.revisions ?? 1) + 1;
        fact.body = input.content;
        fact.source = "available";
        bump(revisions[1]);
        return route.fulfill({
          ...json(revisionOf(fact, fact.revisions)),
          status: 201,
        });
      }
      seen.revisionReads.push(revisions[1]);
      return route.fulfill(json({
        items: fact
          ? Array.from(
            { length: fact.revisions ?? 1 },
            (_, index) => revisionOf(fact, index + 1),
          )
          : [],
        nextCursor: null,
      }));
    }
    if (one) {
      if (one[1] === uuid(98)) {
        return route.fulfill(problemOf(403, "AUTH_FORBIDDEN"));
      }
      const fact = live.find((item) => uuid(item.n) === one[1]);
      if (!fact) return route.fulfill(problemOf(404, "RESOURCE_NOT_FOUND"));
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as { status?: string };
        seen.updates.push({
          id: one[1],
          ifMatch: request.headers()["if-match"] ?? null,
          key: request.headers()["idempotency-key"] ?? null,
          body,
        });
        const refusal = refused();
        if (refusal) return route.fulfill(refusal);
        if (body.status === "active" || body.status === "retired") {
          fact.status = body.status;
        }
        bump(one[1]);
      }
      return route.fulfill(json(entryOf(fact, versionOf(one[1]))));
    }
    seen.listReads += 1;
    if (options.fail) {
      return route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://bakery.example/problems/test",
          title: "INTERNAL_ERROR",
          detail: "INTERNAL_ERROR",
          status: 500,
          code: "INTERNAL_ERROR",
          retryable: true,
          requestId: crypto.randomUUID(),
          traceId: crypto.randomUUID(),
        }),
      });
    }
    return route.fulfill(json({
      items: live.filter((fact) => !fact.unlisted).map((fact) =>
        entryOf(fact, versionOf(uuid(fact.n)))
      ),
      nextCursor: null,
    }));
  });
  return seen;
}

/** The organization's event socket: it answers a subscription with a cursor, and pushes a memory signal on request. */
async function memoryEvents(page: Page) {
  const sockets: WebSocketRoute[] = [];
  const requests = new Map<WebSocketRoute, string>();
  const subscribes: { scopes: unknown }[] = [];
  let sequence = 1;
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
      const frame = JSON.parse(String(message)) as {
        type: string;
        requestId: string;
        scopes: unknown;
      };
      if (frame.type !== "subscribe") return;
      subscribes.push({ scopes: frame.scopes });
      requests.set(socket, frame.requestId);
      sequence += 1;
      socket.send(JSON.stringify({
        type: "cursor",
        requestId: frame.requestId,
        cursor: `cursor-${sequence}`,
        highwater: String(sequence),
      }));
    });
  });
  return {
    subscribes,
    /** The server tells the open tab that fact `n` was revised. */
    revised: (n: number) => {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("no event socket is open");
      sequence += 1;
      socket.send(JSON.stringify({
        type: "events",
        requestId: requests.get(socket),
        events: [{
          id: crypto.randomUUID(),
          sequence: String(sequence),
          type: "memory.revised",
          schemaVersion: 1,
          occurredAt: STAMP,
          repositoryId: null,
          taskId: null,
          conversationId: null,
          workerHostId: null,
          workerEnrollmentId: null,
          payload: { resourceId: uuid(n), resourceVersion: sequence },
        }],
        highwater: String(sequence),
      }));
    },
    sourceChanged: (n: number) => {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("no event socket is open");
      sequence += 1;
      socket.send(JSON.stringify({
        type: "events",
        requestId: requests.get(socket),
        events: [{
          id: crypto.randomUUID(),
          sequence: String(sequence),
          type: "memory.source_changed",
          schemaVersion: 1,
          occurredAt: STAMP,
          repositoryId: null,
          taskId: null,
          conversationId: null,
          workerHostId: null,
          workerEnrollmentId: null,
          payload: { resourceId: uuid(n), resourceVersion: sequence },
        }],
        highwater: String(sequence),
      }));
    },
    drop: () => sockets.at(-1)?.close(),
  };
}

for (
  const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: memory tab`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    const row = (page: Page, n: number) =>
      page.getByTestId("library-memory").locator(
        `[data-library-id="${uuid(n)}"]`,
      );

    test("lists each fact with one badge and where it came from, retired facts last, from one read", async ({ page }) => {
      const seen = await memoryFixture(page);
      await page.goto("/library?tab=memory");
      await expect(page.getByRole("tab", { name: "Memory" })).toBeVisible();
      await expect(
        page.getByText("Facts agents are given before they start work."),
      ).toBeVisible();
      await expect(row(page, 1)).toContainText(
        "Deploys run from main, never from a branch.",
      );
      await expect(row(page, 1)).toContainText("In use");
      await expect(row(page, 1)).toContainText(
        "Source: Runbook, version 3 · corrected 2 times",
      );
      await expect(row(page, 1)).toContainText("Repository: api-service");
      await expect(row(page, 2)).toContainText("Suggested");
      // A suggestion waits on a person: its button says Review.
      await expect(row(page, 2).getByRole("button")).toHaveText("Review");
      await expect(row(page, 1).getByRole("button")).toHaveText("Open");
      await expect(row(page, 2)).toContainText("Source: Runbook, version 3");
      await expect(row(page, 2)).not.toContainText("corrected");
      await expect(row(page, 3)).toContainText("Source missing");
      await expect(row(page, 3)).toContainText("Its source was deleted");
      await expect(row(page, 3)).toContainText("Repository: web-app");
      await expect(row(page, 4)).toContainText("In use");
      await expect(row(page, 4)).toContainText(
        "You do not have access to its source",
      );
      // Nothing names a document the reader may not see.
      await expect(row(page, 4)).not.toContainText("Runbook");
      await expect(row(page, 5)).toContainText("No longer used");
      // Facts no longer used come last.
      const ids = await page.getByTestId("library-memory").locator(
        "[data-library-id]",
      )
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-library-id"))
        );
      expect(ids.at(-1)).toBe(uuid(5));
      // The list needs no read per fact: no revision is read until a fact is
      // opened. (The shell re-issues its first reads once it restores the
      // organization, so the number of list requests is not asserted.)
      expect(seen.revisionReads).toEqual([]);
      await page.mouse.move(700, 700);
      await shot(page, "library-memory-list");
    });

    test("opening a fact shows its wording, source, confidence, expiry and every wording it has had", async ({ page }) => {
      const seen = await memoryFixture(page);
      await page.goto("/library?tab=memory");
      await row(page, 1).getByRole("button", { name: /^Open fact:/ }).click();
      await expect(page).toHaveURL(new RegExp(`fact=${uuid(1)}`));
      const sheet = page.getByTestId("memory-fact");
      await expect(sheet.getByTestId("memory-fact-body")).toHaveText(
        "Deploys run from main, never from a branch.",
      );
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "Runbook, version 3",
      );
      await expect(sheet).toContainText("How sure: High");
      await expect(sheet).toContainText("It is a guide, not a measurement.");
      await expect(sheet).toContainText("Expires:");
      await expect(sheet).toContainText("2027");
      const history = sheet.getByTestId("memory-history");
      await expect(history.getByRole("listitem")).toHaveCount(3);
      // Newest first; the current one is marked In use, earlier ones are earlier wordings with their reasons.
      await expect(history.getByRole("listitem").first()).toContainText(
        "In use",
      );
      await expect(history.getByRole("listitem").nth(1)).toContainText(
        "Earlier wording",
      );
      await expect(history.getByRole("listitem").nth(1)).toContainText(
        '"Correction 1"',
      );
      // Only the opened fact's history is read.
      expect([...new Set(seen.revisionReads)]).toEqual([uuid(1)]);
      await shot(page, "library-memory-fact", [], { windowOnly: true });
      await sheet.getByRole("button", { name: "Close" }).click();
      await expect(sheet).toHaveCount(0);
      await expect(page).not.toHaveURL(/fact=/);
      await expect(row(page, 1)).toBeVisible();
    });

    test("a fact with a deleted source says so and what to do; no access names nothing", async ({ page }) => {
      await memoryFixture(page);
      await page.goto("/library?tab=memory");
      await row(page, 3).getByRole("button", { name: /^Open fact:/ }).click();
      const sheet = page.getByTestId("memory-fact");
      await expect(sheet).toContainText("Source missing");
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "This source was deleted.",
      );
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "Bakery still gives agents this fact.",
      );
      await expect(sheet).toContainText("How sure: Low");
      await expect(sheet).toContainText("Expires: Never");
      await shot(page, "library-memory-source-missing", [], {
        windowOnly: true,
      });
      await sheet.getByRole("button", { name: "Close" }).click();
      await row(page, 4).getByRole("button", { name: /^Open fact:/ }).click();
      const denied = page.getByTestId("memory-fact");
      await expect(denied.getByTestId("memory-source")).toContainText(
        "You do not have access to this source.",
      );
      await expect(denied.getByTestId("memory-source")).toContainText(
        "Someone who can open it can check this fact.",
      );
      await expect(denied).not.toContainText("Runbook");
    });

    const open = async (page: Page, n: number) => {
      await page.goto("/library?tab=memory");
      await row(page, n).getByRole("button", { name: /^Open fact:/ }).click();
      return page.getByTestId("memory-fact");
    };

    test("approving a suggested fact puts it in use, sending the fact's version, and there is no Reject", async ({ page }) => {
      const seen = await memoryFixture(page);
      const sheet = await open(page, 2);
      await expect(sheet).toContainText(
        "Agents are not given a suggested fact. Check it against its source, then decide.",
      );
      // The wording is the fact's own state, not "In use".
      const first = sheet.getByTestId("memory-history").getByRole("listitem")
        .first();
      await expect(first).toContainText("Suggested");
      await expect(first).not.toContainText("In use");
      await expect(sheet.getByRole("button", { name: "Approve", exact: true }))
        .toBeVisible();
      await expect(
        sheet.getByRole("button", { name: "Correct, then approve" }),
      ).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Don't use" }))
        .toBeVisible();
      await expect(sheet.getByRole("button", { name: /reject/i })).toHaveCount(
        0,
      );
      await shot(page, "library-memory-review", [], { windowOnly: true });
      await sheet.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(sheet.getByTestId("memory-toast")).toContainText(
        "Approved. Agents are given this fact from their next run.",
      );
      await expect(row(page, 2)).toContainText("In use");
      expect(seen.updates).toHaveLength(1);
      expect(seen.updates[0]).toMatchObject({
        id: uuid(2),
        ifMatch: '"v1"',
        body: { status: "active" },
      });
      expect(seen.updates[0].key).toBeTruthy();
      await expect(sheet.getByRole("button", { name: "Approve", exact: true }))
        .toHaveCount(
          0,
        );
      await expect(sheet.getByRole("button", { name: "Stop using" }))
        .toBeVisible();
    });

    test("a correction needs the wording, the reason and a source; saving it adds a wording and approves it", async ({ page }) => {
      const seen = await memoryFixture(page);
      const sheet = await open(page, 2);
      await sheet.getByRole("button", { name: "Correct, then approve" })
        .click();
      const form = sheet.getByTestId("memory-correct");
      const wording = form.getByLabel("What should agents be told instead?");
      await expect(wording).toHaveValue(
        "The staging database is reset every Monday.",
      );
      await form.getByRole("button", { name: "Save and approve" }).click();
      await expect(form).toContainText("Say why it is changing.");
      await expect(form).toContainText("Choose the source.");
      await expect(form).not.toContainText("Enter the new wording.");
      await wording.fill("");
      await form.getByRole("button", { name: "Save and approve" }).click();
      await expect(form).toContainText("Enter the new wording.");
      expect(seen.revisions).toEqual([]);
      await wording.fill("The staging database is reset every Tuesday.");
      await form.getByLabel("Why is this changing?").fill(
        "The reset moved.",
      );
      // Source is required, like the other two fields.
      await expect(form.getByText("Source *")).toBeVisible();
      await form.locator("select").selectOption({ label: "Deploy runbook" });
      // The help names the exact version Bakery will link.
      await expect(form).toContainText(
        "Bakery will link version 4 of Deploy runbook.",
      );
      // One viewport only: changing the size would swap the panel between the
      // inspector column and the bottom sheet and drop the open form.
      await shot(page, "library-memory-correct", [], {
        windowOnly: true,
        only: viewport.name === "desktop" ? "desktop" : "mobile",
      });
      await form.getByRole("button", { name: "Save and approve" }).click();
      await expect(sheet.getByTestId("memory-toast")).toContainText(
        "Correction saved and approved.",
      );
      await expect(form).toHaveCount(0);
      expect(seen.revisions).toHaveLength(1);
      expect(seen.revisions[0].body).toEqual({
        content: "The staging database is reset every Tuesday.",
        reason: "The reset moved.",
        sourceArtifactVersionId: uuid(7101),
      });
      // The correction changed the fact, so approval is sent against its new version.
      expect(seen.updates).toHaveLength(1);
      expect(seen.updates[0]).toMatchObject({
        id: uuid(2),
        ifMatch: '"v2"',
        body: { status: "active" },
      });
      await expect(row(page, 2)).toContainText("In use");
      await expect(row(page, 2)).toContainText("corrected once");
      // The page's own correction is not announced as someone else's.
      await expect(sheet.getByTestId("memory-changed-by-other")).toHaveCount(0);
      await expect(sheet.getByTestId("memory-fact-body")).toHaveText(
        "The staging database is reset every Tuesday.",
      );
    });

    test("stopping use asks first; Undo puts the fact back, against the version it then has", async ({ page }) => {
      const seen = await memoryFixture(page);
      const sheet = await open(page, 1);
      await sheet.getByRole("button", { name: "Stop using" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Stop using this fact?");
      await expect(dialog).toContainText("you can use it again");
      expect(seen.updates).toEqual([]);
      await dialog.getByRole("button", { name: "Stop using" }).click();
      await expect(sheet.getByTestId("memory-toast")).toContainText(
        "Stopped using this fact.",
      );
      await expect(row(page, 1)).toContainText("No longer used");
      await sheet.getByRole("button", { name: "Undo" }).click();
      await expect(row(page, 1)).toContainText("In use");
      expect(seen.updates.map((update) => [update.ifMatch, update.body]))
        .toEqual([
          ['"v1"', { status: "retired" }],
          ['"v2"', { status: "active" }],
        ]);
    });

    test("declining a suggestion keeps it as No longer used, and a retired fact offers only Use again", async ({ page }) => {
      const seen = await memoryFixture(page);
      const sheet = await open(page, 2);
      await sheet.getByRole("button", { name: "Don't use" }).click();
      await expect(sheet.getByTestId("memory-toast")).toContainText(
        "Not used. It stays in the list as No longer used.",
      );
      expect(seen.updates[0].body).toEqual({ status: "retired" });
      await expect(row(page, 2)).toContainText("No longer used");
      await expect(sheet.getByRole("button", { name: "Use again" }))
        .toBeVisible();
      await expect(sheet.getByRole("button", { name: "Correct" })).toHaveCount(
        0,
      );
      await expect(sheet.getByRole("button", { name: "Approve", exact: true }))
        .toHaveCount(
          0,
        );
      await sheet.getByRole("button", { name: "Use again" }).click();
      await expect(row(page, 2)).toContainText("In use");
    });

    test("a refusal is said in plain words and nothing is claimed as done", async ({ page }) => {
      const seen = await memoryFixture(page, WORLD, {
        refuse: "conflict_detected",
      });
      const sheet = await open(page, 2);
      await sheet.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(sheet.getByTestId("memory-failure")).toContainText(
        "Another fact on the same topic is already in use. Stop using that one first.",
      );
      await expect(sheet.getByTestId("memory-toast")).toHaveCount(0);
      await expect(row(page, 2)).toContainText("Suggested");
      expect(seen.updates).toHaveLength(1);
    });

    test("a refused correction keeps what was typed and says why nothing changed", async ({ page }) => {
      const seen = await memoryFixture(page, WORLD, {
        refuse: "source_artifact_unknown",
      });
      const sheet = await open(page, 1);
      await sheet.getByRole("button", { name: "Correct", exact: true })
        .click();
      const form = sheet.getByTestId("memory-correct");
      await form.getByLabel("What should agents be told instead?").fill(
        "Deploys run from main after review.",
      );
      await form.getByLabel("Why is this changing?").fill("Review is new.");
      await form.locator("select").selectOption({ label: "Release checklist" });
      await form.getByRole("button", { name: "Save correction" }).click();
      await expect(sheet.getByTestId("memory-failure")).toContainText(
        "The source could not be found, so nothing was changed.",
      );
      await expect(form.getByLabel("What should agents be told instead?"))
        .toHaveValue("Deploys run from main after review.");
      await expect(form.getByLabel("Why is this changing?")).toHaveValue(
        "Review is new.",
      );
      expect(seen.revisions).toHaveLength(1);
      await expect(sheet.getByTestId("memory-toast")).toHaveCount(0);
    });

    test("only an administrator is offered changes; a developer is told so", async ({ page }) => {
      await memoryFixture(page, WORLD, { role: "developer" });
      const sheet = await open(page, 2);
      await expect(sheet.getByTestId("memory-admin-only")).toContainText(
        "Only an administrator can change remembered facts.",
      );
      for (
        const name of ["Approve", "Correct, then approve", "Don't use"]
      ) {
        await expect(sheet.getByRole("button", { name })).toHaveCount(0);
      }
    });

    test("another person's correction reaches the open tab; the notice says so, History names who, and it goes when a change starts", async ({ page }) => {
      const seen = await memoryFixture(page);
      const events = await memoryEvents(page);
      const sheet = await open(page, 1);
      await expect.poll(() => events.subscribes.length).toBeGreaterThan(0);
      expect(events.subscribes[0].scopes).toContainEqual({
        type: "memory",
        id: MOCK_ORGANIZATION_ID,
      });
      await expect(sheet.getByTestId("memory-changed-by-other")).toHaveCount(0);
      seen.correct(1, "Deploys run from main after review.");
      events.revised(1);
      await expect(sheet.getByTestId("memory-fact-body")).toHaveText(
        "Deploys run from main after review.",
      );
      const notice = sheet.getByTestId("memory-changed-by-other");
      await expect(notice).toContainText(
        "This fact was corrected while you had it open. The new wording is shown.",
      );
      // Announced politely, not as an alert.
      await expect(notice).toHaveAttribute("role", "status");
      // History reloaded with the fact: its newest entry is the new wording and
      // says who made it, when and why (it replaces a name in the notice).
      const newest = sheet.getByTestId("memory-history").getByRole("listitem")
        .first();
      await expect(newest).toContainText("Deploys run from main after review.");
      await expect(newest).toContainText("by Grace Hopper");
      await expect(newest).toContainText("Correction 3");
      await expect(row(page, 1)).toContainText("corrected 3 times");
      await shot(page, "library-memory-changed", [], {
        windowOnly: true,
        only: viewport.name === "desktop" ? "desktop" : "mobile",
      });
      // Starting a change ends the notice.
      await sheet.getByRole("button", { name: "Correct", exact: true }).click();
      await expect(sheet.getByTestId("memory-changed-by-other")).toHaveCount(0);
    });

    test("the notice shows only for the fact that is open, and not again after the panel closes", async ({ page }) => {
      const seen = await memoryFixture(page);
      const events = await memoryEvents(page);
      const sheet = await open(page, 1);
      await expect.poll(() => events.subscribes.length).toBeGreaterThan(0);
      // Another fact is corrected: its row updates, the open fact says nothing.
      seen.correct(2, "The staging database is reset on Tuesdays.");
      events.revised(2);
      await expect(row(page, 2)).toContainText("corrected once");
      await expect(sheet.getByTestId("memory-changed-by-other")).toHaveCount(0);
      // The open fact is corrected, then the panel closes and opens again.
      seen.correct(1, "Deploys run from main after review.");
      events.revised(1);
      await expect(sheet.getByTestId("memory-changed-by-other")).toBeVisible();
      await sheet.getByRole("button", { name: "Close" }).click();
      await row(page, 1).getByRole("button", { name: /^Open fact:/ }).click();
      await expect(
        page.getByTestId("memory-fact").getByTestId("memory-changed-by-other"),
      ).toHaveCount(0);
    });

    test("starting Approve while the corrected-while-open notice shows ends the notice", async ({ page }) => {
      const seen = await memoryFixture(page);
      const events = await memoryEvents(page);
      // Fact 2 is a suggestion, so Approve is offered.
      const sheet = await open(page, 2);
      await expect.poll(() => events.subscribes.length).toBeGreaterThan(0);
      seen.correct(2, "The staging database is reset on Tuesdays.");
      events.revised(2);
      await expect(sheet.getByTestId("memory-changed-by-other")).toBeVisible();
      await sheet.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(sheet.getByTestId("memory-changed-by-other")).toHaveCount(0);
    });

    test("a source removed while the fact is open changes the badge and the source box, with no notice", async ({ page }) => {
      const seen = await memoryFixture(page);
      const events = await memoryEvents(page);
      const sheet = await open(page, 1);
      await expect.poll(() => events.subscribes.length).toBeGreaterThan(0);
      seen.deleteSource(1);
      events.sourceChanged(1);
      await expect(row(page, 1)).toContainText("Source missing");
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "This source was deleted.",
      );
      await expect(sheet.getByTestId("memory-changed-by-other")).toHaveCount(0);
    });

    test("another person's correction while the Correct form is open keeps what was typed and says to make the change again", async ({ page }) => {
      const seen = await memoryFixture(page);
      const events = await memoryEvents(page);
      const sheet = await open(page, 1);
      await expect.poll(() => events.subscribes.length).toBeGreaterThan(0);
      await sheet.getByRole("button", { name: "Correct", exact: true }).click();
      const form = sheet.getByTestId("memory-correct");
      const wording = form.getByLabel("What should agents be told instead?");
      await wording.fill("My own new wording.");
      seen.correct(1, "Their wording.");
      events.revised(1);
      const notice = sheet.getByTestId("memory-changed-by-other");
      await expect(notice).toContainText(
        "Someone else changed this fact. Their wording is shown; make your change again.",
      );
      await expect(wording).toHaveValue("My own new wording.");
      await expect(row(page, 1)).toContainText("corrected 3 times");
    });

    test("a dropped connection says updates are paused, then clears when it is back", async ({ page }) => {
      await memoryFixture(page);
      const events = await memoryEvents(page);
      await page.goto("/library?tab=memory");
      await expect.poll(() => events.subscribes.length).toBe(1);
      await expect(page.getByTestId("memory-stale")).toHaveCount(0);
      events.drop();
      await expect(page.getByTestId("memory-stale")).toContainText(
        "Live updates are paused. Reconnecting.",
      );
      await shot(page, "library-memory-paused", [], {
        windowOnly: true,
        only: viewport.name === "desktop" ? "desktop" : "mobile",
      });
      await expect.poll(() => events.subscribes.length).toBe(2);
      await expect(page.getByTestId("memory-stale")).toHaveCount(0);
    });

    test("the source is a link to the cited version; a source nobody here may open is not", async ({ page }) => {
      await memoryFixture(page);
      const sheet = await open(page, 1);
      const link = sheet.getByTestId("memory-source").getByRole("link", {
        name: "Runbook, version 3",
      });
      await expect(link).toHaveAttribute(
        "href",
        `/files/versions/${uuid(7001)}`,
      );
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "Opens that exact version, not the latest.",
      );
      await shot(page, "library-memory-source-link", [], {
        windowOnly: true,
        only: viewport.name === "desktop" ? "desktop" : "mobile",
      });
      await link.click();
      await expect(page).toHaveURL(
        new RegExp(`/files/versions/${uuid(7001)}$`),
      );
      await page.goto(`/library?tab=memory&fact=${uuid(4)}`);
      await expect(page.getByTestId("memory-source")).toContainText(
        "You do not have access to this source.",
      );
      await expect(
        page.getByTestId("memory-source").getByRole("link"),
      ).toHaveCount(0);
    });

    test("Retry on a source that could not be checked reads the fact again and shows what it finds", async ({ page }) => {
      const seen = await memoryFixture(page, [
        { n: 6, body: "Retries use jittered backoff.", source: "unknown" },
      ]);
      const sheet = await open(page, 6);
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "This source could not be checked right now.",
      );
      // Hold the next reads, so the in-flight state can be seen.
      let hold = true;
      await page.route("**/v1/memories**", async (route) => {
        if (hold) await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.fallback();
      });
      seen.recover(6);
      await sheet.getByRole("button", { name: "Try again" }).click();
      const checking = sheet.getByRole("button", { name: "Checking…" });
      await expect(checking).toBeVisible();
      await expect(checking).toBeDisabled();
      await shot(page, "library-memory-source-checking", [], {
        windowOnly: true,
        only: viewport.name === "desktop" ? "desktop" : "mobile",
      });
      hold = false;
      await expect(sheet.getByTestId("memory-source")).toContainText(
        "Runbook, version 3",
        { timeout: 15000 },
      );
    });

    test("a failed read of one fact says it could not be loaded; Try again reads it again", async ({ page }) => {
      await memoryFixture(page, [
        ...WORLD,
        { n: 7, body: "Hidden from the list, fetched by id.", unlisted: true },
      ]);
      let fail = true;
      let reads = 0;
      await page.route(`**/v1/memories/${uuid(7)}`, (route) => {
        reads += 1;
        return fail
          ? route.fulfill({
            status: 500,
            contentType: "application/problem+json",
            body: JSON.stringify({
              type: "https://bakery.example/problems/test",
              title: "INTERNAL_ERROR",
              detail: "INTERNAL_ERROR",
              status: 500,
              code: "INTERNAL_ERROR",
              retryable: false,
              requestId: crypto.randomUUID(),
              traceId: crypto.randomUUID(),
            }),
          })
          : route.fallback();
      });
      await page.goto(`/library?tab=memory&fact=${uuid(7)}`);
      await expect(page.getByText("This fact could not be loaded")).toHaveCount(
        1,
        { timeout: 30000 },
      );
      await expect(page.getByTestId("memory-fact-missing")).toContainText(
        "Check your connection, then try again.",
      );
      await shot(page, "library-memory-load-failed", [], {
        windowOnly: true,
        only: viewport.name === "desktop" ? "desktop" : "mobile",
      });
      fail = false;
      const before = reads;
      await page.getByTestId("memory-fact-missing").getByRole("button", {
        name: "Try again",
      }).click();
      await expect(page.getByTestId("memory-fact-body")).toHaveText(
        "Hidden from the list, fetched by id.",
      );
      expect(reads).toBeGreaterThan(before);
    });

    test("a link to a fact the list does not hold opens it", async ({ page }) => {
      await memoryFixture(page, [
        ...WORLD,
        { n: 7, body: "Hidden from the list, fetched by id.", unlisted: true },
      ]);
      await page.goto(`/library?tab=memory&fact=${uuid(7)}`);
      await expect(page.getByTestId("memory-fact-body")).toHaveText(
        "Hidden from the list, fetched by id.",
      );
    });

    // Gone (404) and not yours (403) read the same.
    for (
      const [why, id] of [["gone", 99], ["not yours", 98]] as const
    ) {
      test(`a link to a fact that is ${why} says it was not found; Close returns to the list`, async ({ page }) => {
        await memoryFixture(page, WORLD);
        await page.goto(`/library?tab=memory&fact=${uuid(id)}`);
        const missing = page.getByTestId("memory-fact-missing");
        // The title shows once: a doubled one would read as a layout bug.
        await expect(page.getByText("This fact was not found")).toHaveCount(1);
        await expect(missing).toContainText(
          "It may have been removed, or you may not have access to it.",
        );
        if (id === 99) {
          await shot(page, "library-memory-missing", [], {
            windowOnly: true,
            only: viewport.name === "desktop" ? "desktop" : "mobile",
          });
        }
        await missing.getByRole("button", { name: "Close" }).click();
        await expect(missing).toHaveCount(0);
        await expect(page).not.toHaveURL(/fact=/);
      });
    }

    if (viewport.name === "desktop") {
      test("arrow keys move between facts and Enter opens the one in focus", async ({ page }) => {
        await memoryFixture(page);
        await page.goto("/library?tab=memory");
        const buttons = page.locator("[data-arrow-row] button");
        await expect(buttons.nth(1)).toBeVisible();
        await buttons.nth(0).focus();
        await page.keyboard.press("ArrowUp");
        await expect(buttons.nth(0)).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(buttons.nth(1)).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(buttons.nth(2)).toBeFocused();
        await page.keyboard.press("ArrowUp");
        await expect(buttons.nth(1)).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/fact=/);
      });

      test("Enter moves into the fact, and Escape closes it back to its row", async ({ page }) => {
        await memoryFixture(page);
        await page.goto("/library?tab=memory");
        const button = page.locator("[data-arrow-row] button").nth(1);
        await button.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("memory-fact")).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("memory-fact")).toHaveCount(0);
        await expect(button).toBeFocused();
      });

      test("modified arrows, and arrows past the ends, are left to the browser", async ({ page }) => {
        await memoryFixture(page);
        await page.goto("/library?tab=memory");
        const buttons = page.locator("[data-arrow-row] button");
        await buttons.nth(0).focus();
        await page.evaluate(() => {
          addEventListener("keydown", (event) => {
            if (!event.key.startsWith("Arrow")) return;
            document.body.dataset.taken = `${
              document.body.dataset.taken ?? ""
            }${event.defaultPrevented ? "y" : "n"}`;
          });
        });
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("Control+ArrowDown");
        await page.keyboard.press("Alt+ArrowDown");
        await expect(buttons.nth(0)).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(buttons.nth(1)).toBeFocused();
        await expect(page.locator("body")).toHaveAttribute(
          "data-taken",
          "nnny",
        );
      });

      test("on a wide screen the list stays beside the fact; Escape closes it and returns to the row", async ({ page }) => {
        await memoryFixture(page);
        const sheet = await open(page, 1);
        // No backdrop: another row can be opened while this one is.
        await row(page, 3).getByRole("button", { name: /^Open fact:/ }).click();
        await expect(page).toHaveURL(new RegExp(`fact=${uuid(3)}`));
        await expect(sheet.getByTestId("memory-fact-body")).toHaveText(
          "Releases are tagged by the on-call engineer.",
        );
        await expect(row(page, 3)).toHaveAttribute("aria-current", "true");
        // Marked on the row itself too, not only for assistive technology.
        await expect(row(page, 3).locator('[data-selected="true"]'))
          .toHaveCount(
            1,
          );
        await expect(row(page, 1).locator('[data-selected="true"]'))
          .toHaveCount(
            0,
          );
        await expect(row(page, 1)).not.toHaveAttribute("aria-current", "true");
        await page.keyboard.press("Escape");
        await expect(sheet).toHaveCount(0);
        await expect(page).not.toHaveURL(/fact=/);
        await expect(row(page, 3).getByRole("button")).toBeFocused();
      });
    }
  });
}

test.describe("memory tab states", () => {
  test("no facts shows the empty state; a failed read says so and Try again reads again", async ({ page }) => {
    await memoryFixture(page, []);
    await page.goto("/library?tab=memory");
    await expect(page.getByText("No remembered facts yet")).toBeVisible();
    await expect(
      page.getByText(
        "Facts Bakery remembers about your repositories appear here",
      ),
    ).toBeVisible();
  });

  test("a failed read says so, and Try again reads the list again", async ({ page }) => {
    const seen = await memoryFixture(page, WORLD, { fail: true });
    await page.goto("/library?tab=memory");
    await expect(page.getByText("The library could not be loaded."))
      .toBeVisible();
    const before = seen.listReads;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => seen.listReads).toBeGreaterThan(before);
  });

  test("Memory is a Library tab and the others still open", async ({ page }) => {
    await memoryFixture(page);
    await page.goto("/library");
    await page.getByRole("tab", { name: "Memory" }).click();
    await expect(page).toHaveURL(/tab=memory/);
    await page.getByRole("tab", { name: "Workflows" }).click();
    await expect(page).not.toHaveURL(/tab=/);
    await expect(page.getByTestId("library-built-in")).toBeVisible();
  });
});

// The organization the stubs answer for.
void MOCK_ORGANIZATION_ID;
