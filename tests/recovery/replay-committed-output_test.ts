import { assert, assertEquals } from "@std/assert";
import {
  ApiProblemError,
  createBakeryClient,
} from "../../packages/contracts/src/client.ts";
import { batch, event, setup } from "../helpers/output-ingestion.ts";
import type { WorkerFixture } from "../helpers/worker-execution.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";

function reader(fixture: WorkerFixture) {
  return createBakeryClient({
    baseUrl: fixture.config.publicBaseUrl,
    getContext: () => ({ organizationId: fixture.organizationId }),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", fixture.adminCookie);
      return fixture.app.fetch(new Request(input, { ...init, headers }));
    },
  });
}

function assertEncodedPage(value: { encodedBytes: number }): void {
  assertEquals(
    value.encodedBytes,
    new TextEncoder().encode(JSON.stringify(value)).byteLength,
  );
}

Deno.test("exclusive output cursor recovers retained boundaries and interior gaps without skipping", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const client = reader(fixture);
    const empty = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
    });
    assertEquals(empty.disposition, "page");
    assertEquals(empty.batches, []);
    assertEquals(empty.retainedFrom, null);
    assert(typeof empty.cursor === "string");
    assertEncodedPage(empty);

    const batches = [];
    for (let sequence = 1; sequence <= 4; sequence++) {
      batches.push(
        await batch(
          { ...own.binding, nextSequence: String(sequence) },
          `batch-${sequence}`,
          String(sequence),
        ),
      );
    }
    await own.client.postEvents(own.assignment.attemptId, {
      ...own.open,
      events: batches.map((payload, index) =>
        event(payload, String(index + 1))
      ),
    });

    const first = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      limit: 2,
    });
    assertEquals(first.batches.map(({ sequence }) => sequence), ["1", "2"]);
    assertEncodedPage(first);
    const second = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      cursor: first.cursor,
      limit: 2,
    });
    assertEquals(second.batches.map(({ sequence }) => sequence), ["3", "4"]);
    assertEncodedPage(second);
    const highwater = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      cursor: second.cursor,
    });
    assertEquals(highwater.batches, []);
    assertEquals(highwater.highwater, "4");

    await fixture.pgDatabase.query(
      `delete from bakery.session_output_batches where organization_id=$1 and session_id=$2 and sequence=1`,
      [fixture.organizationId, own.binding.sessionId],
    );
    const freshRetained = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
    });
    assertEquals(freshRetained.disposition, "page");
    assertEquals(
      freshRetained.batches.map(({ sequence }) => sequence),
      ["2", "3", "4"],
    );
    const expired = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      cursor: empty.cursor,
    });
    assertEquals(expired.disposition, "reset_required");
    assertEquals(expired.retainedFrom, "2");
    assertEquals(expired.resumeAfter, "1");
    assertEncodedPage(expired);
    const boundary = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      cursor: expired.cursor,
      limit: 1,
    });
    assertEquals(boundary.disposition, "page");
    assertEquals(boundary.batches.map(({ sequence }) => sequence), ["2"]);

    await fixture.pgDatabase.query(
      `delete from bakery.session_output_batches where organization_id=$1 and session_id=$2 and sequence=3`,
      [fixture.organizationId, own.binding.sessionId],
    );
    const prefix = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      cursor: expired.cursor,
    });
    assertEquals(prefix.disposition, "page");
    assertEquals(prefix.batches.map(({ sequence }) => sequence), ["2"]);
    const gap = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      cursor: prefix.cursor,
    });
    assertEquals(gap.disposition, "reset_required");
    assertEquals(gap.retainedFrom, "2");
    assertEquals(gap.resumeAfter, "3");
    const afterGap = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      cursor: gap.cursor,
    });
    assertEquals(afterGap.batches.map(({ sequence }) => sequence), ["4"]);

    let pageTooSmall = "";
    try {
      await client.actions["output.streams.read"]({
        streamId: own.binding.sessionId,
        maxBytes: 1,
      });
    } catch (error) {
      assert(error instanceof ApiProblemError);
      pageTooSmall = error.problem.code;
    }
    assertEquals(pageTooSmall, "BODY_TOO_LARGE");
  }));

Deno.test("default and maximum batch counts remain bounded and complete", () =>
  withWorkerFixture(async (fixture) => {
    const own = await setup(fixture);
    const payloads = await Promise.all(
      Array.from({ length: 65 }, (_, index) => {
        const sequence = String(index + 1);
        return batch(
          { ...own.binding, nextSequence: sequence },
          `bounded-${sequence}`,
          sequence,
        );
      }),
    );
    await own.client.postEvents(own.assignment.attemptId, {
      ...own.open,
      events: payloads.map((payload, index) =>
        event(payload, String(index + 1))
      ),
    });
    const client = reader(fixture);
    const defaultPage = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
    });
    assertEquals(defaultPage.batches.length, 32);
    assertEncodedPage(defaultPage);
    const maximumPage = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      limit: 64,
    });
    assertEquals(maximumPage.batches.length, 64);
    assertEncodedPage(maximumPage);
    const finalPage = await client.actions["output.streams.read"]({
      streamId: own.binding.sessionId,
      cursor: maximumPage.cursor,
      limit: 64,
    });
    assertEquals(finalPage.batches.map(({ sequence }) => sequence), ["65"]);
    assertEncodedPage(finalPage);
  }));

Deno.test("discovery continuation traverses every authorized stream in stable finite pages", () =>
  withWorkerFixture(async (fixture) => {
    const first = await setup(fixture);
    const second = await setup(fixture);
    // Each seeded job pins its own agent version, so each stream has its own
    // logical actor; the unfiltered listing must still reach both streams.
    assert(second.binding.logicalActor !== first.binding.logicalActor);
    const client = reader(fixture);
    const seen: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const page = await client.actions["output.streams.list"]({
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map(({ streamId }) => streamId));
      cursor = page.nextCursor ?? undefined;
      if (cursor !== undefined) assert(cursor.length <= 512);
      assert(page.encodedBytes <= 131072);
      assertEncodedPage(page);
      if (cursor === undefined) break;
      assert(!cursors.has(cursor), "discovery cursor must advance");
      cursors.add(cursor);
    }
    assertEquals(cursor, undefined);
    assertEquals(
      new Set(seen),
      new Set([
        first.binding.sessionId,
        second.binding.sessionId,
      ]),
    );
    // A logicalActor filter narrows the listing to that actor's own stream.
    for (const own of [first, second]) {
      const filtered = await client.actions["output.streams.list"]({
        limit: 10,
        logicalActor: own.binding.logicalActor,
      });
      assertEquals(
        filtered.items.map(({ streamId }) => streamId),
        [own.binding.sessionId],
      );
      assertEquals(filtered.nextCursor, null);
    }
  }));
