/**
 * Runs the probe launcher with the parent it demands (#437 slice 2 QA proof).
 *
 * `infra/server-exec/artifact-probe.sh` refuses to run unless its parent is a
 * `deno` process, because the only caller it will accept is the Bakery server.
 * That refusal is correct and it means QA cannot invoke the launcher from a
 * shell: a shell would get exit 70 and learn nothing about the sandbox. This
 * module is the parent that satisfies the check, so the proof exercises the real
 * launcher — the one the server ships — rather than a copy of its flags.
 *
 * It reads a frame from the file named as the second argument, writes the
 * launcher's stdout and stderr to the paths given, and exits with the
 * launcher's own exit code so the caller can record it.
 *
 *   deno run -A scripts/qa/437-launcher-under-deno.ts <uuid> <frame.json> <out-prefix> [--spool-dir=<abs>]
 *
 * The optional spool directory is forwarded to the launcher unchanged, so the
 * proof exercises the launcher's own argv guard and its own `ReadOnlyPaths=`
 * grant rather than a copy of them.
 */
const [id, framePath, outPrefix, ...rest] = Deno.args;
if (!id || !framePath || !outPrefix) {
  console.error("usage: <uuid> <frame.json> <out-prefix> [--spool-dir=<abs>]");
  Deno.exit(64);
}
const spoolArgs = rest.filter((arg) => arg.startsWith("--spool-dir="));
if (spoolArgs.length !== rest.length) {
  console.error(
    `unexpected argument: ${rest.find((a) => !a.startsWith("--spool-dir="))}`,
  );
  Deno.exit(64);
}

const here = new URL(".", import.meta.url).pathname;
const launcher = `${here}../../infra/server-exec/artifact-probe.sh`;
const frame = await Deno.readFile(framePath);

const child = new Deno.Command(launcher, {
  args: [id, ...spoolArgs],
  stdin: "piped",
  stdout: "piped",
  stderr: "piped",
}).spawn();

// The pipes are read as streams, not with `child.output`: the child's stdin
// writer is already held here, and asking for `output()` on a command whose
// streams are piped hands back nothing to write.
const [, stdout, stderr, status] = await Promise.all([
  (async () => {
    const writer = child.stdin.getWriter();
    await writer.write(frame);
    await writer.close();
  })(),
  new Response(child.stdout).arrayBuffer(),
  new Response(child.stderr).arrayBuffer(),
  child.status,
]);

await Deno.writeFile(`${outPrefix}-stdout.txt`, new Uint8Array(stdout));
await Deno.writeFile(`${outPrefix}-stderr.txt`, new Uint8Array(stderr));
console.error(`launcher exit: ${status.code}`);
Deno.exit(status.code);
