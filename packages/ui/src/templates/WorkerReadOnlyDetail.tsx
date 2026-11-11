import { useId } from "react";
import type { MessageKey, Translator } from "@bakery/i18n";
import { Button } from "../atoms/Button.tsx";
import { Heading } from "../atoms/Heading.tsx";
import { LogoMark } from "../atoms/LogoMark.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Text } from "../atoms/Text.tsx";
import { ArtboardShell } from "./ArtboardShell.tsx";
import {
  workerDetailFixtures,
  type WorkerDetailState,
} from "../fixtures/worker-readiness.ts";
import "./worker-detail.css";

export type WorkerReadOnlyDetailProps = {
  state: WorkerDetailState;
  t: Translator;
  /** Removes the nested main landmark when embedded in the product shell. */
  embedded?: boolean;
};
type DetailLabel = Extract<MessageKey, `workerDetail.${string}`> extends
  `workerDetail.${infer Key}` ? Key : never;
type ShellLabel = Extract<MessageKey, `workerEnrollment.${string}`> extends
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

/** Full Harnesses artwork, not a controller or evidence of supported capabilities. */
export function WorkerReadOnlyDetail(
  { state, t, embedded = false }: WorkerReadOnlyDetailProps,
) {
  const titleId = useId();
  const boundaryId = useId();
  const fixture = workerDetailFixtures[state];
  const label = (key: ShellLabel) => t(`workerEnrollment.${key}`);
  const detail = (key: DetailLabel) => t(`workerDetail.${key}`);
  const illustrated = state === "ready" || state === "worstcase";
  return (
    <div
      className="ui-worker-detail"
      data-ui-component="workerReadOnlyDetail"
      data-fixture-id={fixture.id}
      data-source={fixture.source}
      data-state={state}
      data-variant="detail"
      aria-describedby={boundaryId}
    >
      {/* Deliberately visible before the artboard. Full evidence must include this qualification. */}
      <section
        className="ui-worker-detail__boundary"
        role="region"
        aria-label={detail("disclaimer")}
      >
        <Text>{detail("disclaimer")}</Text>
        <div id={boundaryId}>
          <Text>{detail("boundary")}</Text>
        </div>
      </section>
      <div data-paper-whole-artboard="worker-detail">
        <ArtboardShell
          mainRole={embedded ? "presentation" : "main"}
          applicationRail={
            <div className="ui-worker-detail__rail">
              <div className="ui-worker-detail__brand">
                <LogoMark variant="rail" aria-hidden="true" />
                {label("brand")}
              </div>
              <div className="ui-worker-detail__workspace">
                {label("workspace")}
                <IconGlyph name="chevron-down" size="small" />
              </div>
              {/* Source navigation is context only. No dead links or pretend navigation controls. */}
              <ul
                className="ui-worker-detail__navigation"
                aria-label={label("navigation")}
              >
                {navigation.map(([name, glyph]) => (
                  <li
                    key={name}
                    data-selected={name === "machines" || undefined}
                  >
                    <IconGlyph name={glyph} />
                    {label(`nav.${name}`)}
                  </li>
                ))}
              </ul>
              <Text variant="caption">{label("recent")}</Text>
              <ul className="ui-worker-detail__navigation">
                {(["repository", "activity", "notifications"] as const).map((
                  name,
                ) => (
                  <li key={name}>
                    <IconGlyph name="terminal" size="small" />
                    {label(`nav.${name}`)}
                  </li>
                ))}
              </ul>
              <div className="ui-worker-detail__identity">
                <span aria-hidden="true">
                  {label("person").split(/\s+/).map((part) => part[0]).slice(
                    0,
                    2,
                  )
                    .join("")}
                </span>
                <Text variant="hint">{label("person")}</Text>
                <IconGlyph name="chevron-down" size="small" />
              </div>
              <Text variant="caption">{label("provenance")}</Text>
            </div>
          }
          header={
            <div className="ui-worker-detail__header">
              <div
                className="ui-worker-detail__phone-status"
                aria-hidden="true"
              >
                <span>9:41</span>
                <span>
                  <IconGlyph name="phone-status" />
                </span>
              </div>
              <div className="ui-worker-detail__desktop-header">
                <Text variant="hint">{label("workspaceLabel")}</Text>
                <span aria-hidden="true">/</span>
                <Text variant="hint">{detail("breadcrumb")}</Text>
                <span className="ui-worker-detail__search" aria-hidden="true">
                  <IconGlyph name="search" />
                  <kbd>⌘ K</kbd>
                </span>
              </div>
              <div className="ui-worker-detail__mobile-header">
                <IconGlyph name="menu" />
                <strong>{label("brand")}</strong>
                <Text variant="hint">{label("workspace")}⌄</Text>
              </div>
            </div>
          }
        >
          <section aria-labelledby={titleId}>
            <div className="ui-worker-detail__intro">
              <div className="ui-worker-detail__breadcrumb-desktop">
                <Text variant="hint">{detail("breadcrumb")}</Text>
              </div>
              <div className="ui-worker-detail__breadcrumb-mobile">
                <Text variant="hint">‹ {label("nav.machines")}</Text>
              </div>
              <div className="ui-worker-detail__title-row">
                <div className="ui-worker-detail__title">
                  <Heading level="page-plain" id={titleId}>
                    {detail("name")}
                  </Heading>
                  <Text variant="muted">{detail("platform")}</Text>
                </div>
                <Button variant="preview-primary" density="standard">
                  {detail("checkUpdates")}
                </Button>
              </div>
            </div>
            {!illustrated && (
              <div className="ui-worker-detail__state">
                <Heading level="subsection-compact" rank={2}>
                  {detail("title")}
                </Heading>
                <Text>{detail(`state.${state}`)}</Text>
              </div>
            )}
            {state === "worstcase" && (
              <div className="ui-worker-detail__state">
                <Text>{detail("state.worstcase")}</Text>
              </div>
            )}
            <div className="ui-worker-detail__columns">
              <div className="ui-worker-detail__harnesses">
                <div className="ui-worker-detail__tabs">
                  <span data-selected="true">{detail("harnesses")}</span>
                  <span>{detail("providers")}</span>
                  <span>{label("nav.settings")}</span>
                </div>
                <div className="ui-worker-detail__row">
                  <Heading level="subsection-compact" rank={2}>
                    {detail("installedHarnesses")}
                  </Heading>
                  <Text variant="hint">
                    {detail(illustrated ? "checked" : "unproved")}
                  </Text>
                </div>
                {illustrated
                  ? fixture.illustration.harnesses.map((harness) => (
                    <article
                      className="ui-worker-detail__harness"
                      key={harness.name}
                    >
                      <div className="ui-worker-detail__row">
                        <Heading level="subsection-compact" rank={3}>
                          {detail(harness.name)}
                        </Heading>
                        <span
                          className="ui-worker-detail__badge"
                          data-update={harness.update || undefined}
                        >
                          {detail(
                            harness.update ? "updateAvailable" : "upToDate",
                          )}
                        </span>
                      </div>
                      <Text variant="hint">
                        {detail(
                          harness.name === "pi"
                            ? "managedIdle"
                            : "managedActive",
                        )}
                      </Text>
                      <dl className="ui-worker-detail__versions">
                        {(["installed", "tested", "latest"] as const).map((
                          version,
                        ) => (
                          <div key={version}>
                            <dt>{detail(version)}</dt>
                            <dd>{harness[version]}</dd>
                          </div>
                        ))}
                      </dl>
                      {harness.update && (
                        <div className="ui-worker-detail__row">
                          <span className="ui-worker-detail__link">
                            {detail("releaseNotes")}
                          </span>
                          <Button
                            variant="preview-secondary"
                            density="standard"
                          >
                            {detail("reviewUpdate")}
                          </Button>
                        </div>
                      )}
                    </article>
                  ))
                  : (
                    <Text variant="muted">
                      {detail("missingPrerequisites")}
                    </Text>
                  )}
                <div>
                  <Button variant="preview-secondary" density="standard">
                    {detail("installHarness")}
                  </Button>
                </div>
              </div>
              <aside className="ui-worker-detail__inspector">
                <div>
                  <div className="ui-worker-detail__machine">
                    <IconGlyph name="server" size="large" />
                    <Heading level="subsection-compact" rank={2}>
                      {detail(illustrated ? "machineOnline" : "unproved")}
                    </Heading>
                  </div>
                  <Text variant="muted">
                    {detail(illustrated ? "slots" : "missingPrerequisites")}
                  </Text>
                  <Text variant="hint">
                    {detail(illustrated ? "heartbeat" : "noObservation")}
                  </Text>
                </div>
                <div>
                  <Heading level="subsection-compact" rank={2}>
                    {detail("daemon")}
                  </Heading>
                  <Text>
                    {illustrated
                      ? fixture.illustration.daemon
                      : detail("unproved")}
                  </Text>
                  <Text variant="hint">
                    {detail(illustrated ? "daemonUpdate" : "unavailable")}
                  </Text>
                  <Button variant="preview-secondary" density="static-compact">
                    {detail("reviewDaemon")}
                  </Button>
                </div>
                <div>
                  <Heading level="subsection-compact" rank={2}>
                    {detail("policy")}
                  </Heading>
                  <Text variant="muted">{detail("policyDescription")}</Text>
                  <span className="ui-worker-detail__link">
                    {detail("managePolicy")}
                  </span>
                </div>
              </aside>
            </div>
            <div className="ui-worker-detail__footer">
              <Text variant="caption">{detail("provenance")}</Text>
            </div>
          </section>
        </ArtboardShell>
      </div>
    </div>
  );
}
