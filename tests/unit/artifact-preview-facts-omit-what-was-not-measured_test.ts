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

const locale = "en-US";
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
      "[tasks.run.artifact.size size=340]",
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
      "[files.preview.facts.duration duration=0:12] · " +
      "[tasks.run.artifact.size size=2,048]",
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
      "[files.preview.facts.duration duration=1:02] · " +
      "[tasks.run.artifact.size size=1]",
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
      "[tasks.run.artifact.size size=18]",
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
    "[files.preview.facts.video kind=Video] · [tasks.run.artifact.size size=2]",
  );
  // Kilobytes keep the app's thousands separator, because the app's own
  // `tasks.run.artifact.size` rule is what produces this number.
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

Deno.test("bytes format the way the rest of the app formats them", () => {
  // TaskRunArtifactCard divides by 1024 and formats through Intl with one
  // fraction digit; these are the same numbers through the same rule, so a
  // reader comparing the facts line with the artifact card sees one app.
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
      "de-DE",
      t,
    ).endsWith("[tasks.run.artifact.size size=1,5]"),
    true,
  );
  // A file under a kilobyte rounds to the same "0" the rest of the app shows.
  assertEquals(
    previewFacts(
      {
        status: "described",
        kind: "text",
        mediaType: "text/plain",
        byteLength: 10,
      },
      locale,
      t,
    ),
    "[files.preview.facts.text kind=Text] · " +
      "[tasks.run.artifact.size size=0]",
  );
});
