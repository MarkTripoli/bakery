import { useId } from "react";
import type { MessageKey, Translator } from "@bakery/i18n";
import { Button } from "../atoms/Button.tsx";
import { Heading } from "../atoms/Heading.tsx";
import { LogoMark } from "../atoms/LogoMark.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Text } from "../atoms/Text.tsx";
import { StatusBadge } from "../atoms/StatusBadge.tsx";
import { ArtboardShell } from "./ArtboardShell.tsx";
import {
  workerListFixtures,
  type WorkerListState,
} from "../fixtures/worker-readiness.ts";
import "./worker-catalog.css";
export type WorkerCatalogProps = {
  /** Static presentation selection; never an operational worker record. */
  state: WorkerListState;
  t: Translator;
  /** Removes the nested main landmark when embedded in the product shell. */
  embedded?: boolean;
};
type ListLabel = Extract<MessageKey, `workerList.${string}`> extends
  `workerList.${infer Key}` ? Key : never;
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
/** Inert source-shaped list. No navigation, detail, eligibility, or operation handlers. */
export function WorkerCatalog(
  { state, t, embedded = false }: WorkerCatalogProps,
) {
  const titleId = useId();
  const fixture = workerListFixtures[state];
  const label = (key: ListLabel) => t(`workerList.${key}`);
  const shellLabel = (key: ShellLabel) => t(`workerEnrollment.${key}`);
  return (
    <div
      className="ui-worker-catalog"
      data-ui-component="workerCatalog"
      data-variant="list"
      data-state={state}
      data-source={fixture.source}
      data-fixture-id={fixture.id}
    >
      <ArtboardShell
        mainRole={embedded ? "presentation" : "main"}
        applicationRail={
          <div className="ui-worker-catalog__rail">
            <div className="ui-worker-catalog__brand">
              <LogoMark variant="rail" aria-hidden="true" />
              {shellLabel("brand")}
            </div>
            <div className="ui-worker-catalog__workspace">
              {shellLabel("workspace")}
              <IconGlyph name="chevron-down" size="small" />
            </div>
            {/* Source navigation is context only. No dead links or pretend navigation controls. */}
            <ul
              className="ui-worker-catalog__navigation"
              aria-label={shellLabel("navigation")}
            >
              {navigation.map(([name, glyph]) => (
                <li key={name} data-selected={name === "machines" || undefined}>
                  <IconGlyph name={glyph} />
                  {shellLabel(`nav.${name}`)}
                </li>
              ))}
            </ul>
            <Text variant="caption">{shellLabel("recent")}</Text>
            <ul className="ui-worker-catalog__navigation">
              {(["repository", "activity", "notifications"] as const).map((
                name,
              ) => (
                <li key={name}>
                  <IconGlyph name="terminal" size="small" />
                  {shellLabel(`nav.${name}`)}
                </li>
              ))}
            </ul>
            <div className="ui-worker-catalog__identity">
              <span aria-hidden="true">
                {shellLabel("person").split(/\s+/).map((part) => part[0]).slice(
                  0,
                  2,
                )
                  .join("")}
              </span>
              <Text variant="hint">{shellLabel("person")}</Text>
              <IconGlyph name="chevron-down" size="small" />
            </div>
            <Text variant="caption">{shellLabel("provenance")}</Text>
          </div>
        }
        header={
          <div className="ui-worker-catalog__header">
            <div
              className="ui-worker-catalog__phone-status"
              aria-hidden="true"
            >
              <span>9:41</span>
              <span>
                <IconGlyph name="phone-status" />
              </span>
            </div>
            <div className="ui-worker-catalog__desktop-header">
              <Text variant="hint">{shellLabel("workspaceLabel")}</Text>
              <span aria-hidden="true">/</span>
              <Text variant="hint">{label("title")}</Text>
              <span className="ui-worker-catalog__search" aria-hidden="true">
                <IconGlyph name="search" />
                <kbd>⌘ K</kbd>
              </span>
            </div>
            <div className="ui-worker-catalog__mobile-header">
              <IconGlyph name="menu" />
              <strong>{shellLabel("brand")}</strong>
              <Text variant="hint">{shellLabel("workspace")}⌄</Text>
            </div>
          </div>
        }
      >
        <section
          aria-labelledby={titleId}
          aria-description={label("disclaimer")}
        >
          {/* One focusable live region, without adding copy absent from positive sources. */}
          <div
            role="status"
            tabIndex={0}
            className="ui-worker-catalog__content"
            aria-label={label(`state.${state}`)}
            aria-busy={state === "loading" || undefined}
          >
            <div className="ui-worker-catalog__intro">
              <Text variant="hint">{label("breadcrumb")}</Text>
              <div className="ui-worker-catalog__title-row">
                <div className="ui-worker-catalog__title">
                  <Heading id={titleId} level="page-plain">
                    {label("title")}
                  </Heading>
                  <Text variant="muted">{label("subtitle")}</Text>
                </div>
                <Button variant="preview-primary" density="standard">
                  {label("connect")}
                </Button>
              </div>
            </div>
            <div className="ui-worker-catalog__filters">
              <div className="ui-worker-catalog__search-preview">
                <IconGlyph name="list-search" />
                <Text variant="field-preview">{label("search")}</Text>
              </div>
              <Button variant="preview-secondary" density="standard">
                {label("filter")}
              </Button>
            </div>
            {state !== "ready" && (
              <div className="ui-worker-catalog__status">
                {label(`state.${state}`)}
              </div>
            )}
            {fixture.rows.length > 0 && (
              <>
                <ul
                  className="ui-worker-catalog__rows"
                  aria-label={label("title")}
                >
                  {fixture.rows.map((row) => (
                    <li key={row.id}>
                      <div className="ui-worker-catalog__machine">
                        <IconGlyph
                          name={row.id === "mac" ? "laptop" : "server"}
                          width={22}
                          height={22}
                        />
                        <div>
                          <Heading level="subsection-compact" rank={2}>
                            {label(`${row.id}.name`)}
                          </Heading>
                          <Text variant="hint">
                            {label(`${row.id}.platform`)}
                          </Text>
                        </div>
                      </div>
                      <div className="ui-worker-catalog__facts">
                        <StatusBadge
                          status={row.online
                            ? "online-preview"
                            : "offline-preview"}
                        >
                          {label(row.online ? "online" : "offline")}
                        </StatusBadge>
                        <Text variant="responsive-hint">
                          {label(`${row.id}.capacity`)}
                        </Text>
                      </div>
                      <div
                        className="ui-worker-catalog__updates"
                        data-current={row.id === "mac" || undefined}
                      >
                        <span>{label(`${row.id}.update`)}</span>
                        <span className="ui-worker-catalog__view">
                          <span>{label("view")}</span> →
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="ui-worker-catalog__summary">
                  <Text variant="hint">{label("summary")}</Text>
                  <Text variant="hint">{label("checked")}</Text>
                </div>
              </>
            )}
            <div className="ui-worker-catalog__ownership">
              <Heading level="subsection-compact" rank={2}>
                {label("ownership")}
              </Heading>
              <Text variant="muted">{label("ownershipHint")}</Text>
            </div>
            <div className="ui-worker-catalog__footer">
              <Text variant="caption">{label("provenance")}</Text>
            </div>
          </div>
        </section>
      </ArtboardShell>
    </div>
  );
}
