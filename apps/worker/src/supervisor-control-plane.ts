import { awaitWithAbort } from "./supervisor-support.ts";

export type ControlPlaneState = {
  tail: Promise<void>;
  abortController: AbortController | null;
  inFlight: Set<Promise<void>>;
};

export async function withControlPlane<T>(
  state: ControlPlaneState,
  lifecycleSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let release!: () => void;
  const previous = state.tail;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueSignal = signal ?? lifecycleSignal;
  let acquired = false;
  let workSettled = false;
  let wrapperFinished = false;
  let trackedWork: Promise<void> | undefined;
  try {
    await awaitWithAbort(previous, queueSignal);
    if (queueSignal.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    acquired = true;
    const operationController = new AbortController();
    const hardController = new AbortController();
    const abortOperation = () => operationController.abort();
    const abortHardOperation = () => operationController.abort();
    const abortExplicit = () => hardController.abort();
    lifecycleSignal.addEventListener("abort", abortOperation, { once: true });
    hardController.signal.addEventListener("abort", abortHardOperation, {
      once: true,
    });
    signal?.addEventListener("abort", abortExplicit, { once: true });
    state.abortController = hardController;
    try {
      let operation: Promise<T>;
      try {
        operation = work(operationController.signal);
      } catch (error) {
        operation = Promise.reject(error);
      }
      const onWorkSettled = () => {
        workSettled = true;
        state.inFlight.delete(settledWork);
        if (wrapperFinished) release();
      };
      const settledWork = operation.then(onWorkSettled, onWorkSettled);
      trackedWork = settledWork;
      state.inFlight.add(settledWork);
      return await awaitWithAbort(operation, hardController.signal);
    } finally {
      lifecycleSignal.removeEventListener("abort", abortOperation);
      hardController.signal.removeEventListener("abort", abortHardOperation);
      signal?.removeEventListener("abort", abortExplicit);
      if (state.abortController === hardController) {
        state.abortController = null;
      }
    }
  } finally {
    if (acquired) {
      if (trackedWork) {
        wrapperFinished = true;
        if (workSettled) release();
      } else {
        release();
      }
    } else void previous.then(release, release);
  }
}
