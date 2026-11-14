import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import * as UI from "@bakery/ui";
import type { MessageArguments, MessageKey, Translator } from "@bakery/i18n";
import type { BakeryApiClient } from "../api/client.ts";
import { workerProviderAuthQueryOptions } from "../api/query.ts";
import { useProtectedScope } from "../app/query-scope-context.tsx";
import {
  type AgentRow,
  attemptEnded,
  type AttemptFacts,
  dialogView,
  paymentKind,
  PROVIDER_OF_AGENT,
} from "./machine-agents.ts";
import type { CodingAgent } from "./machine-state.ts";

/**
 * The machine page's Coding agents (#70 C2b): one row per agent the machine
 * reported, the one banner for an agent that is not signed in, and the sign-in
 * dialog. Words such as "binding", "provider" and "billing route" never reach
 * the screen; each sentence that depends on server data (an address, a code, an
 * expiry, a command) is shown only when the server gives it.
 */

function message(
  translate: Translator,
  key: string,
  arguments_?: MessageArguments,
): string {
  return translate(key as MessageKey, arguments_);
}

const SLOT = "\u0001";

/** A translated sentence with one slot replaced by a node, so word order stays the translator's. */
function withNode(text: string, node: ReactNode): ReactNode {
  const [before, after] = text.split(SLOT);
  return (
    <>
      {before}
      {node}
      {after ?? ""}
    </>
  );
}

/** An address as it reads: no scheme, no query. The link itself carries the whole address. */
function shownAddress(address: string): string {
  const url = new URL(address);
  return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

const agentName = (translate: Translator, agent: CodingAgent) =>
  message(translate, `machines.agent.${agent}`);

type Session = Readonly<{
  row: AgentRow;
  /** `check` runs quietly and opens the dialog only when the person is needed. */
  mode: "check" | "signIn";
  bindingId: string | null;
  attemptId: string | null;
  created: AttemptFacts | null;
  /** Creating the setup or the attempt did not work. */
  failedToStart: boolean;
  dialogOpen: boolean;
}>;

export type AgentSignIn = Readonly<{
  /** Opens the dialog and starts a sign-in for the agent. */
  signIn: (row: AgentRow) => void;
  /** Runs a check; the dialog opens only if the person is needed. */
  check: (row: AgentRow) => void;
  checking: CodingAgent | null;
  checkFailed: ReadonlySet<CodingAgent>;
  dialog: ReactNode;
}>;

export function useAgentSignIn(options: {
  api: BakeryApiClient;
  organizationId: string;
  machineId: string;
  machineName: string;
  translate: Translator;
  /** Called when a binding or a sign-in changed what the rows show. */
  onChanged: () => Promise<void> | void;
}): AgentSignIn {
  const { api, organizationId, machineId, machineName, translate, onChanged } =
    options;
  const scope = useProtectedScope();
  const [session, setSession] = useState<Session | null>(null);
  const [checkFailed, setCheckFailed] = useState<ReadonlySet<CodingAgent>>(
    new Set(),
  );
  const settled = useRef<string | null>(null);
  // The sign-in being started: closing the dialog (or starting another) ends it, so a late answer knows nobody is waiting.
  const started = useRef(0);
  const live = useRef<number | null>(null);

  const polled = useQuery(
    workerProviderAuthQueryOptions(api, scope, {
      workerId: machineId,
      bindingId: session?.bindingId ?? "",
      authAttemptId: session?.attemptId ?? "",
    }),
  );
  const facts: AttemptFacts | null = session?.created
    ? {
      ...session.created,
      ...(polled.data
        ? {
          state: polled.data.state,
          flow: polled.data.flow ?? session.created.flow,
          challenge: polled.data.challenge ?? session.created.challenge,
          expiresAt: polled.data.expiresAt ?? session.created.expiresAt,
        }
        : {}),
    }
    : null;

  const refocus = useCallback((agent: CodingAgent) => {
    // The row's own button takes focus back once the row has settled.
    setTimeout(() => {
      document.querySelector<HTMLElement>(
        `[data-agent-check="${agent}"], [data-agent-signin="${agent}"]`,
      )?.focus();
    }, 50);
  }, []);

  const cancelAttempt = useCallback(
    (bindingId: string, authAttemptId: string) => {
      void api.workerProviderAuth.cancel({
        organizationId,
        workerId: machineId,
        bindingId,
        authAttemptId,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    [api, machineId, organizationId],
  );

  const start = useCallback(
    async (
      row: AgentRow,
      mode: "check" | "signIn",
      knownBindingId: string | null = null,
    ) => {
      settled.current = null;
      const key = ++started.current;
      live.current = key;
      const mine = () => live.current === key;
      setCheckFailed((previous) => {
        const next = new Set(previous);
        next.delete(row.agent);
        return next;
      });
      setSession({
        row,
        mode,
        bindingId: knownBindingId ?? row.binding?.id ?? null,
        attemptId: null,
        created: null,
        failedToStart: false,
        dialogOpen: mode === "signIn",
      });
      const failed = () => {
        if (!mine()) return;
        setSession((current) =>
          current && current.row.agent === row.agent
            ? { ...current, failedToStart: true }
            : current
        );
      };
      let bindingId = knownBindingId ?? row.binding?.id ?? null;
      if (bindingId === null) {
        if (row.componentKey === null) return failed();
        const made = await api.workerProviderBindings.create({
          organizationId,
          workerId: machineId,
          input: {
            componentKey: row.componentKey,
            provider: PROVIDER_OF_AGENT[row.agent],
            billingRoute: "subscription",
            authMode: "host_native",
            credentialLocation: "harness_host",
          },
          idempotencyKey: crypto.randomUUID(),
        });
        if (!made.ok) return failed();
        bindingId = made.data.id;
        // Kept at once: if the attempt cannot be made, Try again must reuse this setup, not make a second.
        const madeId = made.data.id;
        if (mine()) {
          setSession((current) =>
            current && current.row.agent === row.agent
              ? { ...current, bindingId: madeId }
              : current
          );
        }
        void onChanged();
      }
      const created = await api.workerProviderAuth.create({
        organizationId,
        workerId: machineId,
        bindingId,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!created.ok) return failed();
      if (!mine()) {
        // The dialog was closed (or another sign-in began) while this one was starting: nobody is waiting for it.
        if (!attemptEnded(created.data.state)) {
          cancelAttempt(bindingId, created.data.authAttemptId);
        }
        return;
      }
      setSession((current) =>
        current && current.row.agent === row.agent
          ? {
            ...current,
            bindingId,
            attemptId: created.data.authAttemptId,
            created: {
              flow: created.data.flow,
              state: created.data.state,
              challenge: created.data.challenge,
              instructions: created.data.instructions,
              expiresAt: created.data.expiresAt,
            },
          }
          : current
      );
    },
    [api, cancelAttempt, machineId, onChanged, organizationId],
  );

  const close = useCallback(
    (agent: CodingAgent, cancelOnClose: boolean) => {
      if (
        cancelOnClose && session?.bindingId && session.attemptId &&
        !attemptEnded(facts?.state ?? "pending")
      ) {
        cancelAttempt(session.bindingId, session.attemptId);
      }
      // A sign-in still starting is cancelled when it answers.
      live.current = null;
      setSession(null);
      refocus(agent);
    },
    [
      cancelAttempt,
      facts?.state,
      refocus,
      session?.attemptId,
      session?.bindingId,
    ],
  );

  // What the attempt has reached decides what happens next.
  const state = facts?.state ?? null;
  const agent = session?.row.agent ?? null;
  const mode = session?.mode ?? null;
  const attemptId = session?.attemptId ?? null;
  useEffect(() => {
    if (agent === null || state === null || attemptId === null) return;
    if (settled.current === `${attemptId}:${state}`) return;
    if (state === "completed") {
      settled.current = `${attemptId}:${state}`;
      void onChanged();
      if (mode === "check") {
        setSession(null);
        refocus(agent);
      }
      return;
    }
    if (mode === "check") {
      if (state === "challenge_issued" || state === "terminal") {
        // The person is needed: the check becomes a sign-in.
        settled.current = `${attemptId}:${state}`;
        setSession((current) =>
          current ? { ...current, dialogOpen: true } : current
        );
      } else if (attemptEnded(state)) {
        settled.current = `${attemptId}:${state}`;
        setCheckFailed((previous) => new Set(previous).add(agent));
        setSession(null);
        refocus(agent);
      }
    } else if (state === "canceled") {
      settled.current = `${attemptId}:${state}`;
      setSession(null);
      refocus(agent);
    }
  }, [agent, attemptId, mode, onChanged, refocus, state]);
  // A challenge the page cannot show safely ends this attempt: it is cancelled and the dialog says it did not start.
  const unusable = Boolean(
    session && !session.failedToStart && session.attemptId && facts &&
      dialogView(facts, Date.now(), session.row.agent).kind === "unusable",
  );
  const unusableHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!unusable || !session?.bindingId || !session.attemptId) return;
    if (unusableHandled.current === session.attemptId) return;
    unusableHandled.current = session.attemptId;
    cancelAttempt(session.bindingId, session.attemptId);
    setSession((current) =>
      current && current.attemptId === session.attemptId
        ? { ...current, failedToStart: true, attemptId: null, created: null }
        : current
    );
  }, [cancelAttempt, session, unusable]);
  // A check that could not even start says so under the row.
  useEffect(() => {
    if (session?.mode === "check" && session.failedToStart) {
      setCheckFailed((previous) => new Set(previous).add(session.row.agent));
      setSession(null);
      refocus(session.row.agent);
    }
  }, [refocus, session]);

  let dialog: ReactNode = null;
  if (session?.dialogOpen) {
    const raw = dialogView(facts, Date.now(), session.row.agent);
    const view = session.failedToStart || raw.kind === "unusable"
      ? ({ kind: "failed" } as const)
      : raw;
    const name = agentName(translate, session.row.agent);
    const ended = view.kind === "completed" || view.kind === "failed" ||
      view.kind === "expired" || view.kind === "canceled";
    dialog = (
      <UI.Dialog
        open
        onOpenChange={(open) => {
          if (!open) close(session.row.agent, true);
        }}
        title={message(translate, "machines.signIn.title", {
          agent: name,
          machine: machineName,
        })}
        dismissLabel={message(
          translate,
          ended ? "machines.signIn.done" : "machines.signIn.dismiss",
        )}
        data-testid="agent-sign-in"
      >
        <UI.Stack gap="standard">
          <div role="status" aria-live="polite">
            <UI.Stack gap="compact">
              {view.kind === "starting"
                ? (
                  <UI.Text>
                    {message(translate, "machines.signIn.starting")}
                  </UI.Text>
                )
                : null}
              {view.kind === "codeAndAddress"
                ? (
                  <>
                    <UI.Text>
                      {withNode(
                        message(translate, "machines.signIn.stepOpen", {
                          address: SLOT,
                        }),
                        <UI.Link
                          href={view.address}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shownAddress(view.address)}
                        </UI.Link>,
                      )}
                    </UI.Text>
                    <UI.Text>
                      {message(translate, "machines.signIn.stepCode")}
                    </UI.Text>
                    <CopyBlock
                      code={view.code}
                      label={message(translate, "machines.signIn.codeLabel")}
                      translate={translate}
                    />
                  </>
                )
                : null}
              {view.kind === "addressOnly"
                ? (
                  <UI.Link
                    href={view.address}
                    target="_blank"
                    rel="noreferrer"
                    variant="primaryButton"
                  >
                    {message(translate, "machines.signIn.openPage")}
                  </UI.Link>
                )
                : null}
              {view.kind === "onMachine"
                ? (
                  <>
                    <UI.Text>
                      {message(
                        translate,
                        view.command
                          ? "machines.signIn.onMachine"
                          : "machines.signIn.onMachineNoCommand",
                      )}
                    </UI.Text>
                    {view.command
                      ? (
                        <CopyBlock
                          code={view.command}
                          label={message(
                            translate,
                            "machines.signIn.commandLabel",
                          )}
                          translate={translate}
                        />
                      )
                      : null}
                  </>
                )
                : null}
              {view.kind === "codeAndAddress" || view.kind === "addressOnly" ||
                  view.kind === "onMachine"
                ? (
                  <UI.Text variant="muted">
                    {message(translate, "machines.signIn.waiting")}
                  </UI.Text>
                )
                : null}
              {(view.kind === "codeAndAddress" ||
                  view.kind === "addressOnly") &&
                  view.minutes !== null
                ? (
                  <UI.Text variant="muted">
                    {message(translate, "machines.signIn.expires", {
                      minutes: view.minutes,
                    })}
                  </UI.Text>
                )
                : null}
              {view.kind === "completed"
                ? (
                  <UI.Text variant="strong">
                    {message(translate, "machines.signIn.completed")}
                  </UI.Text>
                )
                : null}
              {view.kind === "failed"
                ? (
                  <UI.Text>
                    {message(translate, "machines.signIn.failed")}
                  </UI.Text>
                )
                : null}
              {view.kind === "expired"
                ? (
                  <UI.Text>
                    {message(translate, "machines.signIn.expired")}
                  </UI.Text>
                )
                : null}
            </UI.Stack>
          </div>
          <UI.Inline gap="compact">
            {view.kind === "completed"
              ? (
                <UI.Button
                  variant="primary"
                  onClick={() => close(session.row.agent, false)}
                >
                  {message(translate, "machines.signIn.done")}
                </UI.Button>
              )
              : null}
            {view.kind === "failed" || view.kind === "expired"
              ? (
                <UI.Button
                  variant="primary"
                  onClick={() =>
                    void start(session.row, "signIn", session.bindingId)}
                >
                  {message(
                    translate,
                    view.kind === "failed"
                      ? "machines.signIn.tryAgain"
                      : "machines.signIn.startAgain",
                  )}
                </UI.Button>
              )
              : null}
            {!ended
              ? (
                <UI.Button
                  variant="secondary"
                  onClick={() => close(session.row.agent, true)}
                >
                  {message(translate, "machines.signIn.cancel")}
                </UI.Button>
              )
              : null}
          </UI.Inline>
          {!ended
            ? (
              <UI.Text variant="muted">
                {message(translate, "machines.signIn.closeCancels")}
              </UI.Text>
            )
            : null}
        </UI.Stack>
      </UI.Dialog>
    );
  }

  return {
    signIn: (row) => void start(row, "signIn"),
    check: (row) => void start(row, "check"),
    checking: session?.mode === "check" && !session.dialogOpen
      ? session.row.agent
      : null,
    checkFailed,
    dialog,
  };
}

/** A value to copy, with its one Copy button under it. */
function CopyBlock(
  { code, label, translate }: {
    code: string;
    label: string;
    translate: Translator;
  },
) {
  const [copied, setCopied] = useState(false);
  return (
    <UI.Stack gap="compact">
      <UI.CodeBlock
        code={code}
        language="text"
        variant="command"
        aria-label={label}
      />
      <UI.Inline gap="compact">
        <UI.Button
          variant="secondary"
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            })();
          }}
        >
          {message(
            translate,
            copied ? "machines.wizard.copied" : "machines.wizard.copy",
          )}
        </UI.Button>
      </UI.Inline>
    </UI.Stack>
  );
}

const BADGE_TONE = {
  ready: "success",
  signedOut: "danger",
  notChecked: "neutral",
  notSignedIn: "neutral",
} as const;

/** What the section may offer the person: everything, nothing (a retired machine) or only a note (not an administrator). */
export type AgentAccess = "full" | "readOnly" | "adminOnly";

function AgentLine(
  { row, translate, access }: {
    row: AgentRow;
    translate: Translator;
    access: AgentAccess;
  },
) {
  if (access === "adminOnly") {
    return <>{message(translate, "machines.agents.adminOnly")}</>;
  }
  if (row.binding === null || row.state === "notSignedIn") {
    return (
      <>
        {message(
          translate,
          row.componentKey === null && access === "full"
            ? "machines.agents.notHeard"
            : "machines.agents.notSignedIn",
          { agent: agentName(translate, row.agent) },
        )}
      </>
    );
  }
  const kind = paymentKind(row.binding);
  // The line follows the state: it never says an agent uses a sign-in that has ended or was never checked.
  const subscription = kind !== "apiKey" && kind !== "localModel";
  return (
    <>
      {message(
        translate,
        kind === "apiKey"
          ? "machines.agents.usesKey"
          : kind === "localModel"
          ? "machines.agents.usesLocal"
          : subscription && row.state === "signedOut"
          ? "machines.agents.lineSignedOut"
          : subscription && row.state === "notChecked"
          ? "machines.agents.lineNotChecked"
          : "machines.agents.usesSubscription",
      )}
    </>
  );
}

export function CodingAgentRow(
  { row, translate, access, signIn }: {
    row: AgentRow;
    translate: Translator;
    access: AgentAccess;
    signIn: AgentSignIn;
  },
) {
  const busy = signIn.checking === row.agent;
  const canSignIn = row.binding !== null || row.componentKey !== null;
  return (
    <UI.DescriptionItem
      data-testid={`coding-agent-${row.agent}`}
      actionPlacement="below"
      title={agentName(translate, row.agent)}
      description={
        <UI.Stack gap="compact">
          <span>
            <AgentLine row={row} translate={translate} access={access} />
          </span>
          {signIn.checkFailed.has(row.agent)
            ? (
              <span role="status">
                {message(translate, "machines.agents.checkFailed")}
              </span>
            )
            : null}
        </UI.Stack>
      }
      action={access === "adminOnly" ? undefined : (
        <UI.Inline gap="compact">
          <UI.Badge tone={BADGE_TONE[row.state]}>
            {message(translate, `machines.agents.badge.${row.state}`)}
          </UI.Badge>
          {access === "full"
            ? (
              <>
                {row.state === "notSignedIn"
                  ? (
                    <UI.Button
                      variant="primary"
                      data-agent-signin={row.agent}
                      disabled={!canSignIn}
                      onClick={() => signIn.signIn(row)}
                    >
                      {message(translate, "machines.agents.signIn")}
                    </UI.Button>
                  )
                  : null}
                {row.state === "signedOut"
                  ? (
                    <UI.Button
                      variant="primary"
                      data-agent-signin={row.agent}
                      onClick={() => signIn.signIn(row)}
                    >
                      {message(translate, "machines.agents.signInAgain")}
                    </UI.Button>
                  )
                  : null}
                {row.state !== "notSignedIn"
                  ? (
                    <UI.Button
                      variant="secondary"
                      data-agent-check={row.agent}
                      loading={busy}
                      onClick={() => signIn.check(row)}
                    >
                      {message(
                        translate,
                        busy
                          ? "machines.agents.checking"
                          : "machines.agents.check",
                      )}
                    </UI.Button>
                  )
                  : null}
              </>
            )
            : null}
        </UI.Inline>
      )}
    />
  );
}

/** The one banner for an agent that is not signed in or is signed out. */
export function CodingAgentBanner(
  { row, translate, signIn, otherAgentReady }: {
    row: AgentRow;
    translate: Translator;
    signIn: AgentSignIn;
    /** Another coding agent on the machine is Ready: only then does the banner say other work continues. */
    otherAgentReady: boolean;
  },
) {
  const name = agentName(translate, row.agent);
  const kind = row.state === "signedOut" ? "signedOut" : "notSignedIn";
  const canSignIn = row.binding !== null || row.componentKey !== null;
  return (
    <UI.AlertBanner
      tone="warning"
      data-testid="agent-banner"
      action={canSignIn
        ? (
          <UI.Button variant="secondary" onClick={() => signIn.signIn(row)}>
            {message(
              translate,
              kind === "signedOut"
                ? "machines.agents.signInAgain"
                : "machines.agents.signIn",
            )}
          </UI.Button>
        )
        : undefined}
    >
      <UI.Stack gap="compact">
        <UI.Text variant="strong">
          {message(translate, `machines.agents.banner.${kind}.title`, {
            agent: name,
          })}
        </UI.Text>
        <UI.Text>
          {message(translate, `machines.agents.banner.${kind}.body`, {
            agent: name,
          })}
          {kind === "signedOut" && otherAgentReady
            ? ` ${message(translate, "machines.agents.banner.otherWork")}`
            : ""}
        </UI.Text>
      </UI.Stack>
    </UI.AlertBanner>
  );
}
