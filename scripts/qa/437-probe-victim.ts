/**
 * A worker that misbehaves in a named way, on purpose, so a host can prove its
 * sandbox actually stops it (QA proof for #437 slice 2).
 *
 * This module is never imported by anything and never shipped in a running
 * server: it exists so `scripts/qa/437-launcher-proof.sh` can start a unit that
 * does one known-bad thing and then check that the unit's limits — not the
 * worker's good behaviour — are what ended it. A probe that behaves is proof
 * that the probe works; only a probe that misbehaves can prove the caps exist.
 *
 * The mode is read from the first argument and nothing else, so the harness
 * starts this through the same `deno run` flags the real launcher uses.
 */
const encoder = new TextEncoder();

function say(line: string): void {
  Deno.stdout.writeSync(encoder.encode(`${line}\n`));
}

/** Grows without bound until the unit's MemoryMax kills it. */
function eatMemory(): void {
  const held: Uint8Array[] = [];
  const chunk = new Uint8Array(16 * 1024 * 1024);
  for (let index = 0; index < 4_096; index += 1) {
    // Touch every page so the allocation is resident, not just reserved.
    for (let offset = 0; offset < chunk.byteLength; offset += 4096) {
      chunk[offset] = index & 0xff;
    }
    held.push(chunk.slice());
    say(`allocated ${held.length * 16} MiB`);
  }
}

/** Runs past the unit's RuntimeMaxSec. */
function spin(seconds: number): void {
  const until = Date.now() + seconds * 1000;
  say("spinning");
  while (Date.now() < until) {
    // Deliberately busy: a sleeping child would prove the timer, not the CPU
    // quota the unit also sets.
  }
}

/** Tries to reach the network, which the unit's PrivateNetwork denies. */
async function reachNetwork(): Promise<void> {
  try {
    const connection = await Deno.connect({
      hostname: "1.1.1.1",
      port: 443,
      transport: "tcp",
    });
    connection.close();
    say("network: connected");
  } catch (error) {
    say(`network: refused ${(error as Error).name}`);
  }
  // A second form, because a namespace with no route and one with no
  // interface fail differently and only one of them is "denied".
  try {
    const response = await fetch("http://1.1.1.1/", {
      signal: AbortSignal.timeout(2_000),
    });
    say(`network: http ${response.status}`);
  } catch (error) {
    say(`network: http-refused ${(error as Error).name}`);
  }
}

/**
 * Reads the spooled copy and then tries to write beside it.
 *
 * Two answers in one run, because they are one property: the unit may read the
 * directory the server spools to and must not be able to change it. The write is
 * attempted after the read so a read-only mount is still tested for reading.
 */
async function readSpoolAndTryToWrite(
  dir: string,
  outside?: string,
): Promise<void> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  const file = names.find((name) => name.startsWith("probe-"));
  if (file === undefined) {
    say("spool: empty");
    return;
  }
  const bytes = await Deno.readFile(`${dir}/${file}`);
  say(`spool: read ${bytes.byteLength} bytes`);
  try {
    await Deno.writeTextFile(`${dir}/probe-written-by-sandbox`, "x");
    say("spool: wrote");
  } catch (error) {
    say(`spool: write-refused ${(error as Error).name}`);
  }
  // A second write, to a path OUTSIDE the grant. Some hosts cannot set up the
  // read-only mounts at all and systemd proceeds without them; on those the
  // spool's refusal would mean nothing, because nothing outside is refused
  // either. This line is what tells the two apart.
  if (outside !== undefined && outside !== "") {
    try {
      await Deno.writeTextFile(outside, "x");
      say("outside: wrote");
    } catch (error) {
      say(`outside: write-refused ${(error as Error).name}`);
    }
  }
}

const mode = Deno.args[0];
switch (mode) {
  case "memory":
    eatMemory();
    break;
  case "time":
    spin(Number(Deno.args[1] ?? "120"));
    break;
  case "network":
    await reachNetwork();
    break;
  case "spool":
    await readSpoolAndTryToWrite(Deno.args[1] ?? "", Deno.args[2]);
    break;
  default:
    say(`unknown mode: ${mode ?? "(none)"}`);
    Deno.exit(64);
}

say("finished without being killed");
