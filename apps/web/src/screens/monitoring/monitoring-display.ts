import type {
  TelemetryDestination,
  TelemetryDestinationDetail,
  TelemetryDestinationList,
} from "../../api/client.ts";

/** One setting of a destination kind, as the server describes it. */
export type KindField = {
  readonly name: string;
  readonly label: string;
  readonly help: string;
  readonly secret: boolean;
  readonly required: boolean;
};

/** A kind of destination the server offers, and the measurements it can take. */
export type DestinationKind = {
  readonly kind: string;
  readonly label: string;
  readonly fields: readonly KindField[];
  readonly measurements: readonly string[];
  readonly unavailableReasons: Readonly<Record<string, string>>;
};

/** One of the six kinds of measurement, with its label and help. */
export type MeasurementInfo = {
  readonly kind: string;
  readonly label: string;
  readonly help: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * The kinds the server lists. The list is typed as plain JSON on the wire, so
 * each entry is read defensively: a kind that is not shaped as described is
 * left out, never half drawn. The form is built from this, so a new kind on
 * the server needs no change here.
 */
export function kindOf(entry: unknown): DestinationKind | null {
  if (!isRecord(entry) || text(entry.kind) === "") return null;
  const fields = Array.isArray(entry.fields)
    ? entry.fields.flatMap((field): KindField[] =>
      isRecord(field) && text(field.name) !== ""
        ? [{
          name: text(field.name),
          label: text(field.label),
          help: text(field.help),
          secret: field.secret === true,
          required: field.required === true,
        }]
        : []
    )
    : [];
  const reasons = isRecord(entry.unavailableReasons)
    ? Object.fromEntries(
      Object.entries(entry.unavailableReasons).filter((pair): pair is [
        string,
        string,
      ] => typeof pair[1] === "string"),
    )
    : {};
  return {
    kind: text(entry.kind),
    label: text(entry.label),
    fields,
    measurements: Array.isArray(entry.measurements)
      ? entry.measurements.filter((item): item is string =>
        typeof item === "string"
      )
      : [],
    unavailableReasons: reasons,
  };
}

export function kindsOf(list: TelemetryDestinationList): DestinationKind[] {
  return list.kinds.flatMap((entry) => {
    const kind = kindOf(entry);
    return kind === null ? [] : [kind];
  });
}

/** A provider a destination can be added for, as the server lists it. */
export type ProviderInfo = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** The kind of destination it delivers through. */
  readonly kind: string;
  /** Values the form starts with, by the kind's field name. */
  readonly prefill: Readonly<Record<string, string>>;
};

export function providerOf(entry: unknown): ProviderInfo | null {
  if (!isRecord(entry) || text(entry.key) === "" || text(entry.name) === "") {
    return null;
  }
  return {
    key: text(entry.key),
    name: text(entry.name),
    description: text(entry.description),
    kind: text(entry.kind),
    prefill: isRecord(entry.prefill)
      ? Object.fromEntries(
        Object.entries(entry.prefill).filter((pair): pair is [string, string] =>
          typeof pair[1] === "string"
        ),
      )
      : {},
  };
}

/** The providers the server lists, in its order. */
export function providersOf(list: TelemetryDestinationList): ProviderInfo[] {
  return list.providers.flatMap((entry) => {
    const provider = providerOf(entry);
    return provider === null ? [] : [provider];
  });
}

/**
 * The provider a destination shows: the one saved with it, else the first the
 * server lists for its kind (what the server reads a null as), else a stand-in
 * named after the kind, so a mark is never guessed from a name or an address.
 */
export function providerForDestination(
  destination: Pick<TelemetryDestination, "kind"> & { provider?: unknown },
  providers: readonly ProviderInfo[],
  kindLabel: (kind: string) => string,
): { readonly key: string; readonly name: string } {
  const saved = typeof destination.provider === "string"
    ? providers.find((entry) => entry.key === destination.provider)
    : undefined;
  const fallback = saved ??
    providers.find((entry) => entry.kind === destination.kind);
  return fallback === undefined
    ? { key: destination.kind, name: kindLabel(destination.kind) }
    : { key: fallback.key, name: fallback.name };
}

/** How many destinations are in each state, with no search or filter applied. */
export type StateCounts = Readonly<Record<StateFilter, number>>;

export function stateCountsOf(list: TelemetryDestinationList): StateCounts {
  const raw = isRecord(list.stateCounts) ? list.stateCounts : {};
  const count = (key: string) => typeof raw[key] === "number" ? raw[key] : 0;
  return {
    all: count("all"),
    working: count("working"),
    not_tested_yet: count("not_tested_yet"),
    failing: count("failing"),
    dropping_data: count("dropping_data"),
    off: count("off"),
  };
}

/** One destination's page: the destination, its kind, its provider and the measurements. */
export function detailOf(detail: TelemetryDestinationDetail): {
  readonly destination: TelemetryDestination | null;
  readonly kind: DestinationKind | null;
  readonly provider: ProviderInfo | null;
  readonly measurements: MeasurementInfo[];
} {
  const [destination] = destinationsOf({
    destinations: [detail.destination],
  } as unknown as TelemetryDestinationList);
  return {
    destination: destination ?? null,
    kind: kindOf(detail.kind),
    provider: providerOf(detail.provider),
    measurements: measurementsOf({
      measurements: detail.measurements,
    } as unknown as TelemetryDestinationList),
  };
}

const STATES = new Set([
  "working",
  "not_tested_yet",
  "failing",
  "dropping_data",
  "off",
]);

/**
 * The destinations the server lists. The list types them as plain JSON, so
 * each is checked for the fields the page reads before it is used as a
 * destination; one that is not shaped as described is left out.
 */
export function destinationsOf(
  list: TelemetryDestinationList,
): TelemetryDestination[] {
  return list.destinations.filter((entry): entry is TelemetryDestination =>
    isRecord(entry) && text(entry.id) !== "" && text(entry.name) !== "" &&
    text(entry.kind) !== "" && STATES.has(text(entry.state)) &&
    typeof entry.version === "number" && typeof entry.enabled === "boolean" &&
    Array.isArray(entry.measurements) &&
    Array.isArray(entry.secretFieldsSet) && typeof entry.dropped === "number"
  );
}

/** The measurements the server lists, in its order. */
export function measurementsOf(
  list: TelemetryDestinationList,
): MeasurementInfo[] {
  return list.measurements.flatMap((entry): MeasurementInfo[] =>
    isRecord(entry) && text(entry.kind) !== ""
      ? [{
        kind: text(entry.kind),
        label: text(entry.label),
        help: text(entry.help),
      }]
      : []
  );
}

/** The badge a state shows, and how it reads. */
export type StateWords = {
  readonly key:
    | "installation.monitoring.state.working"
    | "installation.monitoring.state.notSent"
    | "installation.monitoring.state.failing"
    | "installation.monitoring.state.dropping"
    | "installation.monitoring.state.off";
  readonly tone: "success" | "neutral" | "danger" | "warning";
};

export function stateWords(state: TelemetryDestination["state"]): StateWords {
  switch (state) {
    case "working":
      return { key: "installation.monitoring.state.working", tone: "success" };
    case "not_tested_yet":
      return { key: "installation.monitoring.state.notSent", tone: "neutral" };
    case "failing":
      return { key: "installation.monitoring.state.failing", tone: "danger" };
    case "dropping_data":
      return { key: "installation.monitoring.state.dropping", tone: "warning" };
    case "off":
      return { key: "installation.monitoring.state.off", tone: "neutral" };
  }
}

/** The destinations that are failing, worst first by how long since they last worked. */
export function failingOf(
  destinations: readonly TelemetryDestination[],
): TelemetryDestination[] {
  return destinations.filter((destination) => destination.state === "failing");
}

/** What the Admin has typed for one destination. */
export type DestinationDraft = {
  readonly name: string;
  readonly measurements: readonly string[];
  /** One string per field; a saved secret is empty until replaced. */
  readonly values: Readonly<Record<string, string>>;
  /** Secret fields the Admin chose to replace or remove. */
  readonly touchedSecrets: readonly string[];
};

/** A blank draft for a kind: the provider's values filled in, the kind's measurements ticked. */
export function blankDraft(
  kind: DestinationKind,
  measurements: readonly MeasurementInfo[],
  prefill: Readonly<Record<string, string>> = {},
): DestinationDraft {
  return {
    name: "",
    measurements: measurements
      .filter((info) => kind.measurements.includes(info.kind))
      .map((info) => info.kind),
    values: Object.fromEntries(
      kind.fields.map((field) => [field.name, prefill[field.name] ?? ""]),
    ),
    touchedSecrets: [],
  };
}

/** The draft that shows a saved destination: settings filled, secrets empty. */
export function draftOfDestination(
  destination: TelemetryDestination,
  kind: DestinationKind,
): DestinationDraft {
  const settings = isRecord(destination.settings) ? destination.settings : {};
  return {
    name: destination.name,
    measurements: [...destination.measurements],
    values: Object.fromEntries(
      kind.fields.map((
        field,
      ) => [field.name, field.secret ? "" : text(settings[field.name])]),
    ),
    touchedSecrets: [],
  };
}

/** Whether a saved secret field still holds its stored value in this draft. */
export function secretIsSaved(
  destination: TelemetryDestination | null,
  field: KindField,
  draft: DestinationDraft,
): boolean {
  return destination !== null && field.secret &&
    destination.secretFieldsSet.includes(field.name) &&
    !draft.touchedSecrets.includes(field.name);
}

/**
 * The fields a saved secret is bound to. The server refuses a save or a test
 * that moves a saved secret to a new address, so when one of these changes the
 * secret has to be typed again. `secretBoundFields` is not in the kind
 * descriptor yet, so the fields that are not secret and that the form
 * collects are the ones treated as bound (Address and Sign-in header name).
 */
export function reenterNeeded(
  destination: TelemetryDestination | null,
  kind: DestinationKind,
  draft: DestinationDraft,
): boolean {
  if (destination === null || destination.secretFieldsSet.length === 0) {
    return false;
  }
  const saved = isRecord(destination.settings) ? destination.settings : {};
  return kind.fields.some((field) =>
    !field.secret && draft.values[field.name] !== text(saved[field.name])
  );
}

/** The values to send on a save: all of them for a new destination, only the changed ones for a saved one. */
export function valuesToSend(
  destination: TelemetryDestination | null,
  kind: DestinationKind,
  draft: DestinationDraft,
): Record<string, string> {
  if (destination === null) {
    return Object.fromEntries(
      kind.fields.map((field) => [field.name, draft.values[field.name] ?? ""]),
    );
  }
  const saved = isRecord(destination.settings) ? destination.settings : {};
  const sent: Record<string, string> = {};
  for (const field of kind.fields) {
    const value = draft.values[field.name] ?? "";
    if (field.secret) {
      if (draft.touchedSecrets.includes(field.name)) sent[field.name] = value;
    } else if (value !== text(saved[field.name])) sent[field.name] = value;
  }
  return sent;
}

/** The values to send with a test: the edited ones only for a saved destination. */
export function valuesToTest(
  destination: TelemetryDestination | null,
  kind: DestinationKind,
  draft: DestinationDraft,
): Record<string, string> {
  return valuesToSend(destination, kind, draft);
}

/** Why the form cannot be saved yet, as the first missing thing, or null. */
export type FormProblem = "name" | "measurements" | "required" | "reenter";

export function formProblem(
  destination: TelemetryDestination | null,
  kind: DestinationKind,
  draft: DestinationDraft,
): FormProblem | null {
  if (draft.name.trim() === "") return "name";
  if (draft.measurements.length === 0) return "measurements";
  const missing = kind.fields.some((field) =>
    field.required && !field.secret &&
    (draft.values[field.name] ?? "").trim() === ""
  );
  if (missing) return "required";
  if (
    reenterNeeded(destination, kind, draft) &&
    kind.fields.some((field) =>
      field.secret && destination?.secretFieldsSet.includes(field.name) &&
      !draft.touchedSecrets.includes(field.name)
    )
  ) return "reenter";
  return null;
}

/** An issue the server reported, mapped to the field it belongs to. */
export type FieldIssues = {
  readonly name?: string;
  readonly measurements?: string;
  readonly values: Readonly<Record<string, string>>;
};

/** Reads a 422's issues (paths like /values/address, /name) into messages by field. */
export function issuesByField(
  issues: readonly { readonly path: string; readonly message: string }[],
): FieldIssues {
  let name: string | undefined;
  let measurements: string | undefined;
  const values: Record<string, string> = {};
  for (const issue of issues) {
    const parts = issue.path.split("/").filter((part) => part !== "");
    if (parts[0] === "name") name ??= issue.message;
    else if (parts[0] === "measurements") measurements ??= issue.message;
    else if (parts[0] === "values" && parts[1] !== undefined) {
      values[parts[1]] ??= issue.message;
    }
  }
  return { name, measurements, values };
}

/** The measurements a kind cannot take, each with the server's reason. */
export function unavailableFor(
  kind: DestinationKind,
  measurement: MeasurementInfo,
): string | null {
  return kind.measurements.includes(measurement.kind)
    ? null
    : kind.unavailableReasons[measurement.kind] ?? "";
}

/** The choices of the State filter: every state, or one. */
export const STATE_FILTERS = [
  "all",
  "working",
  "not_tested_yet",
  "failing",
  "dropping_data",
  "off",
] as const;
export type StateFilter = typeof STATE_FILTERS[number];

export function isStateFilter(value: unknown): value is StateFilter {
  return typeof value === "string" &&
    (STATE_FILTERS as readonly string[]).includes(value);
}

/** What the list's toolbar narrows it to; all three live in the address and go to the server. */
export type DestinationFilters = {
  readonly q: string;
  readonly state: StateFilter;
  /** The provider key, or null for every provider. */
  readonly provider: string | null;
};
