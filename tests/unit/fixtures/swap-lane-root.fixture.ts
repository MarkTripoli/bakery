// Run only by the temp hygiene rail (it is not a *_test.ts file, so no lane
// collects it): replaces the lane's own temp root with a symlink to a directory
// beside it, as a hostile or broken test could. The rail then expects the
// runner's sweep to report the swap, never follow the link, and fail a strict run.
import { dirname } from "node:path";

Deno.test("swaps the lane root for a symlink to a directory beside it", () => {
  const root = Deno.env.get("TMPDIR")!;
  const target = `${dirname(root)}/swap-target`;
  Deno.mkdirSync(target);
  Deno.writeTextFileSync(`${target}/keep`, "keep");
  Deno.removeSync(root, { recursive: true });
  Deno.symlinkSync(target, root);
});
