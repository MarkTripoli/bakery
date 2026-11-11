const DEFAULT_CANDIDATE_LIMIT = 32;
const DEFAULT_BIND_ATTEMPTS = 5;
const DEFAULT_COLLISION_ATTEMPTS = 3;

const processAllocatedPorts = new Set<number>();

export type LoopbackPortProbe = () => number;

function probeLoopbackPort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

export function reserveUniqueLoopbackPort(
  allocated: Set<number>,
  probe: LoopbackPortProbe = probeLoopbackPort,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
): number {
  for (let attempt = 0; attempt < candidateLimit; attempt++) {
    const port = probe();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`LOOPBACK_PORT_INVALID:${port}`);
    }
    if (allocated.has(port)) continue;
    allocated.add(port);
    return port;
  }
  throw new Error("LOOPBACK_PORT_CANDIDATES_EXHAUSTED");
}

/** Draws a loopback port that no earlier draw in this process returned. */
export function reserveProcessLoopbackPort(): number {
  return reserveUniqueLoopbackPort(processAllocatedPorts);
}

export function isRootlessKitPortCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("RootlessKit PortManager.AddPort()") &&
    message.includes("bind: address already in use");
}

export type PortCollisionRetry = Readonly<{
  attempt: number;
  maxAttempts: number;
  message: string;
}>;

function announcePortCollisionRetry(retry: PortCollisionRetry): void {
  console.error(
    `[port-collision-retry] attempt ${retry.attempt} of ${retry.maxAttempts} lost a host-port bind race: ${retry.message}`,
  );
}

/**
 * Re-runs a whole stack boot when, and only when, Docker lost a host-port bind
 * race. No allocator can exclude a socket held outside Docker's bookkeeping, so
 * `run` draws its ports itself and every attempt draws fresh ones. After a
 * collision `cleanupOwnedAttempt` must remove what that attempt created and
 * restore any prerequisite the removal took with it. Any other error rethrows
 * at once, without cleanup. Every lost race is announced through `onCollision`
 * (stderr by default) before its cleanup, so a boot that needed a retry says
 * so; a callback that throws ends the retry before that cleanup, so it must
 * not. A first boot cleans the project it owns. A restart of a pinned port
 * must not (that would destroy the state under test): its failed start leaves
 * only a created container that the next start recreates, so it passes a
 * cleanup that removes nothing and `run` re-draws the port from the second
 * attempt on.
 */
export async function retryOnPortCollision<T>(
  options: Readonly<{
    run: (attempt: number) => Promise<T>;
    cleanupOwnedAttempt: () => Promise<void>;
    maxAttempts?: number;
    onCollision?: (retry: PortCollisionRetry) => void;
  }>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_COLLISION_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("LOOPBACK_PORT_ATTEMPTS_INVALID");
  }

  let collision: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await options.run(attempt);
    } catch (error) {
      if (!isRootlessKitPortCollision(error)) throw error;
      collision = error;
      const message = error instanceof Error ? error.message : String(error);
      // Start at the bind error: the head is daemon text, and a caller may
      // append container logs after it. The match guarantees the marker.
      const from = message.indexOf("RootlessKit PortManager.AddPort()");
      const window = message.slice(from, from + 300);
      (options.onCollision ?? announcePortCollisionRetry)({
        attempt,
        maxAttempts,
        message: from > 0 ? `…${window}` : window,
      });
    }
    try {
      await options.cleanupOwnedAttempt();
    } catch (cleanupError) {
      throw new AggregateError(
        [collision, cleanupError],
        "LOOPBACK_PORT_COLLISION_CLEANUP_FAILED",
      );
    }
  }

  throw new Error(`LOOPBACK_PORT_BIND_RETRIES_EXHAUSTED:${maxAttempts}`, {
    cause: collision,
  });
}

export function bindLoopbackPortWithRetry(
  options: Readonly<{
    allocated: Set<number>;
    bind: (port: number) => Promise<void>;
    cleanupOwnedAttempt: () => Promise<void>;
    probe?: LoopbackPortProbe;
    maxAttempts?: number;
  }>,
): Promise<number> {
  return retryOnPortCollision({
    maxAttempts: options.maxAttempts ?? DEFAULT_BIND_ATTEMPTS,
    cleanupOwnedAttempt: options.cleanupOwnedAttempt,
    run: async () => {
      const port = reserveUniqueLoopbackPort(options.allocated, options.probe);
      await options.bind(port);
      return port;
    },
  });
}
