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
 * Version 13 adds the session thread rows (`session.thread.*`) and the four
 * kept connection rows under `session.feed.*`.
 * Version 14 adds the desktop app's browser sign-in pages
 * (`auth.desktopSignIn.*`).
 * Version 17 adds the Slack provider rows (`integrations.slack.*`).
 */
export const catalogVersion = "17";
export const englishCatalog: Readonly<Record<MessageKey, string>> = english;
export const catalogs: Readonly<
  Record<SupportedLocale, Readonly<Partial<Record<MessageKey, string>>>>
> = Object.freeze({
  en: english,
  "en-XA": englishPseudo,
  "ar-XB": arabicPseudo,
});
