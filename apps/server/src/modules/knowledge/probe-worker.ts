/**
 * The artifact probe, as a subprocess (chapter 25 §17.6).
 *
 * This module is never imported by the server. It is started by
 * `infra/server-exec/artifact-probe.sh` in a systemd transient unit with a
 * memory cap, a CPU quota, a wall-clock limit and no network, reads the bytes
 * named on stdin, and writes one `ArtifactProbeFrame` to stdout. Nothing it
 * does can reach the database, the object store or the network, and a file that
 * makes it hang or eat memory is killed by the unit rather than by the server.
 *
 * The inputs are deliberately three strings and nothing else: an absolute file
 * path that the parent already resolved from a blob the organization owns, and
 * the size the server expects. A path is used rather than piped bytes because
 * the largest files this will see are tens of megabytes and the frame back is
 * small.
 *
 * Every failure is encoded, never thrown: the parent's job is to tell "the file
 * is bad" from "the sandbox died", and an exit code carries the second case.
 */
import {
  ARTIFACT_PROBE_MAX_BYTES,
  ARTIFACT_PROBE_SELF_TEST_CANARY,
  ARTIFACT_PROBE_SELF_TEST_HOST,
  ARTIFACT_PROBE_SELF_TEST_PORT,
  type ArtifactProbeFrame,
  type ArtifactProbeReport,
  type ArtifactProbeResult,
  type ArtifactProbeSelfTestFrame,
} from "@bakery/contracts/artifact-probe";
import { classifyArtifactMedia } from "../knowledge/media.ts";
import { describeImage } from "./probe-image.ts";
import { describeMedia } from "./probe-media.ts";
import { describeText } from "./probe-text.ts";

const encoder = new TextEncoder();

function write(frame: ArtifactProbeFrame): void {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(frame)));
}

function refuse(
  code: Extract<ArtifactProbeResult, { status: "refused" }>["code"],
  limit?: number,
): void {
  write({
    result: limit === undefined
      ? { status: "refused", code }
      : { status: "refused", code, limit },
  });
}

/**
 * Answers whether the sandbox this worker is running in is sealed.
 *
 * The worker is the right process to ask, because it runs *inside* the unit: a
 * check made by the server would test the server's network. A connect that
 * succeeds is the only answer that means "not sealed"; an address that is
 * simply down also produces a failed connect, so this can only ever make the
 * server more careful.
 */
async function selfTest(question: "network" | "filesystem"): Promise<void> {
  if (question === "filesystem") {
    // The canary lives in the unit's working directory, which the launcher pins
    // to the repository and `ProtectSystem=strict` makes read-only -- where the
    // host applies it. Creating the file is the finding; deleting it means a
    // sealed sandbox leaves nothing behind either way.
    try {
      await Deno.writeTextFile(ARTIFACT_PROBE_SELF_TEST_CANARY, "canary");
      await Deno.remove(ARTIFACT_PROBE_SELF_TEST_CANARY).catch(() => {});
      Deno.stdout.writeSync(encoder.encode(JSON.stringify(
        {
          selfTest: "filesystem",
          writable: true,
          detail: "created",
        } satisfies ArtifactProbeSelfTestFrame,
      )));
    } catch (error) {
      Deno.stdout.writeSync(encoder.encode(JSON.stringify(
        {
          selfTest: "filesystem",
          writable: false,
          detail: (error as Error).name,
        } satisfies ArtifactProbeSelfTestFrame,
      )));
    }
    Deno.exit(0);
  }
  try {
    const connection = await Deno.connect({
      hostname: ARTIFACT_PROBE_SELF_TEST_HOST,
      port: ARTIFACT_PROBE_SELF_TEST_PORT,
      transport: "tcp",
    });
    connection.close();
    // Reaching the address at all is the finding, so the connection is closed
    // without sending anything: nothing leaves this process but the answer.
    Deno.stdout.writeSync(encoder.encode(JSON.stringify(
      {
        selfTest: "network",
        reachable: true,
        detail: "connected",
      } satisfies ArtifactProbeSelfTestFrame,
    )));
  } catch (error) {
    Deno.stdout.writeSync(encoder.encode(JSON.stringify(
      {
        selfTest: "network",
        reachable: false,
        detail: (error as Error).name,
      } satisfies ArtifactProbeSelfTestFrame,
    )));
  }
  Deno.exit(0);
}

/**
 * Reads what the parent said, or reports that it cannot.
 *
 * A self-test frame is recognised here rather than in a separate worker: the
 * point of the self-test is that it runs inside the same unit, through the same
 * launcher, with the same properties as a real probe. A second entry point
 * could drift from the one being checked.
 */
async function readRequest(): Promise<
  | { path: string; sizeBytes: number }
  | { selfTest: "network" | "filesystem" }
  | undefined
> {
  const request = await new Response(Deno.stdin.readable).json().catch(() =>
    undefined
  );
  const asked = (request as { selfTest?: unknown } | null)?.selfTest;
  if (
    request !== null && typeof request === "object" &&
    (asked === "network" || asked === "filesystem")
  ) return { selfTest: asked };
  if (
    request === null || typeof request !== "object" ||
    typeof (request as { path?: unknown }).path !== "string" ||
    typeof (request as { sizeBytes?: unknown }).sizeBytes !== "number" ||
    !Number.isFinite((request as { sizeBytes: number }).sizeBytes)
  ) return undefined;
  return request as { path: string; sizeBytes: number };
}

async function probe(): Promise<void> {
  const request = await readRequest();
  if (request === undefined) return refuse("unreadable");
  if ("selfTest" in request) return await selfTest(request.selfTest);
  if (request.sizeBytes > ARTIFACT_PROBE_MAX_BYTES) {
    return refuse("too-large", ARTIFACT_PROBE_MAX_BYTES);
  }

  // A bounded read: the parent has already checked the size, and this refuses a
  // file that grew between the check and the read rather than reading it.
  const handle = await Deno.open(request.path, { read: true }).catch(() =>
    undefined
  );
  if (handle === undefined) return refuse("unreadable");
  const buffer = new Uint8Array(ARTIFACT_PROBE_MAX_BYTES + 1);
  let filled = 0;
  try {
    while (filled < buffer.byteLength) {
      const read = await handle.read(buffer.subarray(filled));
      if (read === null) break;
      filled += read;
      if (read === 0) break;
    }
  } finally {
    handle.close();
  }
  if (filled > ARTIFACT_PROBE_MAX_BYTES) {
    return refuse("too-large", ARTIFACT_PROBE_MAX_BYTES);
  }
  const bytes = buffer.subarray(0, filled);

  const media = classifyArtifactMedia({ content: bytes });
  if (media === null) return refuse("malformed");

  const report = describe(bytes, media.mediaType);
  if (report === undefined) return refuse("malformed");
  write({ result: report });
}

/**
 * Describes bytes that already have a media type the sniffer agreed with. Each
 * describer returns undefined when the bytes do not hold together — a PNG that
 * declares a size and then ends early, a text file that is not text — so the
 * caller can say "malformed" rather than describing something it did not read.
 */
function describe(
  bytes: Uint8Array,
  mediaType: string,
): ArtifactProbeReport | undefined {
  const base = (report: Omit<ArtifactProbeReport, "byteLength">) =>
    ({
      ...report,
      byteLength: bytes.byteLength,
    }) as ArtifactProbeReport;

  if (mediaType.startsWith("image/")) {
    const image = describeImage(bytes, mediaType);
    if (image === undefined) return undefined;
    return base({ status: "described", kind: "image", mediaType, ...image });
  }
  if (mediaType.startsWith("video/")) {
    const media = describeMedia(bytes, mediaType);
    if (media === undefined) return undefined;
    return base({ status: "described", kind: "video", mediaType, ...media });
  }
  if (mediaType.startsWith("audio/")) {
    const media = describeMedia(bytes, mediaType);
    if (media === undefined) return undefined;
    return base({ status: "described", kind: "audio", mediaType, ...media });
  }
  if (mediaType === "application/pdf") {
    const text = describeText(bytes);
    return base({
      status: "described",
      kind: "pdf",
      mediaType,
      utf8: text.utf8,
    });
  }
  if (
    mediaType.startsWith("text/") || mediaType === "application/json" ||
    mediaType === "application/xml"
  ) {
    const text = describeText(bytes);
    return base({
      status: "described",
      kind: "text",
      mediaType,
      lineCount: text.lineCount,
      utf8: text.utf8,
    });
  }
  return base({ status: "described", kind: "unknown", mediaType });
}

if (import.meta.main) {
  try {
    await probe();
  } catch {
    // A defect in a describer is not a property of the file, but it is still
    // this subprocess's answer: report it rather than exiting with nothing.
    refuse("malformed");
  }
  Deno.exit(0);
}
