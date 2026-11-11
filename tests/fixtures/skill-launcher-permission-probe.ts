import { assert, assertEquals, assertRejects } from "@std/assert";
import { createSkillSourceAdapter } from "../../apps/server/src/modules/catalog/source-adapters.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";

const [unrelatedReadPath, unrelatedWritePath] = Deno.args;
const root = Deno.env.get("BAKERY_SKILL_FILE_ROOT");
assert(root);
assertEquals(Deno.env.get("BAKERY_LAUNCHER_UNRELATED_SECRET"), undefined);

const content = new TextEncoder().encode("scoped launcher proof\n");
const digest = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", content)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");
const objectKey =
  `organizations/launcher/skill-versions/probe/sha256/${digest}`;
const store = new SkillFileStore(root);
await store.putIfAbsent(objectKey, content, digest);
assertEquals(await store.read(objectKey, digest, content.byteLength), content);

const adapter = createSkillSourceAdapter(root);
await assertRejects(() =>
  adapter.fetchPinnedSource({
    sourceType: "git",
    locator: "https://0.0.0.0/repository.git",
    requestedRevision: "main",
  })
);
const scratch = await Deno.lstat(`${root}/.bakery-source-scratch`);
assert(scratch.isDirectory);
assertEquals(scratch.uid, Deno.uid());
assertEquals(scratch.mode! & 0o777, 0o700);

await assertRejects(
  () => Deno.readTextFile(unrelatedReadPath),
  Deno.errors.NotCapable,
);
await assertRejects(
  () => Deno.writeTextFile(unrelatedWritePath, "denied"),
  Deno.errors.NotCapable,
);
