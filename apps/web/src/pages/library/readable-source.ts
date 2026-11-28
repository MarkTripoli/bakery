export function readableSource(source: string): string {
  if (source.trim().includes("\n")) return source;
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}
