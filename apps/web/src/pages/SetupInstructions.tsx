import { useState } from "react";
import type { Translator } from "@bakery/i18n";
import * as UI from "@bakery/ui";
import type { CodingAgent } from "./machine-state.ts";
import {
  type EnrollmentInput,
  harnessRepositorySetting,
  minutesLeft,
  saveSetupCodeCommand,
  startWorkerCommand,
  workerEnvironment,
} from "./machine-wizard.ts";

/**
 * The numbered instructions for putting the Bakery worker on a Linux machine
 * (#70), shared by the add-a-machine wizard and a retired machine's "Set up
 * again": the one-time setup code, the file it goes in, the settings, the
 * command that starts the worker, and the notice that Bakery is waiting for it.
 * What happens when the person leaves is the caller's to say.
 */

function Numbered({ n, text }: { n: number; text: string }) {
  return (
    <UI.Heading level="subsection" rank={2}>
      {`${n}. ${text}`}
    </UI.Heading>
  );
}

/** A value or block of values to copy, with its one Copy button under it. */
function Copyable(
  { code, label, translate, secret = false }: {
    code: string;
    label: string;
    translate: Translator;
    /** A one-time secret: shown as the setup-code plate, not as code. */
    secret?: boolean;
  },
) {
  const [copied, setCopied] = useState(false);
  return (
    <UI.Stack gap="compact">
      {secret ? <UI.SetupKey>{code}</UI.SetupKey> : (
        <UI.CodeBlock
          code={code}
          language="dotenv"
          variant="command"
          aria-label={label}
        />
      )}
      <UI.Inline gap="compact">
        <UI.Button
          variant="secondary"
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
              } catch {
                // The clipboard is not available here: the text stays selectable.
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

export function SetupInstructions(
  { input, agent, code, expiresAt, now, serverUrl, translate }: {
    input: EnrollmentInput;
    /** The coding agent the machine runs, or null when none is known. */
    agent: CodingAgent | null;
    code: string;
    expiresAt: string;
    now: number;
    serverUrl: string;
    translate: Translator;
  },
) {
  const startCommand = startWorkerCommand(input.os);
  const settings = workerEnvironment({ serverUrl, input, agent });
  let n = 0;
  return (
    <>
      <UI.Text>{translate("machines.wizard.install.intro" as never)}</UI.Text>
      <UI.Text variant="muted">
        {translate("machines.wizard.install.expires" as never, {
          minutes: minutesLeft(expiresAt, now),
        })}
      </UI.Text>
      <Numbered
        n={++n}
        text={translate("machines.wizard.install.copyCode" as never)}
      />
      <Copyable
        secret
        code={code}
        label={translate("machines.wizard.install.copyCode" as never)}
        translate={translate}
      />
      <Numbered
        n={++n}
        text={translate("machines.wizard.install.saveCode" as never)}
      />
      <Copyable
        code={saveSetupCodeCommand()}
        label={translate("machines.wizard.install.saveCode" as never)}
        translate={translate}
      />
      <UI.Text variant="muted">
        {translate("machines.wizard.install.saveCodeHint" as never)}
      </UI.Text>
      <Numbered
        n={++n}
        text={translate("machines.wizard.install.settings.linux" as never)}
      />
      <Copyable
        code={settings}
        label={translate("machines.wizard.install.settings.linux" as never)}
        translate={translate}
      />
      {agent
        ? (
          <UI.Text variant="muted">
            {translate("machines.wizard.install.change" as never, {
              setting: harnessRepositorySetting(agent),
              agent: translate(`machines.agent.${agent}` as never),
            })}
          </UI.Text>
        )
        : null}
      <Numbered
        n={++n}
        text={translate("machines.wizard.install.start.linux" as never)}
      />
      {startCommand
        ? (
          <Copyable
            code={startCommand}
            label={translate("machines.wizard.install.start.linux" as never)}
            translate={translate}
          />
        )
        : null}
      <UI.AlertBanner tone="information" role="status" aria-live="polite">
        {translate("machines.wizard.install.waiting" as never)}
      </UI.AlertBanner>
    </>
  );
}
