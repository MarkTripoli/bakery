import { readFileSync } from "node:fs";
import {
  type CatalogComposition,
  type CatalogEntry,
  type CatalogLevel,
  type ComponentCatalog,
  type ConsumerLevel,
  parseComponentCatalog,
} from "./schema.ts";

export * from "./schema.ts";

/** Authored catalog next to the other UI baselines. */
export const DEFAULT_CATALOG_URL = new URL(
  "../../../docs/technical-design/ui-baselines/components.json",
  import.meta.url,
);

/** What a caller needs from the catalog; every field narrows the result. */
export type ComponentNeed = {
  /** Free text such as "table of records"; matched against names, descriptions and usage text. */
  query?: string;
  /** Raw intrinsic tag the caller is about to write, for example `table`. */
  element?: string;
  /** Restrict to one Atomic Design level. */
  level?: CatalogLevel;
  /** Restrict to components this consumer level may import. */
  consumerLevel?: ConsumerLevel;
  /** ARIA role the caller needs the component to carry. */
  role?: string;
};

export type ComponentMatch = {
  entry: CatalogEntry;
  score: number;
  /** Human readable reasons the entry matched, strongest first. */
  reasons: string[];
};

/** Throws with every schema issue when the value is not a valid catalog. */
export function createCatalog(value: unknown): ComponentCatalog {
  const result = parseComponentCatalog(value);
  if (!result.success) {
    throw new Error(`invalid component catalog:\n${result.issues.join("\n")}`);
  }
  return result.catalog;
}

/** Reads and validates components.json; pass a URL or path to read another file. */
export function loadCatalog(
  source: URL | string = DEFAULT_CATALOG_URL,
): ComponentCatalog {
  return createCatalog(JSON.parse(readFileSync(source, "utf8")));
}

export function getComponent(
  id: string,
  catalog: ComponentCatalog = loadCatalog(),
): CatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === id);
}

export function getComposition(
  id: string,
  catalog: ComponentCatalog = loadCatalog(),
): CatalogComposition | undefined {
  return catalog.compositions.find((composition) => composition.id === id);
}

function words(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(
    /[^a-z0-9]+/,
  ).filter((w) => w.length > 2);
}

/**
 * Ranks catalog entries against a need. Filters (level, consumerLevel, role,
 * element) exclude entries; the query and element add score. With no filter and
 * no query every entry is returned in catalog order.
 */
export function findComponents(
  need: ComponentNeed,
  catalog: ComponentCatalog = loadCatalog(),
): ComponentMatch[] {
  const queryWords = words(need.query ?? "");
  const matches: ComponentMatch[] = [];
  for (const entry of catalog.entries) {
    if (need.level && entry.level !== need.level) continue;
    if (
      need.consumerLevel &&
      !entry.usage.allowedLevels.includes(need.consumerLevel)
    ) continue;
    if (need.role && entry.a11y.role !== need.role) continue;
    let score = 0;
    const reasons: string[] = [];
    if (need.element) {
      if (!entry.usage.replacesElements.includes(need.element)) continue;
      score += 100;
      reasons.push(`replaces raw <${need.element}>`);
    }
    if (queryWords.length) {
      const fields: [string, string, number][] = [
        ["name", `${entry.name} ${entry.id}`, 5],
        ["description", entry.description, 3],
        ["whenToUse", entry.usage.whenToUse, 3],
        ["variants", entry.variants.join(" "), 1],
      ];
      for (const [label, text, weight] of fields) {
        const haystack = new Set(words(text));
        const hits = queryWords.filter((word) => haystack.has(word));
        if (hits.length) {
          score += hits.length * weight;
          reasons.push(`${label}: ${hits.join(", ")}`);
        }
      }
      if (!score) continue;
    }
    matches.push({ entry, score, reasons });
  }
  return matches.sort((a, b) => b.score - a.score);
}
