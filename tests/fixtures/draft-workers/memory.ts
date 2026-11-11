const ready = new TextEncoder().encode("READY\n");
await Deno.stdout.write(ready);
await Deno.stdin.readable.pipeTo(new WritableStream());
const pages: Uint8Array[] = [];
while (true) {
  const page = new Uint8Array(16 * 1024 * 1024);
  for (let offset = 0; offset < page.length; offset += 4096) page[offset] = 1;
  pages.push(page);
}
