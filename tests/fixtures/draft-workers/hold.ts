// Signals READY and then waits to be killed, so the parent can inspect the
// live worker process.
await Deno.stdout.write(new TextEncoder().encode("READY\n"));
await new Promise(() => {
  setInterval(() => {}, 1_000);
});
