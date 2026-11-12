import type { MessageKey } from "@bakery/i18n";
import type { RuleEntry, RuleKey } from "./presentation.ts";

/**
 * How each rule's options are edited. Every bound here is the contract's own
 * (list lengths, number ranges, string lengths); the server re-checks the
 * whole entry when the draft is previewed and published, so nothing here is
 * a policy of the page's own.
 */
export type OptionField =
  | {
    readonly id: string;
    readonly kind: "list";
    readonly min: number;
    readonly max: number;
    readonly itemMax: number;
  }
  | { readonly id: string; readonly kind: "numbers"; readonly max: number }
  | {
    readonly id: string;
    readonly kind: "integer";
    readonly min: number;
    readonly max: number;
  }
  | {
    readonly id: string;
    readonly kind: "choice";
    readonly values: readonly string[];
  }
  | {
    readonly id: string;
    readonly kind: "text";
    readonly max: number;
    readonly multiline: boolean;
    /** The key is left out of the entry when the field is empty. */
    readonly optional: boolean;
  }
  | { readonly id: string; readonly kind: "binding"; readonly max: number };

const TYPES: OptionField = {
  id: "types",
  kind: "list",
  min: 1,
  max: 32,
  itemMax: 32,
};
const SCOPE: OptionField = {
  id: "scope",
  kind: "choice",
  values: ["optional", "required"],
};
const SUBJECT: OptionField = {
  id: "maxSubjectLength",
  kind: "integer",
  min: 20,
  max: 200,
};
const EXCLUDED: OptionField = {
  id: "excludedPaths",
  kind: "list",
  min: 0,
  max: 32,
  itemMax: 200,
};
const BINDING: OptionField = { id: "checkBinding", kind: "binding", max: 100 };

export const OPTION_FIELDS: Readonly<Record<RuleKey, readonly OptionField[]>> =
  {
    "commits.semantic": [
      TYPES,
      SCOPE,
      SUBJECT,
      {
        id: "range",
        kind: "choice",
        values: ["all_commits", "final_squash_commit"],
      },
      {
        id: "mergeAndRevertCommits",
        kind: "choice",
        values: ["validate", "exempt"],
      },
    ],
    "changeRequest.semanticTitle": [TYPES, SCOPE, SUBJECT],
    "changeRequest.description": [
      {
        id: "template",
        kind: "text",
        max: 8000,
        multiline: true,
        optional: false,
      },
      { id: "requiredSections", kind: "list", min: 0, max: 16, itemMax: 100 },
      {
        id: "writingGuidance",
        kind: "text",
        max: 2000,
        multiline: true,
        optional: true,
      },
    ],
    "code.magicNumbers": [
      BINDING,
      { id: "allowedNumbers", kind: "numbers", max: 32 },
      EXCLUDED,
    ],
    "code.magicStrings": [
      BINDING,
      { id: "allowedLiterals", kind: "list", min: 0, max: 32, itemMax: 200 },
      EXCLUDED,
    ],
  };

/** What a field shows: its text value as the form holds it. */
export type OptionForm = Readonly<Record<string, string>>;

export type FieldError = {
  readonly key: MessageKey;
  readonly values?: Readonly<Record<string, string | number>>;
};

type Options = Record<string, unknown>;

/** A rule's options as form text. */
export function toForm(entry: RuleEntry): OptionForm {
  const options = entry.options as unknown as Options;
  const form: Record<string, string> = {};
  for (const field of OPTION_FIELDS[entry.ruleKey]) {
    const value = options[field.id];
    form[field.id] = Array.isArray(value)
      ? value.join(", ")
      : value === null || value === undefined
      ? ""
      : String(value);
  }
  return form;
}

function items(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter((item) =>
    item.length > 0
  );
}

/**
 * Form text back into options, or the error each field earns. Only the
 * contract's own bounds are checked here.
 */
export function fromForm(
  ruleKey: RuleKey,
  form: OptionForm,
): { options: Options } | { errors: Record<string, FieldError> } {
  const options: Options = {};
  const errors: Record<string, FieldError> = {};
  for (const field of OPTION_FIELDS[ruleKey]) {
    const text = form[field.id] ?? "";
    switch (field.kind) {
      case "list": {
        const list = items(text);
        if (list.length < field.min) {
          errors[field.id] = {
            key: "settings.repositoryRules.editor.error.listMin",
          };
        } else if (list.length > field.max) {
          errors[field.id] = {
            key: "settings.repositoryRules.editor.error.listMax",
            values: { max: field.max },
          };
        } else if (list.some((item) => item.length > field.itemMax)) {
          errors[field.id] = {
            key: "settings.repositoryRules.editor.error.itemLength",
            values: { max: field.itemMax },
          };
        } else options[field.id] = list;
        break;
      }
      case "numbers": {
        const list = items(text);
        const numbers = list.map(Number);
        if (numbers.some((value) => !Number.isFinite(value))) {
          errors[field.id] = {
            key: "settings.repositoryRules.editor.error.number",
          };
        } else if (numbers.length > field.max) {
          errors[field.id] = {
            key: "settings.repositoryRules.editor.error.listMax",
            values: { max: field.max },
          };
        } else options[field.id] = numbers;
        break;
      }
      case "integer": {
        const value = Number(text.trim());
        if (
          !/^-?\d+$/.test(text.trim()) || value < field.min || value > field.max
        ) {
          errors[field.id] = {
            key: "settings.repositoryRules.editor.error.integer",
            values: { min: field.min, max: field.max },
          };
        } else options[field.id] = value;
        break;
      }
      case "choice":
        options[field.id] = text;
        break;
      case "text": {
        if (text.length > field.max) {
          errors[field.id] = {
            key: "settings.repositoryRules.editor.error.textMax",
            values: { max: field.max },
          };
        } else if (text.length === 0 && field.optional) {
          // Left out, as the contract allows.
        } else options[field.id] = text;
        break;
      }
      case "binding": {
        const value = text.trim();
        if (value.length > field.max) {
          errors[field.id] = {
            key: "settings.repositoryRules.editor.error.textMax",
            values: { max: field.max },
          };
        } else options[field.id] = value.length === 0 ? null : value;
        break;
      }
    }
  }
  return Object.keys(errors).length > 0 ? { errors } : { options };
}

/**
 * The entry "Add rule" starts the editor from. The server has no defaults
 * ("an organization with no rows has no defaults"), so these are only the
 * first value of each choice and empty lists: required lists stay empty until
 * the administrator fills them in, and the editor will not apply without them.
 */
export function blankEntry(ruleKey: RuleKey): RuleEntry {
  const base = { ruleKey, enabled: true, mode: "guide", locked: false };
  const options: Record<RuleKey, Options> = {
    "commits.semantic": {
      types: [],
      scope: "optional",
      maxSubjectLength: 72,
      range: "all_commits",
      mergeAndRevertCommits: "validate",
    },
    "changeRequest.semanticTitle": {
      types: [],
      scope: "optional",
      maxSubjectLength: 72,
    },
    "changeRequest.description": { template: "", requiredSections: [] },
    "code.magicNumbers": {
      checkBinding: null,
      allowedNumbers: [],
      excludedPaths: [],
    },
    "code.magicStrings": {
      checkBinding: null,
      allowedLiterals: [],
      excludedPaths: [],
    },
  };
  return { ...base, options: options[ruleKey] } as unknown as RuleEntry;
}
