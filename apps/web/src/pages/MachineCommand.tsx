import { useState } from "react";
import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import { clockText } from "./machine-add.ts";
import { supportedRows } from "./machine-systems.ts";

function systemsText(translate: Translator): string {
  return supportedRows().map((row) =>
    `${translate(`machines.os.${row.os}` as never)} ${row.processor}`
  ).join(` ${translate("machines.add.or" as never)} `);
}

function CommandBox(
  { command, translate }: { command: string; translate: Translator },
) {
  const [copied, setCopied] = useState(false);
  return (
    <UI.Stack gap="compact">
      <UI.CodeBlock
        code={command}
        language="bash"
        variant="command"
        state="overflowing"
        role="region"
        aria-label={translate("machines.add.commandLabel" as never)}
      />
      <UI.Inline gap="compact">
        <UI.Button
          variant="primary"
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(command);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            })();
          }}
        >
          {translate(
            (copied
              ? "machines.wizard.copied"
              : "machines.wizard.copy") as never,
          )}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
}

export function MachineCommand(
  { command, expiresAt, now, translate }: {
    command: string;
    expiresAt: string;
    now: number;
    translate: Translator;
  },
) {
  return (
    <>
      <CommandBox command={command} translate={translate} />
      <UI.Text variant="muted">
        {translate("machines.add.terminal" as never)}
      </UI.Text>
      <UI.Text variant="muted">
        {translate("machines.add.once" as never, {
          clock: clockText(expiresAt, now),
          systems: systemsText(translate),
        })}
      </UI.Text>
    </>
  );
}
