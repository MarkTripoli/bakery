import {
  createSkillSourceAdapterForTest,
  SkillSourceAdapterError,
} from "../../apps/server/src/modules/catalog/source-adapters.ts";

const adapter = createSkillSourceAdapterForTest({
  allowInsecureLoopback: true,
  timeoutMs: 1_000,
});
try {
  await adapter.fetchPinnedSource({
    sourceType: "git",
    locator: Deno.args[0]!,
    requestedRevision: "main",
  });
  console.log("fetched");
} catch (error) {
  console.log(error instanceof SkillSourceAdapterError ? error.code : "other");
}
