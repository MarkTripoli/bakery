// End to end against the containerized server process over real TCP: two
// members join a draft room with server-derived identities and see each
// other's presence, a forced restart drops every participant while the
// committed draft survives and access is checked again on reconnect, and a
// logout ends the socket and removes the member from the room.
//
// The shipped server runs without draft isolation (no `systemd-run`, no
// `--allow-run`), so `drafts.open` and binary updates answer 503 there; the
// draft is seeded with the same rows `drafts.open` writes, and the update
// path is proven in-process by the integration lane.
import { assert, assertEquals, assertExists } from "@std/assert";
import { LoroDoc } from "loro-crdt";
import { decodeBinaryFrame } from "../../apps/server/src/modules/knowledge/collaboration-socket.ts";
import {
  collect,
  connectCollaboration,
  type Frame,
  seedCollaborationWorld,
  seedDraft,
  untilFrame,
} from "../helpers/collaboration-world.ts";
import type { WsClient } from "../helpers/ws-client.ts";
import { type Stack, upStack } from "./helpers/stack.ts";

const TEXT = "alpha target omega";

async function open(
  stack: Stack,
  organizationId: string,
  cookie: string,
): Promise<WsClient> {
  const client = await connectCollaboration(
    stack.origin,
    organizationId,
    cookie,
  );
  assert("send" in client, JSON.stringify(client));
  await untilFrame(client, "hello");
  return client;
}

/** Joins and syncs; returns the participants and the synced document text. */
async function joinAndSync(client: WsClient, draftId: string) {
  const room = { kind: "draft", id: draftId };
  await client.send(
    JSON.stringify({ type: "join", requestId: crypto.randomUUID(), room }),
  );
  const joined = await untilFrame(client, "joined");
  await client.send(
    JSON.stringify({ type: "sync", requestId: crypto.randomUUID(), room }),
  );
  await untilFrame(client, "synced");
  let snapshot: Uint8Array | undefined;
  while (!snapshot) {
    const value = await client.nextMessage(5_000);
    if (typeof value === "object" && "binary" in value) {
      snapshot = value.binary;
    }
  }
  const doc = new LoroDoc();
  doc.import(decodeBinaryFrame(snapshot).payload);
  return {
    participants: (joined.participants as { principalId: string }[])
      .map((p) => p.principalId).sort(),
    text: doc.getText("body").toString(),
  };
}

Deno.test(
  "collaboration rooms work through the real process, survive a restart and end on logout",
  { sanitizeResources: false, sanitizeOps: false },
  async (t) => {
    const stack = await upStack("collab-rooms");
    const query = (sql: string, params: unknown[]) => stack.psql(sql, params);
    const world = await seedCollaborationWorld(query, stack.authSecret, {
      label: "collab-e2e",
      text: TEXT,
    });
    const first = world.members[0]!;
    const second = world.members[1]!;
    const draftId = await seedDraft(query, world, TEXT);
    const clients: WsClient[] = [];
    try {
      await t.step(
        "two members join with server identities, sync and see each other",
        async () => {
          const a = await open(stack, world.organizationId, first.cookie);
          clients.push(a);
          const aState = await joinAndSync(a, draftId);
          assertEquals(aState.participants, [first.principalId]);
          assertEquals(aState.text, TEXT);
          const b = await open(stack, world.organizationId, second.cookie);
          clients.push(b);
          const bState = await joinAndSync(b, draftId);
          assertEquals(
            bState.participants,
            [first.principalId, second.principalId].sort(),
          );
          const seen = await untilFrame(a, "presence");
          const presence = seen.presence as {
            principalId: string;
            displayName: string;
          };
          assertEquals(presence.principalId, second.principalId);
          assertEquals(presence.displayName, second.displayName);
        },
      );

      await t.step(
        "a restart drops every participant; the draft survives and access is checked again",
        async () => {
          await stack.restartServer({});
          // The old sockets belong to the stopped process: none answers a
          // ping. (Their close frame can be lost to a TCP reset, so the test
          // asserts silence or a close, not the close code.)
          for (const client of clients.splice(0)) {
            await client.send(
              JSON.stringify({ type: "ping", requestId: crypto.randomUUID() }),
            ).catch(() => {});
            const after = await collect(client, 3_000);
            assertEquals(
              after.frames.filter((frame) => frame.type === "ping"),
              [],
              "a socket from before the restart still answered",
            );
            await client.close().catch(() => {});
          }
          // Presence is not durable: the first member to come back is alone.
          const a = await open(stack, world.organizationId, first.cookie);
          clients.push(a);
          const state = await joinAndSync(a, draftId);
          assertEquals(state.participants, [first.principalId]);
          assertEquals(state.text, TEXT);
          // Reconnect re-authorizes: a member removed while the server was
          // down cannot come back in.
          await stack.psql(
            "delete from bakery.organization_memberships where principal_id=$1",
            [second.principalId],
          );
          const refused = await connectCollaboration(
            stack.origin,
            world.organizationId,
            second.cookie,
          );
          assert(!("send" in refused));
          assert([403, 404].includes(refused.status), String(refused.status));
          await stack.psql(
            `insert into bakery.organization_memberships (id,organization_id,principal_id,role,status,joined_at,created_at,updated_at,version)
           values ($1,$2,$3,'developer','active',now(),now(),now(),1)`,
            [crypto.randomUUID(), world.organizationId, second.principalId],
          );
        },
      );

      await t.step(
        "logout ends the socket and removes the member for the others",
        async () => {
          const a = clients[0]!;
          const b = await open(stack, world.organizationId, second.cookie);
          clients.push(b);
          await joinAndSync(b, draftId);
          await untilFrame(a, "presence");
          await stack.psql("delete from public.session where token=$1", [
            second.sessionToken,
          ]);
          // The sweep runs every 5 s; allow two periods.
          const ended = await collect(b, 12_000);
          assertExists(ended.closed, JSON.stringify(ended.frames));
          assertEquals(ended.closed.code, 1008);
          let removed: Frame | undefined;
          const deadline = Date.now() + 12_000;
          while (!removed && Date.now() < deadline) {
            const frame = await untilFrame(a, "presence.removed", 12_000);
            if (frame.reason === "revoked") removed = frame;
          }
          assertExists(removed);
          const again = await connectCollaboration(
            stack.origin,
            world.organizationId,
            second.cookie,
          );
          assert(!("send" in again));
          assertEquals(again.status, 401);
        },
      );
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      await world.cleanup().catch(() => {});
      await stack.down();
    }
  },
);
