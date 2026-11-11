import { type ReactNode, useId } from "react";
import type { MessageKey, Translator } from "@bakery/i18n";
import { Button } from "../atoms/Button.tsx";
import { Heading } from "../atoms/Heading.tsx";
import { LogoMark } from "../atoms/LogoMark.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Text } from "../atoms/Text.tsx";
import { CodeBlock } from "../organisms/CodeBlock.tsx";
import { ArtboardShell } from "./ArtboardShell.tsx";
import {
  workerEnrollmentFixtures,
  workerEnrollmentPlaceholder,
  type WorkerEnrollmentState,
} from "../fixtures/worker-readiness.ts";
import "./worker-enrollment.css";

export type WorkerEnrollmentInstructionsProps = {
  /** Selects static synthetic facts, never a live worker or credential. */
  state: WorkerEnrollmentState;
  /** Caller-owned locale; every human-readable label passes through it. */
  t: Translator;
  /** Removes the nested main landmark when embedded in the product shell. */
  embedded?: boolean;
};

type EnrollmentLabel = Extract<MessageKey, `workerEnrollment.${string}`> extends
  `workerEnrollment.${infer Key}` ? Key : never;

const navigation = [
  ["work", "work-list"],
  ["applications", "applications"],
  ["sessions", "terminal"],
  ["machines", "monitor"],
  ["integrations", "integration"],
  ["automations", "lightning"],
  ["settings", "settings-sun"],
] as const;

function Step({ number, title, complete = false, children }: {
  number: number;
  title: string;
  complete?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className="ui-worker-enrollment__step"
      data-complete={complete || undefined}
    >
      <div className="ui-worker-enrollment__track" aria-hidden="true">
        <span className="ui-worker-enrollment__circle">
          {complete ? "✓" : number}
        </span>
      </div>
      <div className="ui-worker-enrollment__step-body">
        <Heading level="subsection" rank={2}>{title}</Heading>
        {children}
      </div>
    </li>
  );
}

/** Source-shaped, inert enrollment presentation. No action callbacks or live facts. */
export function WorkerEnrollmentInstructions(
  { state, t, embedded = false }: WorkerEnrollmentInstructionsProps,
) {
  const titleId = useId();
  const fixture = workerEnrollmentFixtures[state];
  const positive = state === "start" || state === "listening" ||
    state === "connected";
  const label = (key: EnrollmentLabel) => t(`workerEnrollment.${key}`);
  return (
    <div
      className="ui-worker-enrollment"
      data-fixture-id={fixture.id}
      data-source={fixture.source}
      data-state={state}
      data-ui-component="workerEnrollmentInstructions"
      data-variant={fixture.stage}
    >
      <ArtboardShell
        mainRole={embedded ? "presentation" : "main"}
        applicationRail={
          <div className="ui-worker-enrollment__rail">
            <div className="ui-worker-enrollment__brand">
              <LogoMark variant="rail" aria-hidden="true" />
              {label("brand")}
            </div>
            <div className="ui-worker-enrollment__workspace">
              {label("workspace")}
              <IconGlyph name="chevron-down" size="small" />
            </div>
            {/* Source navigation is context only. No dead links or pretend navigation controls. */}
            <ul
              className="ui-worker-enrollment__navigation"
              aria-label={label("navigation")}
            >
              {navigation.map(([name, glyph]) => (
                <li key={name} data-selected={name === "machines" || undefined}>
                  <IconGlyph name={glyph} />
                  {label(`nav.${name}`)}
                </li>
              ))}
            </ul>
            <Text variant="caption">{label("recent")}</Text>
            <ul className="ui-worker-enrollment__navigation">
              {(["repository", "activity", "notifications"] as const).map((
                name,
              ) => (
                <li key={name}>
                  <IconGlyph name="terminal" size="small" />
                  {label(`nav.${name}`)}
                </li>
              ))}
            </ul>
            <div className="ui-worker-enrollment__identity">
              <span aria-hidden="true">
                {label("person").split(/\s+/).map((part) => part[0]).slice(0, 2)
                  .join("")}
              </span>
              <Text variant="hint">{label("person")}</Text>
              <IconGlyph name="chevron-down" size="small" />
            </div>
            <Text variant="caption">{label("provenance")}</Text>
          </div>
        }
        header={
          <div className="ui-worker-enrollment__header">
            <div
              className="ui-worker-enrollment__phone-status"
              aria-hidden="true"
            >
              <span>9:41</span>
              <span>
                <IconGlyph name="phone-status" />
              </span>
            </div>
            <div className="ui-worker-enrollment__desktop-header">
              <Text variant="hint">{label("workspaceLabel")}</Text>
              <span aria-hidden="true">/</span>
              <Text variant="hint">{label("header")}</Text>
              <span className="ui-worker-enrollment__search" aria-hidden="true">
                <IconGlyph name="search" />
                <kbd>⌘ K</kbd>
              </span>
            </div>
            <div className="ui-worker-enrollment__mobile-header">
              <IconGlyph name="menu" />
              <strong>{label("brand")}</strong>
              <Text variant="hint">{label("workspace")} ⌄</Text>
            </div>
          </div>
        }
      >
        <section aria-labelledby={titleId}>
          <div className="ui-worker-enrollment__intro">
            <div className="ui-worker-enrollment__breadcrumb-desktop">
              <Text variant="hint">{label("breadcrumb")}</Text>
            </div>
            <div className="ui-worker-enrollment__breadcrumb-mobile">
              <Text variant="hint">‹ {label("nav.machines")}</Text>
            </div>
            <div className="ui-worker-enrollment__title">
              <Heading id={titleId} level="page-plain">
                {label("title")}
              </Heading>
              <Text variant="muted">{label("subtitle")}</Text>
            </div>
          </div>
          <div className="ui-worker-enrollment__columns">
            <ol className="ui-worker-enrollment__steps">
              <Step number={1} title={label("prepare")}>
                <div className="ui-worker-enrollment__command">
                  <CodeBlock
                    aria-label={label("command")}
                    code={workerEnrollmentPlaceholder}
                    variant="command"
                    tabIndex={0}
                  />
                </div>
                <div className="ui-worker-enrollment__action">
                  <Button variant="preview-secondary">{label("copy")}</Button>
                </div>
                <div className="ui-worker-enrollment__hint">
                  <Text variant="muted">{label("prepareHint")}</Text>
                  <Text variant="caption">{label("disclaimer")}</Text>
                </div>
              </Step>
              <Step number={2} title={label("open")}>
                <Text variant="muted">{label("openHint")}</Text>
              </Step>
              <Step number={3} title={label("token")}>
                <Text variant="muted">{label("tokenHint")}</Text>
                <div className="ui-worker-enrollment__token">
                  <div className="ui-worker-enrollment__token-row">
                    <span aria-label={label("maskedToken")}>
                      •••• •••• ••••
                    </span>
                    <Button variant="preview-secondary">
                      {label("reveal")}
                    </Button>
                  </div>
                  <Text variant="caption">{label("expiry")}</Text>
                </div>
              </Step>
              <Step
                number={4}
                title={label("listen")}
                complete={state === "connected"}
              >
                <Text variant="muted">{label("listenHint")}</Text>
                <div
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  aria-label={positive && state !== "listening" &&
                      state !== "connected"
                    ? label(`state.${state}`)
                    : undefined}
                  className="ui-worker-enrollment__status"
                  data-panel={positive ? fixture.stage : "negative"}
                >
                  {state === "listening"
                    ? (
                      <>
                        <div className="ui-worker-enrollment__listening-title">
                          <IconGlyph name="listening" />
                          <strong>{label("listeningTitle")}</strong>
                        </div>
                        <Text variant="muted">{label(`state.${state}`)}</Text>
                        <div className="ui-worker-enrollment__action">
                          <Button variant="preview-secondary">
                            {label("stop")}
                          </Button>
                        </div>
                      </>
                    )
                    : state === "connected"
                    ? (
                      <>
                        <span className="ui-worker-enrollment__badge">
                          {label("connectedBadge")}
                        </span>
                        <Heading level="section-plain" rank={3}>
                          {label("connectedTitle")}
                        </Heading>
                        <Text>{label(`state.${state}`)}</Text>
                        <Text variant="hint">{label("connectedHint")}</Text>
                        <div className="ui-worker-enrollment__action">
                          <Button variant="preview-primary">
                            {label("openMachine")}
                          </Button>
                        </div>
                      </>
                    )
                    : (
                      <>
                        {!positive && <Text>{label(`state.${state}`)}</Text>}
                        <div className="ui-worker-enrollment__action">
                          <Button variant="preview-primary">
                            {label("action")}
                          </Button>
                        </div>
                      </>
                    )}
                </div>
              </Step>
            </ol>
            <aside
              className="ui-worker-enrollment__summary"
              aria-label={label("summary")}
            >
              <div>
                <Heading level="subsection" rank={2}>
                  {label("machine")}
                </Heading>
                <Text variant="muted">{label("capacity")}</Text>
                <Text variant="muted">{label("owner")}</Text>
              </div>
              <div>
                <Heading level="subsection" rank={2}>
                  {label("checkinTitle")}
                </Heading>
                <Text variant="muted">{label("checkinHint")}</Text>
              </div>
              <div>
                <Heading level="subsection" rank={2}>{label("review")}</Heading>
                <Text variant="muted">{label("reviewHint")}</Text>
              </div>
            </aside>
          </div>
          <footer className="ui-worker-enrollment__footer">
            <Text variant="caption">{label("provenance")}</Text>
          </footer>
        </section>
      </ArtboardShell>
    </div>
  );
}
