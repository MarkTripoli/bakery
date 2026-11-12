// Grows WebAssembly memory (what Loro allocates in) past the page cap; the
// V8 limit must refuse the growth and the worker must end.
const ready = new TextEncoder().encode("READY\n");
await Deno.stdout.write(ready);
await Deno.stdin.readable.pipeTo(new WritableStream());
const memory = new WebAssembly.Memory({ initial: 1, maximum: 65_536 });
for (;;) {
  memory.grow(256);
  new Uint8Array(memory.buffer).fill(1, memory.buffer.byteLength - 4096);
}
