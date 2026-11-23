import { hostSatisfiedCapabilities } from "@bakery/contracts/workflow-action-registry";

/**
 * The one rule deciding whether a worker host may run a job (#52 AC2).
 *
 * A job's stored requirements name the capabilities it needs and, optionally,
 * the native OS it must run on (`platform`, in the enrolled host `os`
 * vocabulary: linux, macos, windows). A host that lacks any capability, or
 * whose OS is not the required platform, never receives the job, however much
 * free capacity it has: an iOS build needs a Mac, so with every Mac offline the
 * job stays queued rather than landing on a Linux host. The claim query applies
 * the same rule in SQL; the claim and the attempt start recheck it here against
 * the admitted requirements. A host capability that substitutes for an action
 * capability meets it (`tool-gateway` meets `paper`, #436).
 */
export function hostMeetsJobRequirements(
  requirements: {
    readonly capabilities: readonly string[];
    readonly platform?: string;
  },
  host: { readonly os: string; readonly capabilities: readonly string[] },
): boolean {
  const satisfied = hostSatisfiedCapabilities(host.capabilities);
  if (
    requirements.capabilities.some((capability) =>
      !satisfied.includes(capability)
    )
  ) return false;
  return requirements.platform === undefined ||
    requirements.platform === host.os;
}
