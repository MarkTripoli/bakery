await Deno.stdout.write(new TextEncoder().encode("READY\n"));
await Deno.stdin.readable.pipeTo(new WritableStream());
await Deno.stdout.write(new Uint8Array(18 * 1024 * 1024));
