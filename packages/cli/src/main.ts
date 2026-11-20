import { mkdir, open as openFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import { run } from "./run.ts";

/** The `bakery` command: `deno run -A packages/cli/src/main.ts files ls /`. */
if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    environment: (name) => process.env[name],
    error: (line) => process.stderr.write(`${line}\n`),
    output: {
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
    },
  });
  process.exit(code);
}
