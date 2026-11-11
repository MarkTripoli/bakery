const DESCRIPTION_FILLERS = new Set([
  "a description",
  "description",
  "field",
  "generic bounded string value.",
  "property",
  "value",
  "data",
  "n/a",
  "none",
  "tbd",
  "unknown",
  "...",
]);

// Generated prose that restates the field name and encoding and nothing else.
// The inventory once carried 890 of these; the family is rejected so it cannot return.
const TEMPLATE_FAMILY = [
  /^Supplies \w+ for [\w.<>]+[.;] [Ee]ncoded as/,
  /^[\w ]+ field \w+; encoded as/,
  /^[\w ]+ value recorded for this [\w ]+ record\.$/,
  /^(?:[Ii]nput|[Oo]utput) (?:object|contract) for [\w<>]+; fields are validated at the transport boundary\.$/,
  /^Bounded string value identifying or describing this [\w ]+ record\.$/,
];

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function normalizedWords(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isPathRestatement(description: string, path: string): boolean {
  const pathParts = path.split(/[.[\]<>?|{}]+/).filter(Boolean);
  const field = pathParts.at(-1);
  const meaningfulPath = pathParts[0] === "schema" || pathParts[0] === "schemas"
    ? pathParts.slice(1)
    : pathParts;
  const pathWords = normalizedWords(meaningfulPath.join(" "));
  const descriptionWords = normalizedWords(description);
  return !!field && (
    descriptionWords === normalizedWords(field) ||
    descriptionWords === pathWords ||
    descriptionWords === `${pathWords} value` ||
    descriptionWords === `${pathWords} field` ||
    descriptionWords === `${pathWords} property`
  );
}

export function descriptionDefectKind(
  description: unknown,
  path: string,
): "missing" | "invalid" | undefined {
  if (!text(description)) return "missing";
  const value = description.trim();
  const lower = value.toLowerCase();
  if (
    JSON_SCHEMA_TYPES.has(lower) || DESCRIPTION_FILLERS.has(lower) ||
    /^value for [^;]+;\s*format\b/i.test(value) ||
    /\b(?:todo|tbd)\b/i.test(value) || isPathRestatement(value, path) ||
    TEMPLATE_FAMILY.some((pattern) => pattern.test(value))
  ) return "invalid";
  return undefined;
}
