// Run inside the server container with the server's own permission flags.
// Prints one JSON line: what each attempt to repurpose the run grant got.
const launcher = "/workspace/infra/draft-worker/launch.sh";
async function attempt(command: string, args: string[]): Promise<string> {
  try {
    const output = await new Deno.Command(command, {
      args,
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).output();
    return `exit:${output.code}`;
  } catch (error) {
    return error instanceof Deno.errors.NotCapable
      ? "denied"
      : `error:${(error as Error).name}`;
  }
}
console.log(JSON.stringify({
  denoEval: await attempt("/usr/bin/deno", ["eval", "Deno.exit(7)"]),
  shell: await attempt("/bin/sh", ["-c", "exit 7"]),
  launcherEval: await attempt(launcher, ["eval", "Deno.exit(7)"]),
  launcherExtra: await attempt(launcher, [crypto.randomUUID(), "eval"]),
}));
