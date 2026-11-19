import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { LoroDoc } from "loro-crdt/base64";
import {
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "../../src/collaboration/binary-frame.ts";
import {
  ARTIFACT_ID,
  json,
  PATH,
  problem,
  stubArtifactPage,
  TASK_ID,
} from "./artifact-page-fixture.ts";

export const DRAFT = "11111111-1111-4111-8111-111111111111";
const ROOM = { kind: "draft", id: DRAFT };
const CHECKPOINT = "88888888-8888-4888-8888-888888888888";
const CHECKPOINT_AFTER = "99999999-9999-4999-8999-999999999999";
const NIL = "00000000-0000-0000-0000-000000000000";

export type Behaviour = {
  /** What the server does with each client update. */
  readonly onUpdate?: "ack" | "reject" | "ignore";
  readonly participants?: readonly unknown[];
  /** After serverClose() every new connection is closed at once, so the page stays offline. */
  readonly refuseReconnect?: boolean;
  /** Whether this person may publish (the draft's canPublish). Default true. */
  readonly canPublish?: boolean;
  /** Agent suggestions waiting on the draft. Default none. */
  readonly suggestions?: number;
  /**
   * The answer to each publish request in turn: ok creates version 3, moved is
   * a 412 (the text moved on), lost is a 503 that may have happened, and
   * forbidden is a 403. The last answer repeats.
   */
  readonly publish?: readonly ("ok" | "moved" | "lost" | "forbidden")[];
  /** After a refused publish the text differs (otherwise only the checkpoint moves). */
  readonly textMoves?: boolean;
  /** What looking the checkpoint up finds after a lost answer. Default absent. */
  readonly lookup?: "found" | "absent";
  /** Holds the draft read open until released, to show the reading state. */
  readonly holdRead?: Promise<void>;
};

const publication = (versionNumber: number) => ({
  draftId: DRAFT,
  epoch: 1,
  checkpointId: CHECKPOINT,
  serverSequence: "1",
  textDigest: "0".repeat(64),
  artifactId: ARTIFACT_ID,
  artifactVersionId: "00000000-0000-4000-8000-000000000199",
  versionNumber,
  sha256: "0".repeat(64),
  publishedById: "33333333-3333-4333-8333-333333333333",
  publishedByName: "Ana Reyes",
  actorKind: "person",
  publishedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * Opens the page with a scripted draft and collaboration socket: the server's
 * text comes back as a snapshot, updates are answered as the test says, and
 * everything the page sends is recorded.
 */
export async function openEditor(
  page: Page,
  text: string,
  behaviour: Behaviour = {},
) {
  await stubArtifactPage(page);
  const doc = new LoroDoc();
  doc.getText("body").insert(0, text);
  doc.commit();
  await page.route(
    "**/v1/artifacts/*/drafts",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill(json({
          id: DRAFT,
          artifactId: ARTIFACT_ID,
          taskId: TASK_ID,
          epoch: 1,
          serverSequence: "1",
          checkpointId: CHECKPOINT,
          textDigest: createHash("sha256").update(text).digest("hex"),
          text,
          receipts: [],
          canPublish: behaviour.canPublish ?? true,
        }))
        : route.fallback(),
  );
  const publishes: unknown[] = [];
  const draftBody = {
    id: DRAFT,
    artifactId: ARTIFACT_ID,
    taskId: TASK_ID,
    epoch: 1,
    serverSequence: "1",
    checkpointId: CHECKPOINT,
    textDigest: createHash("sha256").update(text).digest("hex"),
    text,
    receipts: [],
    canPublish: behaviour.canPublish ?? true,
  };
  await page.route(`**/v1/drafts/${DRAFT}`, async (route) => {
    await behaviour.holdRead;
    // After a refused publish the server is on a newer checkpoint, with the
    // text changed only when the test says so.
    const moved = publishes.length > 0;
    await route.fulfill(json(
      moved
        ? {
          ...draftBody,
          checkpointId: CHECKPOINT_AFTER,
          textDigest: behaviour.textMoves
            ? createHash("sha256").update(`${text}!`).digest("hex")
            : draftBody.textDigest,
        }
        : draftBody,
    ));
  });
  await page.route(
    `**/v1/drafts/${DRAFT}/suggestions*`,
    (route) =>
      route.fulfill(json({
        items: Array.from(
          { length: behaviour.suggestions ?? 0 },
          (_, index) => ({
            id: `00000000-0000-4000-8000-0000000002${
              String(index).padStart(2, "0")
            }`,
            draftId: DRAFT,
            epoch: 1,
            sourceCheckpointId: CHECKPOINT,
            startCursor: "c0",
            endCursor: "c1",
            expectedText: "Hello",
            replacement: "Hi",
            state: "waiting",
            refusalReason: null,
            requestedById: "44444444-4444-4444-8444-444444444444",
            requestedByName: "Review agent",
            actorKind: "agent",
            agentName: "review-agent",
            requestId: "req-1",
            decidedById: null,
            decidedByName: null,
            decidedAt: null,
            appliedServerSequence: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
        nextCursor: null,
      })),
  );
  const answers = behaviour.publish ?? ["ok"];
  await page.route(`**/v1/drafts/${DRAFT}/publications`, (route) => {
    publishes.push(route.request().postDataJSON());
    const answer = answers[Math.min(publishes.length - 1, answers.length - 1)];
    if (answer === "ok") return route.fulfill(json(publication(3)));
    if (answer === "moved") {
      return route.fulfill(problem(412, "PRECONDITION_FAILED"));
    }
    if (answer === "forbidden") {
      return route.fulfill(problem(403, "AUTH_FORBIDDEN"));
    }
    return route.fulfill(problem(503, "SERVICE_UNAVAILABLE"));
  });
  const lookups: string[] = [];
  await page.route(`**/v1/drafts/${DRAFT}/publications/*`, (route) => {
    lookups.push(route.request().url());
    return behaviour.lookup === "found"
      ? route.fulfill(json(publication(3)))
      : route.fulfill(problem(404, "RESOURCE_NOT_FOUND"));
  });
  const updates: ReturnType<typeof decodeBinaryFrame>[] = [];
  let socket: { send(message: string | Buffer): void; close(): void } | null =
    null;
  let refusing = false;
  await page.routeWebSocket(/\/v1\/collaboration/, (ws) => {
    if (refusing) {
      ws.close();
      return;
    }
    socket = ws;
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      connectionId: "99999999-9999-4999-8999-999999999999",
      heartbeatSeconds: 30,
      presenceTtlSeconds: 30,
    }));
    ws.onMessage((message) => {
      if (typeof message !== "string") {
        const frame = decodeBinaryFrame(new Uint8Array(message));
        updates.push(frame);
        const ack = behaviour.onUpdate ?? "ack";
        if (ack === "ack") {
          ws.send(
            JSON.stringify({
              type: "ack",
              room: ROOM,
              mutationId: frame.mutationId,
              receipt: null,
            }),
          );
        } else if (ack === "reject") {
          ws.send(
            JSON.stringify({
              type: "resync_required",
              room: ROOM,
              mutationId: frame.mutationId,
              reason: "rejected",
            }),
          );
        }
        return;
      }
      const frame = JSON.parse(message);
      if (frame.type === "join") {
        ws.send(JSON.stringify({
          type: "joined",
          requestId: frame.requestId,
          room: ROOM,
          participants: behaviour.participants ?? [],
        }));
      } else if (frame.type === "sync") {
        ws.send(JSON.stringify({
          type: "synced",
          requestId: frame.requestId,
          room: ROOM,
          epoch: 1,
          serverSequence: "1",
          checkpointId: CHECKPOINT,
          byteLength: text.length,
        }));
        ws.send(Buffer.from(encodeBinaryFrame({
          kind: BinaryFrameKind.ServerSnapshot,
          epoch: 1,
          draftId: DRAFT,
          mutationId: NIL,
          sequence: 1n,
          payload: doc.export({ mode: "snapshot" }),
        })));
      } else if (frame.type === "ping") {
        ws.send(message);
      }
    });
  });
  await page.goto(PATH);
  await page.getByTestId("artifact-edit-toggle").click();
  const editor = page.getByRole("textbox", { name: "Document text" });
  await expect(editor).toContainText(text.split("\n")[0]);
  return {
    editor,
    updates,
    publishes,
    lookups,
    serverSend: (frame: unknown) => socket?.send(JSON.stringify(frame)),
    serverClose: () => {
      refusing = behaviour.refuseReconnect ?? false;
      socket?.close();
    },
    room: ROOM,
  };
}
