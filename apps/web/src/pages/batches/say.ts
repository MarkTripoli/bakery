import type { Translator } from "@bakery/i18n";
import type { Message } from "./batch-display.ts";

/**
 * A display message as a sentence. A value marked as a phrase (a reason such as
 * "it ran out of time") is translated first, with the message's own values, so
 * each language orders the clause as it needs to. Every other value is free
 * text, such as a person's name or a repository, and goes in as it is: a name
 * that happens to read like a catalogue key is still only a name.
 */
export function say(translate: Translator, message: Message): string {
  const plain: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.params ?? {})) {
    if (typeof value === "object") continue;
    plain[name] = value;
  }
  const values: Record<string, string | number> = { ...plain };
  for (const [name, value] of Object.entries(message.params ?? {})) {
    if (typeof value === "object") {
      values[name] = translate(value.phrase as never, plain);
    }
  }
  return translate(message.key as never, values);
}
