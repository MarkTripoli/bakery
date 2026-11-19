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
  stubArtifactPage,
  TASK_ID,
} from "./artifact-page-fixture.ts";

export const DRAFT = "11111111-1111-4111-8111-111111111111";
const ROOM = { kind: "draft", id: DRAFT };
const CHECKPOINT = "88888888-8888-4888-8888-888888888888";
const NIL = "00000000-0000-0000-0000-000000000000";

export type Behaviour = {
  /** What the server does with each client update. */
  readonly onUpdate?: "ack" | "reject" | "ignore";
  readonly participants?: readonly unknown[];
  /** After serverClose() every new connection is closed at once, so the page stays offline. */
  readonly refuseReconnect?: boolean;
};

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
          canPublish: true,
        }))
        : route.fallback(),
  );
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
    serverSend: (frame: unknown) => socket?.send(JSON.stringify(frame)),
    serverClose: () => {
      refusing = behaviour.refuseReconnect ?? false;
      socket?.close();
    },
    room: ROOM,
  };
}
