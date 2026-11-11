import { applyLocaleToDocument, readStoredLocale } from "./locale-cache.ts";
import { applyThemeToDocument, readStoredTheme } from "./theme.ts";

applyThemeToDocument(readStoredTheme());
const storedLocale = readStoredLocale();
if (storedLocale) applyLocaleToDocument(storedLocale);
