import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import * as UI from "@bakery/ui";
import type { Translator } from "@bakery/i18n";
import { stepTitle } from "../task-timeline.ts";
import {
  agentName,
  choiceSummary,
  choosable,
  chooserIntro,
  continueLabel,
  costLine,
  type Offer,
  paymentLabel,
  paymentNotice,
  paymentShort,
  providerEntries,
  type ProviderEntry,
  searchTargets,
  stateLabel,
  SUGGESTED,
  type Target,
  targetsOf,
  unavailableLines,
  unavailableSummary,
} from "./model.ts";

/** How many models a provider shows before "Show all". */
const FIRST_ROWS = 8;

/**
 * The chooser under a waiting card (#70, slice 2, UX revision 3): providers on
 * the left (Suggested first), that provider's models in a table on the right,
 * a search across every provider, the routes that cannot be used as counts,
 * and an end bar that names the choice before it is made. On a phone it is a
 * full-height sheet in two steps: providers, then a provider's models.
 *
 * Nothing is chosen when it opens; Continue waits for a choice, and the parent
 * sends it once against this exact offer.
 */
export function Chooser(
  { offer, phone, working, problem, onKeep, onContinue, t, money }: {
    readonly offer: Offer;
    /** True on a phone: a sheet in two steps instead of the in-page chooser. */
    readonly phone: boolean;
    readonly working: boolean;
    /** The sentence for a refused choice, or null. */
    readonly problem: string | null;
    readonly onKeep: () => void;
    readonly onContinue: (target: Target) => void;
    readonly t: Translator;
    readonly money: (value: number) => string;
  },
) {
  const entries = providerEntries(offer, t("tasks.waiting.chooser.suggested"));
  const [provider, setProvider] = useState(entries[0]?.key ?? "");
  const [chosen, setChosen] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [phoneStep, setPhoneStep] = useState<"providers" | "models">(
    "providers",
  );
  const searchId = useId();
  const focusSearch = () => document.getElementById(searchId)?.focus();
  const providersRef = useRef<HTMLDivElement>(null);

  const picked = offer.targets.find((one) => one.routeId === chosen) ?? null;
  const searching = search.trim() !== "";
  const found = searchTargets(offer.targets, search);
  const listed = searching ? found.matches : targetsOf(offer, provider);
  const rows = showAll ? listed : listed.slice(0, FIRST_ROWS);
  const entry = entries.find((one) => one.key === provider) ?? null;
  const label = t("tasks.waiting.chooser.label", {
    step: stepTitle(t, offer.stepKey),
  });
  const group = `route-waiting-choice-${offer.runStepId}`;

  // While the in-page chooser is open, Escape closes it and "/" puts the
  // cursor in search from anywhere on the page (the sheet has its own Escape
  // and contains focus, so its keys stay on it).
  useEffect(() => {
    if (phone) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const editing = target instanceof HTMLElement &&
        (target.isContentEditable || target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLInputElement && target.type !== "radio" &&
            target.type !== "checkbox"));
      if (event.key === "Escape" && !working) {
        event.preventDefault();
        onKeep();
      } else if (event.key === "/" && !editing) {
        event.preventDefault();
        focusSearch();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const pickProvider = (key: string) => {
    setProvider(key);
    setShowAll(false);
    if (phone) setPhoneStep("models");
  };

  // In the sheet "/" puts the cursor in search; everywhere Up and Down move in
  // the provider list.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const inField = event.target instanceof HTMLInputElement &&
      event.target.type !== "radio";
    if (event.key === "/" && !inField && phone) {
      event.preventDefault();
      focusSearch();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [
      ...providersRef.current?.querySelectorAll<HTMLButtonElement>(
        "button",
      ) ?? [],
    ];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next = buttons[at + (event.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
  };

  const searchField = (
    <UI.Field htmlFor={searchId} label={t("tasks.waiting.chooser.search")}>
      <UI.SearchField
        id={searchId}
        data-testid="route-waiting-search"
        disabled={working}
        message={searching
          ? found.matches.length === 0 ? null : t(
            "tasks.waiting.chooser.searchResults",
            {
              count: found.matches.length,
              text: search.trim(),
              providers: found.providers,
            },
          )
          : null}
        onChange={(event) => {
          setSearch(event.currentTarget.value);
          setShowAll(false);
        }}
        state={searching ? "results" : "empty"}
        value={search}
      />
    </UI.Field>
  );

  const providerList = (
    <div ref={providersRef} data-testid="route-waiting-providers">
      <UI.DataTable<ProviderEntry>
        caption={t("tasks.waiting.chooser.providers")}
        captionHidden
        columns={[{
          id: "name",
          header: t("tasks.waiting.chooser.providers"),
          cell: (row) => (
            <UI.Inline gap="compact">
              {row.key === SUGGESTED
                ? null
                : <UI.ProviderMark name={row.name} provider={row.key} />}
              <UI.Stack gap="none">
                <UI.Text>{row.name}</UI.Text>
                <UI.Text variant="hint">
                  {t("tasks.waiting.chooser.providerCount", {
                    count: row.count,
                  })}
                </UI.Text>
              </UI.Stack>
            </UI.Inline>
          ),
        }]}
        getRowAttributes={(row) => ({ "data-provider": row.key })}
        getRowKey={(row) =>
          row.key}
        headingsHidden
        onSelectRow={(row) =>
          pickProvider(row.key)}
        rows={entries}
        selectedRowKey={phone ? null : provider}
        variant="ruled"
      />
    </div>
  );

  const models: ReactNode = searching && found.matches.length === 0
    ? (
      <UI.Stack gap="tight" data-testid="route-waiting-search-none">
        <UI.Text>
          {t("tasks.waiting.chooser.searchNone", { text: search.trim() })}
        </UI.Text>
        <UI.Inline gap="compact">
          <UI.Button
            variant="secondary"
            onClick={() => {
              setSearch("");
              focusSearch();
            }}
          >
            {t("tasks.waiting.chooser.clearSearch")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    )
    : (
      <UI.Stack gap="tight" data-testid="route-waiting-models">
        <UI.DataTable<Target>
          caption={searching
            ? t("tasks.waiting.chooser.search")
            : t("tasks.waiting.chooser.models", {
              provider: entry?.name ?? "",
            })}
          captionHidden
          columns={[
            {
              id: "model",
              header: t("tasks.waiting.chooser.column.model"),
              cell: (row) => (
                <UI.Radio
                  checked={chosen === row.routeId}
                  disabled={working || !choosable(row)}
                  name={group}
                  onChange={() => setChosen(row.routeId)}
                  onKeyDown={(event) => {
                    // Enter on a model chooses it, as Space does.
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (!working && choosable(row)) setChosen(row.routeId);
                  }}
                  value={row.routeId}
                >
                  <UI.Text truncate title={row.modelName}>
                    {row.modelName}
                  </UI.Text>
                </UI.Radio>
              ),
            },
            ...(searching
              ? [{
                id: "provider",
                header: t("tasks.waiting.chooser.column.provider"),
                width: "26%",
                cell: (row: Target) => (
                  <UI.Inline gap="compact">
                    <UI.ProviderMark
                      name={row.providerName}
                      provider={row.provider}
                    />
                    <UI.Text>{row.providerName}</UI.Text>
                  </UI.Inline>
                ),
              }]
              : []),
            {
              id: "payment",
              header: t("tasks.waiting.chooser.column.payment"),
              width: searching ? "16%" : "30%",
              cell: (row) => (
                <UI.Text variant={choosable(row) ? undefined : "muted"}>
                  {searching
                    ? paymentShort(t, row.billingRoute)
                    : paymentLabel(t, row.billingRoute)}
                </UI.Text>
              ),
            },
            {
              id: "state",
              header: t("tasks.waiting.chooser.column.state"),
              width: "28%",
              cell: (row) => {
                const state = stateLabel(t, row);
                return <UI.Badge tone={state.tone}>{state.text}</UI.Badge>;
              },
            },
          ]}
          getRowAttributes={(row) => ({
            "data-route-id": row.routeId,
            "data-selected": String(chosen === row.routeId),
          })}
          getRowKey={(row) => row.routeId}
          rows={rows}
          variant="ruled"
        />
        {listed.length > rows.length
          ? (
            <UI.Inline gap="compact">
              <UI.Button variant="secondary" onClick={() => setShowAll(true)}>
                {t("tasks.waiting.chooser.showAll", { count: listed.length })}
              </UI.Button>
            </UI.Inline>
          )
          : null}
      </UI.Stack>
    );

  const summary = unavailableSummary(t, offer);
  const cannot = summary === null
    ? null
    : (
      <UI.Disclosure summary={summary} data-testid="route-waiting-unavailable">
        <UI.Stack gap="tight" role="list">
          {unavailableLines(t, offer).map((line) => (
            <UI.Stack gap="none" key={line.reason} role="listitem">
              <UI.Text variant="muted">{line.text}</UI.Text>
              {line.more === undefined ? null : (
                <UI.Disclosure
                  data-testid="route-waiting-turned-off"
                  summary={line.more.label}
                >
                  <UI.Text variant="muted">{line.more.names}</UI.Text>
                </UI.Disclosure>
              )}
            </UI.Stack>
          ))}
        </UI.Stack>
      </UI.Disclosure>
    );

  const notice = picked === null
    ? null
    : paymentNotice(t, offer.source, picked);
  const keep = (
    <UI.Button
      key="keep"
      variant="secondary"
      disabled={working}
      onClick={onKeep}
    >
      {t("tasks.waiting.chooser.keep")}
    </UI.Button>
  );
  const go = (
    <UI.Button
      key="go"
      data-testid="route-waiting-continue"
      variant="primary"
      disabled={picked === null || working}
      loading={working}
      onClick={() => {
        if (picked !== null) onContinue(picked);
      }}
    >
      {continueLabel(t, picked)}
    </UI.Button>
  );
  const endBar = (
    <UI.Stack gap="tight" data-testid="route-waiting-end">
      <UI.Text data-testid="route-waiting-summary">
        {picked === null
          ? t("tasks.waiting.chooser.nothingChosen")
          : choiceSummary(t, picked)}
      </UI.Text>
      {notice === null ? null : (
        <UI.InlineNotice
          tone="information"
          data-testid="route-waiting-payment"
        >
          {notice}
        </UI.InlineNotice>
      )}
      <UI.Text variant="hint">{costLine(t, picked, money)}</UI.Text>
      {problem === null
        ? null
        : (
          <UI.InlineNotice tone="error" data-testid="route-waiting-problem">
            {problem}
          </UI.InlineNotice>
        )}
      {phone
        ? (
          // A phone stacks the buttons full width, Continue first, so a long
          // model name keeps its line.
          <UI.Stack gap="tight" data-testid="route-waiting-actions">
            {[go, keep]}
          </UI.Stack>
        )
        : <UI.Inline variant="end">{[keep, go]}</UI.Inline>}
    </UI.Stack>
  );

  const intro = (
    <UI.Inline gap="compact" data-testid="route-waiting-intro">
      <UI.ProviderMark
        name={agentName(t, offer.source.harness)}
        provider={offer.source.harness}
      />
      <UI.Text>{chooserIntro(t, offer)}</UI.Text>
    </UI.Inline>
  );

  if (phone) {
    return (
      <UI.Sheet
        data-testid="route-waiting-chooser"
        dismissLabel={t("tasks.waiting.chooser.close")}
        onKeyDown={onKeyDown}
        onOpenChange={(open) => {
          if (!open && !working) onKeep();
        }}
        open
        state={working ? "submitting" : problem === null ? "open" : "error"}
        title={label}
        variant="side"
      >
        <UI.Stack gap="standard">
          {phoneStep === "providers"
            ? (
              <>
                {intro}
                {searchField}
                {searching ? models : providerList}
                {cannot}
              </>
            )
            : (
              <>
                <UI.Inline gap="compact">
                  <UI.Button
                    variant="quiet"
                    onClick={() => setPhoneStep("providers")}
                  >
                    {t("tasks.waiting.chooser.backToProviders")}
                  </UI.Button>
                </UI.Inline>
                <UI.Heading level="subsection">{entry?.name ?? ""}</UI.Heading>
                {models}
              </>
            )}
          {endBar}
        </UI.Stack>
      </UI.Sheet>
    );
  }

  return (
    <section
      aria-label={label}
      data-testid="route-waiting-chooser"
      onKeyDown={onKeyDown}
    >
      <UI.Stack gap="standard">
        {intro}
        {searchField}
        <UI.Inline variant="aside">
          {providerList}
          {models}
        </UI.Inline>
        {cannot}
        {endBar}
      </UI.Stack>
    </section>
  );
}
