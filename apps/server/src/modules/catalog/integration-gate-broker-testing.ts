import type { ProviderRequestPort } from "./integration-gate.ts";
import {
  type BrokerDeps,
  createBrokerWithProfiles,
} from "./integration-gate-broker.ts";
import {
  assertHostProfile,
  type HostAuthProfile,
} from "./integration-gate-profiles.ts";

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

/** Accepts exactly `http://127.0.0.1:<port>` or a bare https origin; everything else stays rejected. */
function assertTestingProfile(profile: HostAuthProfile): void {
  if (!LOOPBACK_ORIGIN.test(profile.origin)) {
    assertHostProfile(profile);
    return;
  }
  assertHostProfile({
    ...profile,
    origin: profile.origin.replace("http://", "https://"),
  });
}

/**
 * TEST ONLY. Broker over caller-supplied profiles, the sole path that
 * accepts a loopback http origin. No file under `apps/server/src` other
 * than this one may import it; a security scan enforces that.
 */
export function createBrokerForTesting(
  deps: BrokerDeps & {
    profiles: Readonly<Record<string, HostAuthProfile>>;
  },
): ProviderRequestPort {
  const { profiles, ...rest } = deps;
  for (const profile of Object.values(profiles)) assertTestingProfile(profile);
  return createBrokerWithProfiles(rest, profiles);
}
