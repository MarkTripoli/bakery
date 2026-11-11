export type StateLock = {
  readonly path: string;
  release(): Promise<void>;
};

export type StateLockOptions = {
  beforePublish?: () => void | Promise<void>;
};
export type StateLockFactory = (
  path: string,
  options?: StateLockOptions,
) => Promise<StateLock>;

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  await Deno.chmod(path, 0o700);
}

export async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}

async function writeAll(
  file: { write(bytes: Uint8Array): Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += await file.write(bytes.subarray(offset));
  }
}
async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await Deno.open(path, { read: true });
    try {
      await directory.sync();
    } finally {
      directory.close();
    }
  } catch {
    // Directory fsync is not available on every supported filesystem.
  }
}

const LOCK_ACQUISITION_TIMEOUT_MS = 1_000;

async function openLockedFile(path: string): Promise<Deno.FsFile> {
  const file = await Deno.open(path, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  try {
    await Deno.chmod(path, 0o600);
  } catch (error) {
    file.close();
    throw error;
  }
  const lockPromise = file.lock(true);
  let timer: number | undefined;
  try {
    await Promise.race([
      lockPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("LOCK_ACQUISITION_TIMEOUT")),
          LOCK_ACQUISITION_TIMEOUT_MS,
        ) as unknown as number;
      }),
    ]);
    return file;
  } catch (error) {
    file.close();
    void lockPromise.catch(() => undefined);
    if (
      error instanceof Error &&
      error.message === "LOCK_ACQUISITION_TIMEOUT"
    ) {
      throw new Error("WORKER_STATE_LOCKED");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function acquireStateLock(
  path: string,
  options: StateLockOptions = {},
): Promise<StateLock> {
  await ensurePrivateDirectory(parentDirectory(path));
  const file = await openLockedFile(path);
  try {
    await options.beforePublish?.();
  } catch (error) {
    try {
      await file.unlock();
    } finally {
      file.close();
    }
    throw error;
  }
  let released = false;
  return {
    path,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await file.unlock();
      } finally {
        file.close();
      }
    },
  };
}

export async function withStateLock<T>(
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = await acquireStateLock(path);
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

export async function writeJsonAtomically(
  path: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  const directory = parentDirectory(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const file = await Deno.open(temporaryPath, {
    create: true,
    truncate: true,
    write: true,
    mode,
  });
  try {
    await writeAll(file, bytes);
    await file.sync();
  } finally {
    file.close();
  }
  try {
    await Deno.chmod(temporaryPath, mode);
    await Deno.rename(temporaryPath, path);
    await Deno.chmod(path, mode);
    await syncDirectory(directory);
  } catch (error) {
    try {
      await Deno.remove(temporaryPath);
    } catch {
      // Preserve the original filesystem error.
    }
    throw error;
  }
}

export function assertAbsolutePath(path: string, field: string): string {
  const value = path.trim();
  if (
    !value.startsWith("/") || value.endsWith("/..") || value.includes("/../")
  ) {
    throw new Error(`${field}_INVALID`);
  }
  return value;
}
