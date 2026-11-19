import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { LoroDoc } from "loro-crdt/base64";
import {
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "../src/collaboration/binary-frame.ts";
import {
  ARTIFACT_ID,
  json,
  PATH,
  stubArtifactPage,
  TASK_ID,
} from "./helpers/artifact-page-fixture.ts";

const DRAFT = "11111111-1111-4111-8111-111111111111";
const ROOM = { kind: "draft", id: DRAFT };
const CHECKPOINT = "88888888-8888-4888-8888-888888888888";
const NIL = "00000000-0000-0000-0000-000000000000";

type Behaviour = {
  /** What the server does with each client update. */
  readonly onUpdate?: "ack" | "reject" | "ignore";
  readonly participants?: readonly unknown[];
};

/**
 * Opens the page with a scripted draft and collaboration socket: the server's
 * text comes back as a snapshot, updates are answered as the test says, and
 * everything the page sends is recorded.
 */
async function openEditor(page: Page, text: string, behaviour: Behaviour = {}) {
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
  let socket: { send(message: string | Buffer): void } | null = null;
  await page.routeWebSocket(/\/v1\/collaboration/, (ws) => {
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
  await expect(editor).toContainText(text);
  return {
    editor,
    updates,
    serverSend: (frame: unknown) => socket?.send(JSON.stringify(frame)),
  };
}

test.describe("Editing a document in place", () => {
  test("Edit opens the draft with the server's text; what is typed is sent and saved", async ({ page }) => {
    const { editor, updates } = await openEditor(page, "Hello world");
    await expect(page.getByText("All changes saved")).toBeVisible();
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" there");
    await expect.poll(() => updates.length).toBeGreaterThan(0);
    expect(updates[0].kind).toBe(BinaryFrameKind.ClientUpdate);
    expect(updates[0].draftId).toBe(DRAFT);
    await expect(editor).toContainText("Hello world there");
    await expect(page.getByText("All changes saved")).toBeVisible();
    await page.getByTestId("artifact-edit-toggle").click();
    await expect(editor).toHaveCount(0);
  });

  test("who is here and what they are doing sits above the editor", async ({ page }) => {
    await openEditor(page, "Hello", {
      participants: [{
        participantKey: "22222222-2222-4222-8222-222222222222",
        principalId: "33333333-3333-4333-8333-333333333333",
        principalType: "human",
        displayName: "Ana Reyes",
        state: { activity: "active", typing: true, cursor: null },
        receivedAt: "2026-01-01T00:00:00.000Z",
      }],
    });
    await expect(page.getByRole("group", { name: "People in this document" }))
      .toContainText("Ana Reyes is typing");
  });

  test("a change the server refuses is kept: a notice, the text in a sheet, and a confirmed discard", async ({ page }) => {
    const { editor } = await openEditor(page, "Hello world", {
      onUpdate: "reject",
    });
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("!");
    await expect(page.getByText("Some of your changes could not be saved."))
      .toBeVisible();
    await page.getByRole("button", { name: "Show what I typed" }).click();
    const sheet = page.getByRole("dialog", { name: "Text that was not saved" });
    await expect(sheet).toContainText("!");
    await sheet.getByRole("button", { name: "Discard" }).click();
    const confirm = page.getByRole("dialog", { name: "Discard this text?" });
    await expect(confirm).toContainText("It was never saved.");
    await confirm.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText("Some of your changes could not be saved."))
      .toHaveCount(0);
  });

  test("losing access says so and leaves the editor read-only", async ({ page }) => {
    const { editor, serverSend } = await openEditor(page, "Hello");
    serverSend({
      type: "problem",
      requestId: null,
      problem: {
        type: "https://bakery.dev/problems/auth_forbidden",
        title: "Forbidden",
        status: 403,
        detail: "No access.",
        code: "AUTH_FORBIDDEN",
        requestId: "11111111-1111-4111-8111-111111111112",
        retryable: false,
      },
    });
    await expect(
      page.getByText("You no longer have access to edit this document."),
    )
      .toBeVisible();
    await expect(editor).toHaveAttribute("aria-readonly", "true");
  });
});
