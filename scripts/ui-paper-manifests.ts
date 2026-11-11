import type { PaperBaselineManifest } from "./verify-ui-stories.ts";

const additionalPaperBaselinePaths = [
  "docs/technical-design/ui-baselines/artifacts-baselines.json",
] as const;

export async function loadAdditionalPaperBaselines(): Promise<
  readonly PaperBaselineManifest[]
> {
  const root = new URL("../", import.meta.url);
  return await Promise.all(additionalPaperBaselinePaths.map(async (path) => {
    const manifest: PaperBaselineManifest = JSON.parse(
      await Deno.readTextFile(new URL(path, root)),
    );
    return manifest;
  }));
}
