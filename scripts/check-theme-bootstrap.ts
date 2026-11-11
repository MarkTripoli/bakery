const root = new URL("..", import.meta.url);
const output = await Deno.makeTempDir({ prefix: "bakery-theme-bootstrap-" });
const command = new Deno.Command("pnpm", {
  args: ["--dir", "apps/web", "build:theme-bootstrap"],
  cwd: root,
  env: { THEME_BOOTSTRAP_OUT_DIR: output },
  stdout: "null",
  stderr: "piped",
});
const result = await command.output();
if (!result.success) {
  throw new Error(new TextDecoder().decode(result.stderr));
}

const expected = await Deno.readFile(
  new URL("apps/web/public/theme-bootstrap.js", root),
);
const actual = await Deno.readFile(`${output}/theme-bootstrap.js`);
if (
  expected.length !== actual.length ||
  expected.some((value, index) => value !== actual[index])
) {
  throw new Error(
    "theme-bootstrap.js is out of date; run build:theme-bootstrap",
  );
}
