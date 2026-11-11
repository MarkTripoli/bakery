import { SkillCache } from "../../apps/worker/src/skill-cache.ts";
import { SkillMaterializer } from "../../apps/worker/src/skill-materializer.ts";
import type { SkillCacheIdentity } from "../../apps/worker/src/types.ts";
import { createFakeSkillFixture } from "./worker-skill-materialization.ts";

const [mode, stateDir, markerPath, auxiliaryPath] = Deno.args;
if (!mode || !stateDir || !markerPath) {
  throw new Error("CHILD_ARGUMENTS_REQUIRED");
}

const identity: SkillCacheIdentity = Object.freeze({
  organizationId: "10000000-0000-4000-8000-000000000001",
  versionId: "50000000-0000-8000-8000-000000000005",
  digest: "a".repeat(64),
});
const never = () =>
  new Promise<never>(() => {
    setInterval(() => undefined, 1_000);
  });

if (mode === "hold-lock") {
  const cache = new SkillCache(stateDir);
  await cache.withKeyLockForTest(
    identity,
    new AbortController().signal,
    async () => {
      await Deno.writeTextFile(markerPath, "locked\n", { createNew: true });
      await never();
    },
  );
} else if (mode === "materialize") {
  if (!auxiliaryPath) throw new Error("START_GATE_REQUIRED");
  while (true) {
    try {
      await Deno.lstat(auxiliaryPath);
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const logPath = `${auxiliaryPath}.log`;
  const fixture = await createFakeSkillFixture({
    beforeManifest: () =>
      Deno.writeTextFile(logPath, "manifest\n", { append: true, create: true }),
    beforeFile: (_call, request) =>
      Deno.writeTextFile(logPath, `file:${request.file.path}\n`, {
        append: true,
        create: true,
      }),
  });
  const materializer = new SkillMaterializer(
    new SkillCache(stateDir),
    fixture.client,
  );
  const prepared = await materializer.prepare(
    fixture.request,
    new AbortController().signal,
  );
  await prepared.release();
  await Deno.writeTextFile(markerPath, "done\n", { createNew: true });
} else if (mode === "crash-after-stage" || mode === "crash-after-link") {
  const fixture = await createFakeSkillFixture();
  const cache = new SkillCache(stateDir, {
    hooks: mode === "crash-after-stage"
      ? {
        afterStageCreated: async () => {
          await Deno.writeTextFile(markerPath, "stage\n", { createNew: true });
          await never();
        },
      }
      : {
        afterCommitLink: async () => {
          await Deno.writeTextFile(markerPath, "linked\n", { createNew: true });
          await never();
        },
      },
  });
  await new SkillMaterializer(cache, fixture.client).prepare(
    fixture.request,
    new AbortController().signal,
  );
} else {
  throw new Error(`UNKNOWN_CHILD_MODE:${mode}`);
}
