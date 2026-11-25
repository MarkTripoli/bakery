import type { CodingAgent } from "./machine-state.ts";
import { agentOfKey } from "./machine-agents.ts";

export type SoftwareUpdate =
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "upToDate" }
  | { readonly kind: "notReported" };

export type SoftwareRow = Readonly<{
  key: string;
  agent: CodingAgent | null;
  name: string;
  kind: "worker" | "harness" | "toolchain";
  version: string;
  installedBy: "bakery" | "external";
  update: SoftwareUpdate;
}>;

export function softwareUpdate(
  installed: string,
  available: string | null | undefined,
): SoftwareUpdate {
  if (available === null || available === undefined || available === "") {
    return { kind: "notReported" };
  }
  return available === installed
    ? { kind: "upToDate" }
    : { kind: "available", version: available };
}

export function softwareRows(
  components: readonly Readonly<{
    componentKey: string;
    kind: SoftwareRow["kind"];
    actualVersion: string;
    installOwner: SoftwareRow["installedBy"];
    availableVersion?: string | null;
  }>[],
): SoftwareRow[] {
  return components.map((component) => ({
    key: `${component.componentKey}@${component.actualVersion}`,
    agent: agentOfKey(component.componentKey),
    name: component.componentKey,
    kind: component.kind,
    version: component.actualVersion,
    installedBy: component.installOwner,
    update: softwareUpdate(component.actualVersion, component.availableVersion),
  }));
}
