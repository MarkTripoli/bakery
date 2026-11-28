import { dirname, join } from "node:path";
import { LinkStepFailed } from "./link.ts";
import type { PairingBinding } from "./pairing.ts";
import { linuxLinkScript, macLinkService } from "./service-link.ts";

export type ServiceRunner = Readonly<{
  run: (argv: readonly string[], log: string) => Promise<number>;
  writeFile: (path: string, text: string, mode: number) => Promise<void>;
  makeDirectory: (path: string) => Promise<void>;
}>;

export type ServiceHost = Readonly<{
  target: "linux" | "macos";
  root: string;
  home: string;
  uid: number | null;
  username: string;
}>;

export function serviceLog(root: string): string {
  return join(root, "service.log");
}

export async function startLinkedService(
  binding: PairingBinding,
  host: ServiceHost,
  runner: ServiceRunner,
): Promise<void> {
  const log = serviceLog(host.root);
  if (host.target === "linux") {
    const code = await runner.run(
      ["sudo", "sh", "-c", linuxLinkScript(binding, host.root)],
      log,
    );
    if (code !== 0) {
      throw new LinkStepFailed("The service could not be added.", log);
    }
    return;
  }
  if (host.uid === null) {
    throw new LinkStepFailed("The service could not be added.", log);
  }
  const service = macLinkService(
    binding,
    host.root,
    host.username,
    host.home,
    host.uid,
  );
  await runner.makeDirectory(dirname(service.plistPath));
  await runner.writeFile(service.plistPath, service.plist, 0o644);
  const [bootout, bootstrap] = service.commands;
  await runner.run(bootout!, log);
  if ((await runner.run(bootstrap!, log)) !== 0) {
    throw new LinkStepFailed("The service could not be started.", log);
  }
}
