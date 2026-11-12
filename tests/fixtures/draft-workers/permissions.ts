// Reports, through its exit code, whether a draft worker can reach anything
// beyond stdin/stdout: 43 when every probe is denied, 42 when any succeeds.
const ready = new TextEncoder().encode("READY\n");
await Deno.stdout.write(ready);
await Deno.stdin.readable.pipeTo(new WritableStream());
const probes: (() => unknown)[] = [
  () => Deno.env.get("PATH"),
  () => Deno.readTextFileSync("/etc/hostname"),
  () => Deno.writeTextFileSync("/tmp/bakery-draft-probe", "x"),
  () => new Deno.Command("/bin/true").outputSync(),
  () => Deno.hostname(),
];
let allowed = false;
for (const probe of probes) {
  try {
    probe();
    allowed = true;
  } catch {
    // Denied, as it must be.
  }
}
try {
  await fetch("http://127.0.0.1:9/");
  allowed = true;
} catch {
  // Denied or unreachable; a permission error is the expected path.
}
Deno.exit(allowed ? 42 : 43);
