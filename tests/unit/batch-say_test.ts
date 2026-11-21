import { assertEquals } from "@std/assert";
import type { Translator } from "@bakery/i18n";
import { phrase } from "../../apps/web/src/pages/batches/batch-display.ts";
import { say } from "../../apps/web/src/pages/batches/say.ts";

/** A translator that shows exactly what it was asked, so a test sees what was translated. */
const asked: Translator = (key, values) =>
  `<${key} ${JSON.stringify(values ?? {})}>`;

Deno.test("a reason phrase is translated first and its sentence is filled with the result", () => {
  const text = say(asked, {
    key: "batches.banner.finished.title",
    params: { reason: phrase("batches.finish.issueFailed"), number: "412" },
  });
  // The phrase got the message's own values; the sentence got the phrase's words.
  assertEquals(
    text,
    '<batches.banner.finished.title {"number":"412","reason":"<batches.finish.issueFailed {\\"number\\":\\"412\\"}>"}>',
  );
});

Deno.test("free text that reads like a catalogue key is only text", () => {
  // A person whose display name starts with "batches." must not have it rewritten as a key.
  const text = say(asked, {
    key: "batches.banner.stopped.title",
    params: { name: "batches.admin", time: "Nov 20" },
  });
  assertEquals(
    text,
    '<batches.banner.stopped.title {"name":"batches.admin","time":"Nov 20"}>',
  );
  // The same for a repository named like one.
  const repo = say(asked, {
    key: "batches.page.title",
    params: { repository: "batches.core/web" },
  });
  assertEquals(repo, '<batches.page.title {"repository":"batches.core/web"}>');
});

Deno.test("a message with no values is just its sentence", () => {
  assertEquals(
    say(asked, { key: "batches.banner.choosing.title" }),
    "<batches.banner.choosing.title {}>",
  );
});
