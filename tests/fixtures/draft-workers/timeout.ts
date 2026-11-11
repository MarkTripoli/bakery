const ready = new TextEncoder().encode("READY\n");
await Deno.stdout.write(ready);
await Deno.stdin.readable.pipeTo(new WritableStream());
while (true) {
  // Deliberately consume CPU until RuntimeMaxSec terminates this cgroup.
}
