import type { Translator } from "@bakery/i18n";
import type { Message } from "./batch-display.ts";

/**
 * A display message as a sentence. A value that is itself a catalogue key (a
 * reason phrase) is translated first, with the message's own values, so each
 * language orders the clause as it needs to.
 */
export function say(translate: Translator, message: Message): string {
  const values: Record<string, string | number> = { ...message.params };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && value.startsWith("batches.")) {
      values[name] = translate(value as never, message.params ?? {});
    }
  }
  return translate(message.key as never, values);
}
