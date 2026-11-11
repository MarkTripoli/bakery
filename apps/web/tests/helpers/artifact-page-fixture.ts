import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type {
  ArtifactCommentResponse,
  ArtifactResponse,
  ArtifactVersionResponse,
  MessageResponse,
  TaskResponse,
} from "../../src/api/client.ts";
import {
  MOCK_ORGANIZATION_ID,
  MOCK_PRINCIPAL_ID,
  mockAuthenticatedSession,
} from "./mock-session.ts";

export const TASK_ID = "00000000-0000-4000-8000-000000000101";
export const ARTIFACT_ID = "00000000-0000-4000-8000-000000000102";
export const OLD_VERSION_ID = "00000000-0000-4000-8000-000000000103";
export const VERSION_ID = "00000000-0000-4000-8000-000000000104";
export const CONVERSATION_ID = "00000000-0000-4000-8000-000000000105";
export const COMMENT_ID = "00000000-0000-4000-8000-000000000106";
export const PATH = `/tasks/${TASK_ID}/artifacts/${ARTIFACT_ID}`;
const timestamp = "2026-01-01T00:00:00.000Z";
export const ARTIFACT: ArtifactResponse = {
  id: ARTIFACT_ID,
  taskId: TASK_ID,
  artifactType: "plan",
  name: "Reviewable artifact",
  currentVersionId: VERSION_ID,
  pinnedAt: null,
  pinnedBy: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 1,
};
export const CONTENT = "Verified current revision\n";
export const OLD_CONTENT = "Verified original revision\n";

export function version(
  content: string,
  mediaType = "text/plain",
): ArtifactVersionResponse {
  return {
    id: VERSION_ID,
    artifactId: ARTIFACT_ID,
    revision: 2,
    runStepId: null,
    authorId: MOCK_PRINCIPAL_ID,
    mediaType,
    sizeBytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    subjectHeadSha: null,
    subjectBaseSha: null,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };
}

export const ROOT: ArtifactCommentResponse = {
  id: COMMENT_ID,
  artifactVersionId: OLD_VERSION_ID,
  authorId: MOCK_PRINCIPAL_ID,
  body: "Original revision feedback",
  anchor: null,
  status: "open",
  resolvedBy: null,
  rootId: null,
  resolvedAt: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 3,
  placement: { viewVersionId: VERSION_ID, status: "outdated", anchor: null },
};

export const MESSAGE: MessageResponse = {
  id: "00000000-0000-4000-8000-000000000107",
  conversationId: CONVERSATION_ID,
  authorId: MOCK_PRINCIPAL_ID,
  agentSessionId: null,
  messageType: "user",
  body: "Apply this feedback",
  clientMessageId: "request-fixture",
  replyToId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 1,
  sequence: "1",
  intent: "agent_request",
  commentContext: null,
};

const task: TaskResponse = {
  id: TASK_ID,
  applicationId: ARTIFACT_ID,
  repositoryId: null,
  conversationId: CONVERSATION_ID,
  parentTaskId: null,
  title: "Artifact review",
  description: "Review retained versions",
  taskType: "feature",
  status: "active",
  priority: 50,
  createdBy: MOCK_PRINCIPAL_ID,
  currentRunId: null,
  archivedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  version: 1,
};

export function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

export function problem(status: number, code: string) {
  return {
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({
      type: `https://bakery.example/problems/${code.toLowerCase()}`,
      title: code,
      detail: `Stubbed ${code}.`,
      status,
      code,
      requestId: TASK_ID,
      traceId: ARTIFACT_ID,
      retryable: false,
    }),
  };
}

export type ArtifactFixture = {
  readonly current: ArtifactVersionResponse;
  readonly content: string;
  readonly roots: readonly ArtifactCommentResponse[];
};

export async function openComments(page: Page) {
  await expect(page.getByTestId("artifact-retrieval-page")).toBeVisible();
  const trigger = page.getByRole("button", { name: "Comments", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  await expect(page.getByLabel("Comment", { exact: true })).toBeVisible();
}

export async function stubArtifactPage(
  page: Page,
  overrides: Partial<ArtifactFixture> = {},
) {
  const fixture: ArtifactFixture = {
    current: version(CONTENT),
    content: CONTENT,
    roots: [ROOT],
    ...overrides,
  };
  const original = { ...version(OLD_CONTENT), id: OLD_VERSION_ID, revision: 1 };
  await mockAuthenticatedSession(page);
  await page.route("**/v1/artifact-storage", (route) =>
    route.fulfill(json({
      state: "unmonitored",
      totalBytes: 0,
      availableBytes: 0,
      usedPercent: 0,
      retainedBytes: 0,
      pinnedBytes: 0,
    })));
  // Previews are a deployment option; the fixture deployment configures none.
  await page.route(
    "**/v1/artifact-preview-availability",
    (route) => route.fulfill(json({ available: false })),
  );
  await page.route("**/v1/me/profile", (route) =>
    route.fulfill(json({
      principalId: MOCK_PRINCIPAL_ID,
      name: "Fixture Admin",
      firstName: null,
      lastName: null,
      title: null,
      image: null,
      email: "fixture-admin@example.test",
      emailVerified: true,
      version: 1,
      updatedAt: timestamp,
    })));
  await page.route(
    "**/v1/organizations/*/effective-access",
    (route) =>
      route.fulfill(json({
        organizationId: MOCK_ORGANIZATION_ID,
        role: "developer",
        capabilities: [],
      })),
  );
  await page.route(
    `**/v1/tasks/${TASK_ID}`,
    (route) => route.fulfill(json(task)),
  );
  await page.route("**/v1/artifacts**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/comments")) {
      return route.fulfill(json({ items: fixture.roots, nextCursor: null }));
    }
    if (path.endsWith("/versions")) {
      return route.fulfill(
        json({ items: [fixture.current, original], nextCursor: null }),
      );
    }
    return route.fulfill(
      json(
        path.endsWith(ARTIFACT_ID)
          ? ARTIFACT
          : { items: [ARTIFACT], nextCursor: null },
      ),
    );
  });
  await page.route("**/v1/artifact-versions/**/content", (route) => {
    const old = route.request().url().includes(OLD_VERSION_ID);
    const selected = old ? original : fixture.current;
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": selected.mediaType,
        "content-length": String(selected.sizeBytes),
        "content-disposition": 'attachment; filename="artifact.txt"',
        etag: `"${selected.sha256}"`,
      },
      body: old ? OLD_CONTENT : fixture.content,
    });
  });
}
