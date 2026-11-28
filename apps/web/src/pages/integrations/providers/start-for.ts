export function startFor(
  provider: string,
  slug: string,
  start: () => unknown,
): void {
  if (slug === provider) void start();
}
