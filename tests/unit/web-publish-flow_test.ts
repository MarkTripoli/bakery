import { assertEquals } from "@std/assert";
import type { ApiResult } from "../../apps/web/src/api/client.ts";
import {
  lookForPublication,
  publishCheckpoint,
  type PublishDeps,
} from "../../apps/web/src/collaboration/publish-flow.ts";

const publication = { versionNumber: 3, artifactVersionId: "v" } as never;
const draft = (checkpointId: string) =>
  ({
    ok: true,
    data: { checkpointId, textDigest: checkpointId.repeat(64).slice(0, 64) },
  }) as never;
const problem = (status: number): ApiResult<never> => ({
  ok: false,
  error: { kind: "problem", problem: { status } as never },
});
const network: ApiResult<never> = { ok: false, error: { kind: "network" } };

function world(
  publishAnswers: ApiResult<never>[],
  reads: ApiResult<never>[] = [],
) {
  const calls = { publish: [] as string[], read: 0, lookup: [] as string[] };
  const deps: PublishDeps = {
    readDraft: () => {
      calls.read += 1;
      return Promise.resolve(reads.shift() ?? draft("f"));
    },
    publish: (input) => {
      calls.publish.push(input.checkpointId);
      return Promise.resolve(publishAnswers.shift() ?? network);
    },
    lookup: (checkpointId) => {
      calls.lookup.push(checkpointId);
      return Promise.resolve(network);
    },
  };
  return { deps, calls };
}
const first = { checkpointId: "a", textDigest: "d".repeat(64) };

Deno.test("the previewed checkpoint is published and the version returned", async () => {
  const { deps, calls } = world([{ ok: true, data: publication }]);
  assertEquals(await publishCheckpoint(deps, first), {
    kind: "published",
    publication,
  });
  assertEquals(calls.publish, ["a"]);
  assertEquals(calls.read, 0);
});

Deno.test("only the checkpoint and its digest are sent, whatever the caller holds", async () => {
  const { deps } = world([{ ok: true, data: publication }]);
  const sent: unknown[] = [];
  const spy: PublishDeps = {
    ...deps,
    publish: (input) => {
      sent.push(input);
      return deps.publish(input);
    },
  };
  await publishCheckpoint(spy, { ...first, waiting: 2 } as typeof first);
  assertEquals(sent, [first]);
});

Deno.test("a moved checkpoint with the same text is published once more, silently", async () => {
  const same = {
    ok: true,
    data: { checkpointId: "b", textDigest: first.textDigest },
  } as never;
  const { deps, calls } = world(
    [problem(412), { ok: true, data: publication }],
    [same],
  );
  assertEquals((await publishCheckpoint(deps, first)).kind, "published");
  assertEquals(calls.publish, ["a", "b"]);
  assertEquals(calls.read, 1);
});

Deno.test("a text that changed is not published: the person is told and the next press takes it", async () => {
  const { deps, calls } = world(
    [problem(412), { ok: true, data: publication }],
    [draft("b")],
  );
  assertEquals(await publishCheckpoint(deps, first), { kind: "moved" });
  assertEquals(calls.publish, ["a"]);
  assertEquals(calls.read, 1);
});

Deno.test("a checkpoint that keeps moving under the same text stops after one more try", async () => {
  const same = (id: string) =>
    ({
      ok: true,
      data: { checkpointId: id, textDigest: first.textDigest },
    }) as never;
  const { deps, calls } = world(
    [problem(412), problem(412), { ok: true, data: publication }],
    [same("b"), same("c")],
  );
  assertEquals(await publishCheckpoint(deps, first), { kind: "moved" });
  assertEquals(calls.publish, ["a", "b"]);
  assertEquals(calls.read, 1);
});

Deno.test("a failed re-read after a refusal means nothing was published", async () => {
  const { deps, calls } = world([problem(412)], [network]);
  assertEquals(await publishCheckpoint(deps, first), { kind: "moved" });
  assertEquals(calls.publish, ["a"]);
});

Deno.test("a lost answer is never published a second time: it is unknown, with its checkpoint", async () => {
  for (const lost of [network, problem(500), problem(503)]) {
    const { deps, calls } = world([lost, { ok: true, data: publication }]);
    assertEquals(await publishCheckpoint(deps, first), {
      kind: "unknown",
      checkpointId: "a",
    });
    assertEquals(calls.publish, ["a"]);
  }
});

Deno.test("no right to publish, or a gone draft, is forbidden; another refusal is refused", async () => {
  assertEquals(
    (await publishCheckpoint(world([problem(403)]).deps, first)).kind,
    "forbidden",
  );
  assertEquals(
    (await publishCheckpoint(world([problem(404)]).deps, first)).kind,
    "forbidden",
  );
  assertEquals(await publishCheckpoint(world([problem(422)]).deps, first), {
    kind: "refused",
    checkpointId: "a",
  });
});

Deno.test("looking for a lost publication never publishes: found, absent or unknown", async () => {
  const found: PublishDeps = {
    ...world([]).deps,
    lookup: () => Promise.resolve({ ok: true, data: publication }),
  };
  assertEquals(await lookForPublication(found, "a"), {
    kind: "found",
    publication,
  });
  const absent: PublishDeps = {
    ...world([]).deps,
    lookup: () => Promise.resolve(problem(404)),
  };
  assertEquals(await lookForPublication(absent, "a"), { kind: "absent" });
  const unknown = world([]);
  assertEquals(await lookForPublication(unknown.deps, "a"), {
    kind: "unknown",
  });
  assertEquals(unknown.calls.publish, []);
});
