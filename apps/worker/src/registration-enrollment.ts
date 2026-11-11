import { readWorkerEnrollmentToken, type WorkerConfig } from "./config.ts";
import type { WorkerApiClient } from "./client.ts";
import {
  generateWorkerCredential,
  RegistrationStore,
} from "./registration-store.ts";
import { ensurePrivateDirectory } from "./storage.ts";
import type { RegistrationState, WorkerRegistration } from "./types.ts";

export async function ensureRegistration(
  config: WorkerConfig,
  store: RegistrationStore,
  client: WorkerApiClient,
): Promise<RegistrationState> {
  await ensurePrivateDirectory(config.stateDir);
  let state = await store.load();
  if (
    state?.workerHostId && state.principalId && state.registrationGeneration
  ) {
    client.setCredential(state.workerCredential);
    return state;
  }
  const enrollmentToken = config.enrollmentToken ??
    (config.enrollmentTokenPath
      ? readWorkerEnrollmentToken({
        path: config.enrollmentTokenPath,
        fromDescriptor: config.enrollmentTokenFromDescriptor,
      })
      : undefined);
  if (!enrollmentToken) {
    throw new Error("BAKERY_WORKER_ENROLLMENT_TOKEN_REQUIRED");
  }
  if (!state?.registrationIdempotencyKey) {
    state = await store.savePendingRegistration(
      state?.workerCredential || generateWorkerCredential(),
      crypto.randomUUID(),
    );
  }
  const registrationIdempotencyKey = state.registrationIdempotencyKey;
  if (!registrationIdempotencyKey) {
    throw new Error("WORKER_REGISTRATION_STATE_INVALID");
  }
  const body: WorkerRegistration = {
    enrollmentToken,
    workerCredential: state.workerCredential,
    name: config.name,
    os: config.os,
    architecture: config.architecture,
    capabilities: config.capabilities,
    toolchainVersions: config.toolchainVersions,
    slots: config.slots,
  };
  const result = await client.register(body, registrationIdempotencyKey);
  const registered = await store.saveRegistered(
    state.workerCredential,
    result.value,
  );
  client.setCredential(registered.workerCredential);
  return registered;
}
