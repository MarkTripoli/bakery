// Reports, through its exit code, whether a draft worker can reach anything
// beyond stdin/stdout: 43 when every probe is refused by the permission
// system, 42 otherwise. Only a permission refusal counts as denied: any other
// failure (a refused connection, a missing host) means the capability was
// there, so it reports 42 and fails closed.
const ready = new TextEncoder().encode("READY\n");
await Deno.stdout.write(ready);
await Deno.stdin.readable.pipeTo(new WritableStream());

function refused(error: unknown): boolean {
  return error instanceof Deno.errors.NotCapable ||
    // A denied module import surfaces as a TypeError carrying this text.
    (error instanceof Error &&
      error.message.includes("Requires import access"));
}

const importProbe = ["https://deno.land", "x", "bakery_import_probe", "mod.ts"]
  .join("/");
const probes: [string, () => unknown][] = [
  ["env", () => Deno.env.get("PATH")],
  ["read", () => Deno.readTextFileSync("/etc/hostname")],
  ["write", () => Deno.writeTextFileSync("/tmp/bakery-draft-probe", "x")],
  ["run", () => new Deno.Command("/bin/true").outputSync()],
  ["sys", () => Deno.hostname()],
  // A real listener on loopback: succeeds whenever net is granted.
  ["net-listen", () => Deno.listen({ hostname: "127.0.0.1", port: 0 }).close()],
  ["net-connect", () => Deno.connect({ hostname: "127.0.0.1", port: 9 })],
  ["ffi", () => Deno.dlopen("libc.so.6", {})],
  // deno.land is on Deno's default import allow-list, so only an explicit
  // denial refuses it. The specifier is not a literal, so type checking and
  // the lockfile never follow it; uncached, an allowed import still fails
  // with "not found in cache", which is not a refusal and counts as reached.
  ["import", () => import(importProbe)],
];
const reached: string[] = [];
for (const [name, probe] of probes) {
  try {
    await probe();
    reached.push(name);
  } catch (error) {
    if (!refused(error)) reached.push(name);
  }
}
// The names are the diagnostic: the parent keeps a bounded stderr.
if (reached.length > 0) {
  await Deno.stderr.write(new TextEncoder().encode(reached.join(",")));
}
Deno.exit(reached.length === 0 ? 43 : 42);
