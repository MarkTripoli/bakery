import arabicPseudo from "../locales/ar-XB.json" with { type: "json" };
import englishPseudo from "../locales/en-XA.json" with { type: "json" };
import english from "../locales/en.json" with { type: "json" };
import type { MessageKey } from "./keys.ts";
import type { SupportedLocale } from "./locale.ts";

/**
 * Bumped whenever the key set changes, so a client that caches or prefetches
 * catalogs by version can tell it moved. Issue 44 adds the artifact retrieval
 * namespace after GHI-35's problems/auth keys and issue 39's worker problem.
 * Version 11 adds the installation object storage rows (`settings.storage.*`).
 * Version 12 adds the artifact preview handoff rows (`artifact.handoff.*`).
 */
export const catalogVersion = "12";
export const englishCatalog: Readonly<Record<MessageKey, string>> = english;
export const catalogs: Readonly<
  Record<SupportedLocale, Readonly<Partial<Record<MessageKey, string>>>>
> = Object.freeze({
  en: english,
  "en-XA": englishPseudo,
  "ar-XB": arabicPseudo,
});
