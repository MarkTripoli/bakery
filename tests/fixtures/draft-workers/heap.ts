// Grows the JavaScript heap without bound; the V8 old-space cap must end it.
const ready = new TextEncoder().encode("READY\n");
await Deno.stdout.write(ready);
await Deno.stdin.readable.pipeTo(new WritableStream());
const retained: { index: number; text: string }[][] = [];
for (let index = 0;; index += 1) {
  retained.push(
    Array.from({ length: 10_000 }, (_, item) => ({
      index: item,
      text: `${index}:${item}:${"x".repeat(32)}`,
    })),
  );
}
