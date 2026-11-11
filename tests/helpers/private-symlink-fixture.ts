import { relative, resolve } from "node:path";

/** Deno 2.9 cannot create symlinks with path-scoped write grants. */
export async function createPrivateFixtureSymlink(
  target: string,
  link: string,
): Promise<void> {
  const temporary = resolve(
    Deno.env.get("TMPDIR") ?? Deno.env.get("TMP") ?? Deno.env.get("TEMP") ??
      "/tmp",
  );
  for (const path of [target, link]) {
    const within = relative(temporary, resolve(path));
    if (
      !within || within === ".." || within.startsWith("../") ||
      within.startsWith("/")
    ) {
      throw new Error("FIXTURE_SYMLINK_OUTSIDE_TEMPORARY_DIRECTORY");
    }
  }
  const result = await new Deno.Command("node", {
    args: [
      "-e",
      "require('node:fs').symlinkSync(process.argv[1], process.argv[2])",
      target,
      link,
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!result.success) throw new Error("FIXTURE_SYMLINK_CREATE_FAILED");
}
