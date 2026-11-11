import { assertEquals } from "@std/assert";
import { dirname, join } from "node:path";
import { SkillCache } from "../../apps/worker/src/skill-cache.ts";
import { SkillMaterializer } from "../../apps/worker/src/skill-materializer.ts";
import type { SkillMaterializationRequest } from "../../apps/worker/src/types.ts";
import { createFakeSkillFixture } from "../helpers/worker-skill-materialization.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function pinCount(path: string): Promise<number> {
  let count = 0;
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) count += await pinCount(child);
    else if (entry.isFile && entry.name.endsWith(".json")) count += 1;
  }
  return count;
}

function successor(
  request: SkillMaterializationRequest,
): SkillMaterializationRequest {
  const attemptId = crypto.randomUUID();
  return {
    assignment: {
      ...request.assignment,
      attemptId,
      fence: "2",
    },
    workerSessionId: request.workerSessionId,
    workerSessionGeneration: request.workerSessionGeneration,
  };
}

Deno.test("recovery retains active and unconfirmed termination owners and removes only confirmed stale roots", async () => {
  const stateDir = await Deno.makeTempDir({
    prefix: "bakery-279-recovery-owners-",
  });
  try {
    const fixture = await createFakeSkillFixture();
    const materializer = new SkillMaterializer(
      new SkillCache(stateDir),
      fixture.client,
    );
    const active = await materializer.prepare(
      fixture.request,
      new AbortController().signal,
    );
    const unconfirmed = await materializer.prepare(
      successor(fixture.request),
      new AbortController().signal,
    );
    const activeCopy = dirname(active.roots[0].rootPath);
    const unconfirmedCopy = dirname(unconfirmed.roots[0].rootPath);
    const pins = join(stateDir, "skill-materialization-v1", "pins");

    await materializer.recover(
      (owner) =>
        Promise.resolve(
          owner.attemptId === active.owner.attemptId ? "active" : "unknown",
        ),
      new AbortController().signal,
    );
    assertEquals(await exists(activeCopy), true);
    assertEquals(await exists(unconfirmedCopy), true);
    assertEquals(await pinCount(pins), 2);

    await materializer.recover(
      (owner) =>
        Promise.resolve(
          owner.attemptId === active.owner.attemptId ? "active" : "stale",
        ),
      new AbortController().signal,
    );
    assertEquals(await exists(activeCopy), true);
    assertEquals(await exists(unconfirmedCopy), false);
    assertEquals(await pinCount(pins), 1);

    await active.release();
    assertEquals(await exists(activeCopy), false);
    assertEquals(await pinCount(pins), 0);
  } finally {
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
  }
});
