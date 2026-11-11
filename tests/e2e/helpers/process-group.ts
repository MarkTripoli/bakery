type ProcessGroup = {
  signal(name: "TERM" | "KILL"): Promise<void>;
  alive(): Promise<boolean>;
  exited: Promise<unknown>;
};

/** Wait for every owned group member, not just the launcher, before cleanup. */
export async function terminateProcessGroup(
  group: ProcessGroup,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 50)),
): Promise<void> {
  const drained = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!await group.alive()) return true;
      await pause();
    }
    return !await group.alive();
  };
  await group.signal("TERM");
  if (!await drained()) {
    // The launcher can exit before a child. Escalate even in that case.
    await group.signal("KILL");
    if (!await drained()) throw new Error("OWNED_PROCESS_GROUP_NOT_CLEANED");
  }
  await group.exited;
}

export function ownedProcessGroup(command: Deno.ChildProcess): ProcessGroup {
  const send = (name: "TERM" | "KILL" | "0") =>
    new Deno.Command("kill", {
      args: [`-${name}`, `-${command.pid}`],
      stdout: "null",
      stderr: "null",
    }).output();
  return {
    signal: async (name) => {
      await send(name);
    },
    alive: async () => (await send("0")).success,
    exited: command.status,
  };
}
