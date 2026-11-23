import { mkdir, open as openFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { run, type Runtime } from "./run.ts";
import { createSessionApi, readSessionConfig } from "./session-call.ts";
import { createSessionFilesApi } from "./session-files.ts";

/**
 * The `bakery` command.
 *
 * Two transports, one command set (#404). A person's shell reads `BAKERY_TOKEN`;
 * a session has no such token, so the same commands speak to the session
 * gateway instead. Which one runs is decided by what the environment holds, not
 * by a flag: a flag would let a session try the person path and read the answer
 * as a permissions problem, and it would put the choice in every script.
 */
if (import.meta.main) {
  const environment = (name: string) => process.env[name];
  const readFileText = (path: string) => readFile(path, "utf8");
  const output: Runtime["output"] = {
    text: (line) => process.stdout.write(`${line}\n`),
    bytes: (content) => process.stdout.write(content),
    file: async (path, content, overwrite) => {
      await mkdir(dirname(path), { recursive: true });
      // "wx" refuses a file that exists, so a download never silently replaces one.
      const handle = await openFile(path, overwrite ? "w" : "wx");
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
    },
  };

  // The session path is chosen by the file the worker writes, because that file
  // only exists inside a session. `BAKERY_TOKEN` never appears in one.
  const credentialFile = environment("BAKERY_SESSION_CREDENTIAL_FILE");
  const inSession = credentialFile !== undefined &&
    credentialFile.trim() !== "";

  const code = await run(process.argv.slice(2), {
    environment,
    error: (line) => process.stderr.write(`${line}\n`),
    output,
    readFileText,
    ...(inSession
      ? {
        inSession: true as const,
        // One client for the whole command line, so the tool list `tools`
        // prints and the calls the commands make cannot disagree.
        async createSessionApi(flags) {
          return createSessionFilesApi(
            createSessionApi(
              await readSessionConfig({ environment, flags, readFileText }),
            ),
          );
        },
        async listSessionTools() {
          const config = await readSessionConfig({
            environment,
            flags: {},
            readFileText,
          });
          return await createSessionApi(config).tools();
        },
      }
      : {}),
  });
  process.exit(code);
}
