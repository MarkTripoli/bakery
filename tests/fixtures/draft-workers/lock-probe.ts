// Attempts a JSR import, which (denied or not) makes Deno resolve the
// package manifest and, unless the lockfile is frozen, record a redirect in
// the project's deno.lock. Exits 0 either way: the parent checks the lockfile.
await Deno.stdout.write(new TextEncoder().encode("READY\n"));
await Deno.stdin.readable.pipeTo(new WritableStream());
const specifier = ["https://jsr.io", "@std/assert/1.0.14/assert.ts"].join("/");
try {
  await import(specifier);
} catch {
  // Expected: imports are denied.
}
Deno.exit(0);
