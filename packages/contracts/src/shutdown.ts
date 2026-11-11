export async function boundedShutdown(
  shutdown: () => Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    shutdown(),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        onTimeout();
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}
