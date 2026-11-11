await Deno.stdout.write(new TextEncoder().encode("READY\n"));
await Deno.stdin.readable.pipeTo(new WritableStream());
throw new Error("deliberate worker trap");
