/**
 * The facts line under an artifact preview.
 *
 * Design's rule (issue #437, comment 7029326304) is one short line of measured
 * facts, and the important half of that rule is what it forbids: a fact the
 * probe did not measure is left out, never rendered as 0, "unknown", or an
 * em dash. A line that guesses is worse than a shorter line, because a reader
 * cannot tell which numbers were measured.
 */
import { assertEquals } from "@std/assert";
import {
  previewFacts,
  type PreviewFactsTranslate,
} from "../../apps/web/src/pages/preview-facts.ts";

const locale = "en";
// A translator that shows exactly which keys were used, in order, so a test can
// see both the words and the order without depending on real copy.
const t: PreviewFactsTranslate = (key, values) => {
  const rendered = Object.entries(values ?? {})
    .map(([name, value]) => `${name}=${value}`).join(" ");
  return `[${key}${rendered ? ` ${rendered}` : ""}]`;
};

Deno.test("an image states its size, its pixels and its bytes", () => {
  assertEquals(
    previewFacts(
      {
        status: "described",
        kind: "image",
        mediaType: "image/png",
        byteLength: 348_160,
        width: 1200,
        height: 800,
      },
      locale,
      t,
    ),
    "[files.preview.facts.image kind=Image] · " +
      "[files.preview.facts.pixels width=1200 height=800] · " +
      "[files.size.kilobytes value=340]",
  );
});

Deno.test("a video states its length, not a size it does not have", () => {
  assertEquals(
    previewFacts(
      {
        status: "described",
        kind: "video",
        mediaType: "video/mp4",
        byteLength: 2_097_152,
        durationMs: 12_500,
      },
      locale,
      t,
    ),
    "[files.preview.facts.video kind=Video] · " +
      // Under a minute there is no zero to state: "0 min 2 s" would be a
      // measurement of nothing (#437, UX review).
      "[files.preview.facts.durationSeconds seconds=12] · " +
      "[files.size.megabytes value=2]",
  );
});

Deno.test("an audio file states its length", () => {
  assertEquals(
    previewFacts(
      {
        status: "described",
        kind: "audio",
        mediaType: "audio/mpeg",
        byteLength: 1024,
        durationMs: 62_000,
      },
      locale,
      t,
    ),
    "[files.preview.facts.audio kind=Audio] · " +
      "[files.preview.facts.duration minutes=1 seconds=2] · " +
      "[files.size.kilobytes value=1]",
  );
});

Deno.test("a text file states its lines, and says nothing about pixels", () => {
  assertEquals(
    previewFacts(
      {
        status: "described",
        kind: "text",
        mediaType: "text/plain",
        byteLength: 18_432,
        lineCount: 412,
        utf8: true,
      },
      locale,
      t,
    ),
    "[files.preview.facts.text kind=Text] · " +
      "[files.preview.facts.lines lines=412] · " +
      "[files.size.kilobytes value=18]",
  );
});

Deno.test("a measured fact with no number is dropped, not rendered empty", () => {
  // The probe answered, but this format does not state a duration. The line
  // must get shorter, not say "Duration: unknown".
  const facts = previewFacts(
    {
      status: "described",
      kind: "video",
      mediaType: "video/webm",
      byteLength: 2048,
    },
    locale,
    t,
  );
  assertEquals(facts.includes("files.preview.facts.duration"), false);
  assertEquals(
    facts,
    "[files.preview.facts.video kind=Video] · [files.size.kilobytes value=2]",
  );
  // The size is the Files screens' own formatter, so this line and the Size row
  // beside it cannot disagree about how big the file is.
});

Deno.test("nothing described means no facts line at all", () => {
  // A refusal, or a version never probed, produces an empty string so a caller
  // can render nothing rather than an empty line with a separator in it.
  for (
    const probe of [
      null,
      { status: "refused", code: "too-large", limit: 67_108_864 } as const,
      { status: "refused", code: "sandbox-unavailable" } as const,
      { status: "refused", code: "unreadable" } as const,
    ]
  ) {
    assertEquals(previewFacts(probe, locale, t), "");
  }
});

Deno.test("bytes are the Files screens' own units, under a kilobyte included", () => {
  // 1.5 KB: one fraction digit at most, so it reads "1.5" and never "1.50".
  assertEquals(
    previewFacts(
      {
        status: "described",
        kind: "image",
        mediaType: "image/png",
        byteLength: 1_536,
        width: 1,
        height: 1,
      },
      locale,
      t,
    ).endsWith("[files.size.kilobytes value=1.5]"),
    true,
  );
  // A file under a kilobyte is bytes, which is what the Size row says too: "77 B",
  // never "0.1 KiB" beside it.
  assertEquals(
    previewFacts(
      {
        status: "described",
        kind: "text",
        mediaType: "text/plain",
        byteLength: 77,
      },
      locale,
      t,
    ),
    "[files.preview.facts.text kind=Text] · [files.size.bytes value=77]",
  );
});
