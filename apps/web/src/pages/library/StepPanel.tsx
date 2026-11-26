import * as UI from "@bakery/ui";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ACTION_LINES } from "./workflow-state.ts";

import {
  ApprovalPanelBody,
  type ApprovalPanelProps,
} from "./ApprovalPanel.tsx";
import { StartPanelBody, type StartPanelProps } from "./StartPanel.tsx";

/**
 * The panel beside the diagram (#67, slice 1): what the person selected, and
 * the actions the design puts in the panel footer. Three things can be
 * selected, and each gets one treatment (design-ux's ruling, comment
 * 6917906748):
 *
 * - the start card, which says how a workflow starts and offers nothing;
 * - a part written in code (a group, or a step only changeable in code), which
 *   says so and offers "View as code" and no Move or Remove;
 * - a step, with its name as the step type's own name (the definition has no
 *   place to store a person's name yet) and move up, move down and remove.
 *
 * The reducer behind the actions is the same one the list editor used, so undo
 * and redo still decide what actually happens.
 */

/**
 * One skill a step names, as the reader may see it (#431, design-ux). Someone
 * else's private skill is a placeholder: its name, its owner and its version,
 * never a link, a file or a description.
 */
export type StepSkillRow = {
  readonly key: string;
  readonly name: string | null;
  readonly revision: number | null;
  readonly scope: "global" | "organization" | "personal" | null;
  readonly owner: string | null;
  /** The reader owns this private skill. */
  readonly mine: boolean;
  /** Whether the skill can be used at this step now, or why it cannot. */
  readonly status: "available" | "stopped" | "unavailable" | "missing";
  /** Where the row sits and which skill version it names (null for a slot with no skill at all). */
  readonly stepPath?: string;
  readonly versionId?: string | null;
  /** Takes the skill (or the placeholder for one) off the step; absent when the page cannot edit. */
  readonly onRemove?: () => void;
};

/** The place a chosen skill takes over from: a slot's step and the skill it named, if any. */
export type SlotReplaces = {
  readonly stepPath: string;
  readonly versionId: string | null;
};

/** One skill the picker offers: the active version people attach (#431). */
export type SkillChoice = {
  /** The skill's active version id: what the step names. */
  readonly value: string;
  readonly name: string;
  readonly slug: string;
  readonly revision: number;
  /** Your organization's skills come first; the caller's own private ones after. */
  readonly group: "organization" | "private";
};

/** What the picker shows: while it reads, when it failed, or the skills to choose from. */
export type StepAttach = {
  readonly state: "loading" | "failed" | "ready";
  readonly choices: readonly SkillChoice[];
  /** How many skills fit this step before the attached ones are taken out of the choices. */
  readonly offered: number;
  readonly onRetry: () => void;
  readonly onChoose: (value: string, replaces?: SlotReplaces) => void;
  readonly canChoose: (value: string) => boolean;
};

/** What the Skills list of a step shows: not at all, while it reads, when it failed, or the rows. */
export type StepSkills =
  | { readonly kind: "hidden" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly onRetry: () => void }
  | { readonly kind: "ready"; readonly rows: readonly StepSkillRow[] };

export type LoopValues = {
  readonly min: number | null;
  readonly max: number;
  readonly allow: number | null;
};

/** What the panel is showing. */
export type PanelTarget =
  | { readonly kind: "start"; readonly starts: StartPanelProps }
  | {
    readonly kind: "loop";
    readonly at: string;
    readonly name: string;
    readonly fix: boolean;
    readonly values: LoopValues;
    readonly cap: number;
    readonly help?: string | undefined;
    readonly onCommit: (values: LoopValues) => void;
    readonly onPending: (pending: boolean) => void;
  }
  | {
    readonly kind: "codeOnly";
    readonly name: string;
    /** The problem's sentence, shown above the code-only sentence. */
    readonly problem: string | undefined;
    readonly agentFromSetup?: boolean;
    /** The Skills section of an agent step written in code: a skill is not part of that code (#431). */
    readonly skills?: StepSkills;
    readonly attach?: StepAttach | null;
    /** What a "Fix until it passes" block does (#62). The limit is said once, on the block. */
    readonly help?: string;
  }
  | {
    readonly kind: "step";
    /** The card's name: the step type's own name, or "Unreadable step". */
    readonly name: string;
    /** Whether this page may delete the step, which is every editable page. */
    readonly deletable: boolean;
    readonly uses: string;
    /** What the definition states, when the step could not be drawn as an action. */
    readonly code: string | undefined;
    readonly problem: string | undefined;
    readonly agentFromSetup?: boolean;
    readonly approval?: ApprovalPanelProps | undefined;
    /** The skills the step names (#431). */
    readonly skills: StepSkills;
    /** The picker that attaches a skill; null when the page cannot edit. */
    readonly attach: StepAttach | null;
    readonly canMoveUp: boolean;
    readonly canMoveDown: boolean;
    readonly disabled: boolean;
    readonly onMoveUp: () => void;
    readonly onMoveDown: () => void;
    readonly onRemove: () => void;
  };

export function StepPanel(
  { target, onViewAsCode }: {
    readonly target: PanelTarget;
    readonly onViewAsCode: (() => void) | null;
  },
) {
  const { translate } = useI18n();
  const label = translate("library.editor.panel.label" as never);

  if (target.kind === "start") {
    return (
      <UI.InspectorPanel
        id="editor-step-panel"
        label={label}
        variant="column"
        header={
          <UI.Text variant="strong">
            {translate("library.editor.start.title")}
          </UI.Text>
        }
      >
        <StartPanelBody {...target.starts} />
      </UI.InspectorPanel>
    );
  }

  if (target.kind === "loop") {
    return (
      <LoopPanel
        key={target.at}
        onViewAsCode={onViewAsCode}
        target={target}
      />
    );
  }

  if (target.kind === "codeOnly") {
    return (
      <UI.InspectorPanel
        id="editor-step-panel"
        label={label}
        variant="column"
        header={<UI.Text variant="strong">{target.name}</UI.Text>}
        {...(onViewAsCode === null ? {} : {
          footer: (
            <UI.Button variant="secondary" onClick={onViewAsCode}>
              {translate("library.editor.viewAsCode" as never)}
            </UI.Button>
          ),
        })}
      >
        <UI.Stack gap="compact">
          {target.skills === undefined || target.skills.kind === "hidden"
            ? null
            : <Skills skills={target.skills} attach={target.attach ?? null} />}
          {target.problem === undefined
            ? null
            : (
              <UI.InlineNotice role="status" tone="error">
                {target.problem}
              </UI.InlineNotice>
            )}
          {target.help === undefined ? null : <UI.Text>{target.help}</UI.Text>}
          <UI.Text>
            {translate(
              (target.skills === undefined || target.skills.kind === "hidden"
                ? "library.editor.panel.codeOnly"
                : "library.editor.panel.codeOnlyRest") as never,
            )}
          </UI.Text>
          {target.agentFromSetup === true
            ? (
              <UI.Text variant="muted">
                {translate("library.editor.panel.agentFromSetup" as never)}
              </UI.Text>
            )
            : null}
        </UI.Stack>
      </UI.InspectorPanel>
    );
  }

  const lineKey = target.approval === undefined
    ? ACTION_LINES[target.uses]
    : "library.editor.ask.panelLine";
  const line = lineKey === undefined ? undefined : translate(lineKey as never);

  return (
    <UI.InspectorPanel
      id="editor-step-panel"
      label={label}
      variant="column"
      header={<UI.Text variant="strong">{target.name}</UI.Text>}
      footer={
        <UI.Inline gap="compact">
          <UI.Button
            variant="secondary"
            disabled={target.disabled || !target.canMoveUp}
            onClick={target.onMoveUp}
          >
            {translate("library.editor.panel.moveUp" as never)}
          </UI.Button>
          <UI.Button
            variant="secondary"
            disabled={target.disabled || !target.canMoveDown}
            onClick={target.onMoveDown}
          >
            {translate("library.editor.panel.moveDown" as never)}
          </UI.Button>
          <UI.Button
            variant="destructive"
            // A step Bakery cannot read is exactly the one a person must be
            // able to delete, so only a read-only page disables this button
            // (#67 UX ruling 6932934119 fix 6).
            disabled={!target.deletable}
            onClick={target.onRemove}
          >
            {translate("library.editor.panel.remove" as never)}
          </UI.Button>
        </UI.Inline>
      }
    >
      <UI.Stack gap="compact">
        {line === undefined ? null : <UI.Text>{line}</UI.Text>}
        {target.agentFromSetup === true
          ? (
            <UI.Text variant="muted">
              {translate("library.editor.panel.agentFromSetup" as never)}
            </UI.Text>
          )
          : null}
        {target.problem === undefined
          ? null
          : (
            <UI.InlineNotice role="status" tone="error">
              {target.problem}
            </UI.InlineNotice>
          )}
        {target.code === undefined ? null : (
          <UI.Text variant="caption">
            {translate("library.editor.card.writtenInCode" as never, {
              code: target.code,
            })}
          </UI.Text>
        )}
        {target.approval === undefined ? null : (
          <ApprovalPanelBody
            key={target.approval.stepId}
            {...target.approval}
          />
        )}
        {target.skills.kind === "hidden"
          ? null
          : <Skills attach={target.attach} skills={target.skills} />}
      </UI.Stack>
    </UI.InspectorPanel>
  );
}

type LoopField = "min" | "max" | "allow";

const wholeNumber = (text: string): number | null => {
  const trimmed = text.trim();
  return /^[0-9]{1,3}$/.test(trimmed) ? Number(trimmed) : null;
};

type LoopDraft = Record<LoopField, string>;
type LoopProblem = { readonly field: LoopField; readonly error: string };

function loopProblem(
  draft: LoopDraft,
  cap: number,
  t: (key: string, values?: Record<string, string | number>) => string,
): LoopProblem | null {
  const max = wholeNumber(draft.max);
  if (max === null || max < 1 || max > cap) {
    return { field: "max", error: t("mostInvalid", { cap }) };
  }
  const minTyped = draft.min.trim();
  const min = minTyped === "" ? null : wholeNumber(draft.min);
  if (min !== null && min > max) {
    return { field: "min", error: t("fewestAboveMost", { max }) };
  }
  const allowTyped = draft.allow.trim();
  const allow = allowTyped === "" ? null : wholeNumber(draft.allow);
  const low = min ?? 1;
  const high = Math.max(low, max - 1);
  if (allow !== null && (allow < low || allow > high)) {
    return { field: "allow", error: t("askRange", { low, high }) };
  }
  return null;
}

const LOOP_PAUSE_MS = 400;

function LoopPanel(
  { target, onViewAsCode }: {
    readonly target: Extract<PanelTarget, { readonly kind: "loop" }>;
    readonly onViewAsCode: (() => void) | null;
  },
) {
  const { translate } = useI18n();
  const t = (key: string, values?: Record<string, string | number>) =>
    translate(`library.editor.loop.${key}` as never, values as never);
  const asDraft = (values: LoopValues): LoopDraft => ({
    min: values.min === null ? "" : String(values.min),
    max: String(values.max),
    allow: values.allow === null ? "" : String(values.allow),
  });
  const committed =
    `${target.values.min}/${target.values.max}/${target.values.allow}`;
  const [draft, setDraft] = useState<LoopDraft>(asDraft(target.values));
  const [shown, setShown] = useState<LoopProblem | null>(null);
  const [seen, setSeen] = useState(committed);
  if (seen !== committed) {
    setSeen(committed);
    setDraft(asDraft(target.values));
    setShown(null);
  }
  const typed = (): LoopValues => ({
    min: draft.min.trim() === "" ? null : wholeNumber(draft.min),
    max: wholeNumber(draft.max) as number,
    allow: draft.allow.trim() === "" ? null : wholeNumber(draft.allow),
  });
  const commit = () => {
    const problem = loopProblem(draft, target.cap, t);
    setShown(problem);
    if (problem === null) target.onCommit(typed());
  };
  useEffect(() => {
    if (loopProblem(draft, target.cap, t) !== null) return;
    const next = typed();
    if (`${next.min}/${next.max}/${next.allow}` === committed) return;
    target.onPending(true);
    const timer = setTimeout(() => {
      target.onPending(false);
      target.onCommit(next);
    }, LOOP_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      target.onPending(false);
    };
  }, [draft]);
  const hintFor = (field: LoopField): string => {
    if (field === "min") {
      if (draft.min.trim() !== "") {
        return t(target.fix ? "fewestSet" : "fewestSetRepeat");
      }
      return t(target.fix ? "fewestEmpty" : "fewestEmptyRepeat");
    }
    if (field === "max") {
      return target.cap < 8
        ? t("mostHintCapped", { cap: target.cap })
        : t("mostHint", { cap: target.cap });
    }
    return t("askHint");
  };
  const fields: readonly { field: LoopField; label: string }[] = [
    { field: "min", label: t("fewest") },
    { field: "max", label: t("most") },
    { field: "allow", label: t("ask") },
  ];
  return (
    <UI.InspectorPanel
      id="editor-step-panel"
      label={translate("library.editor.panel.label" as never)}
      variant="column"
      header={<UI.Text variant="strong">{target.name}</UI.Text>}
      {...(onViewAsCode === null ? {} : {
        footer: (
          <UI.Button variant="secondary" onClick={onViewAsCode}>
            {translate("library.editor.viewAsCode" as never)}
          </UI.Button>
        ),
      })}
    >
      <UI.Stack gap="compact">
        {target.help === undefined ? null : <UI.Text>{target.help}</UI.Text>}
        {fields.map(({ field, label }) => (
          <UI.Field
            key={field}
            error={shown?.field === field ? shown.error : undefined}
            hint={hintFor(field)}
            htmlFor={`loop-${field}`}
            label={label}
          >
            <UI.TextInput
              autoComplete="off"
              id={`loop-${field}`}
              inputMode="numeric"
              max={field === "max" ? target.cap : undefined}
              min={1}
              name={field}
              onBlur={commit}
              onChange={(value) => {
                setDraft((held) => ({ ...held, [field]: value }));
                if (shown?.field === field) setShown(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                }
              }}
              type="number"
              value={draft[field]}
            />
          </UI.Field>
        ))}
        <UI.Text variant="muted">{t("codeUntil")}</UI.Text>
      </UI.Stack>
    </UI.InspectorPanel>
  );
}

/**
 * The Skills list of a step: the skills it names, in the order the server gives
 * them. A private skill wears one small word, Private; someone else's is plain
 * text on its row, with who let the workflow use it.
 */
function Skills(
  { skills, attach }: {
    readonly skills: Exclude<StepSkills, { readonly kind: "hidden" }>;
    readonly attach: StepAttach | null;
  },
) {
  const { translate } = useI18n();
  const t = (key: string, values?: Record<string, string | number>) =>
    translate(
      `library.workflow.editor.skills.${key}` as never,
      values as never,
    );
  const nothingOnOffer = attach !== null && attach.state === "ready" &&
    attach.offered === 0;
  return (
    <UI.Stack data-testid="step-skills" gap="compact">
      <UI.Inline gap="compact">
        <UI.Text variant="strong">{t("title")}</UI.Text>
        <UI.HelpTip label={t("helpLabel")}>{t("help")}</UI.HelpTip>
      </UI.Inline>
      {skills.kind === "loading"
        ? (
          <div aria-busy="true">
            <UI.Skeleton shape="row" />
          </div>
        )
        : skills.kind === "failed"
        ? (
          <UI.InlineNotice
            action={
              <UI.Button onClick={skills.onRetry} variant="secondary">
                {translate("core.actions.retry" as never)}
              </UI.Button>
            }
            role="status"
            tone="error"
          >
            {t("failed")}
          </UI.InlineNotice>
        )
        : skills.rows.length === 0
        // With nothing on offer the picker's own line says so: one empty line, not two.
        ? (nothingOnOffer
          ? null
          : <UI.Text variant="muted">{t("empty")}</UI.Text>)
        : (
          <UI.Stack gap="comfortable" role="list">
            {skills.rows.map((row) => (
              <SkillRow
                attach={attach}
                key={row.key}
                row={row}
                t={t}
              />
            ))}
          </UI.Stack>
        )}
      {attach === null || skills.kind !== "ready" ? null : (
        <AttachSkill
          attach={attach}
          hasRows={skills.rows.length > 0}
          t={t}
        />
      )}
    </UI.Stack>
  );
}

type Say = (key: string, values?: Record<string, string | number>) => string;

/**
 * The picker that attaches a skill (#431, design-ux): the organization's skills
 * first, then the caller's own private ones, with the group line that says
 * attaching one shares its use, not its files. Two skills of one name in one
 * group carry their slug so they can be told apart.
 */
function AttachSkill(
  { attach, hasRows, t }: {
    readonly attach: StepAttach;
    /** Whether the step already shows a skill row. */
    readonly hasRows: boolean;
    readonly t: Say;
  },
) {
  const { translate } = useI18n();
  if (attach.state === "failed") {
    return (
      <UI.InlineNotice
        action={
          <UI.Button onClick={attach.onRetry} variant="secondary">
            {translate("core.actions.retry" as never)}
          </UI.Button>
        }
        role="status"
        tone="error"
      >
        {t("picker.failed")}
      </UI.InlineNotice>
    );
  }
  if (attach.state === "ready" && attach.choices.length === 0) {
    // Nothing fits and nothing is shown: say so once. Otherwise the step already shows
    // what it has, and one short line says nothing more can be attached.
    const none = attach.offered === 0 && !hasRows;
    return (
      <UI.Text variant={none ? "muted" : "caption"}>
        {t(none ? "picker.empty" : "picker.allAttached")}
      </UI.Text>
    );
  }
  if (attach.state === "loading") {
    return (
      <UI.Button aria-busy disabled variant="secondary">
        {t("picker.placeholder")}
      </UI.Button>
    );
  }
  return (
    <SkillPicker
      attach={attach}
      onPick={(value) => attach.onChoose(value)}
      t={t}
      trigger={t("picker.placeholder")}
    />
  );
}

/**
 * The popover that picks a skill: a search field and the two groups. It adds a
 * skill from the Skills panel and replaces one from a slot's row.
 */
function SkillPicker(
  { attach, onPick, t, trigger }: {
    readonly attach: StepAttach;
    readonly onPick: (value: string) => void;
    readonly t: Say;
    readonly trigger: string;
  },
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const matches = (choice: SkillChoice) =>
    needle === "" ||
    `${choice.name} ${choice.slug}`.toLocaleLowerCase().includes(needle);
  const optionsOf = (group: SkillChoice["group"]) => {
    const inGroup = attach.choices.filter((choice) => choice.group === group);
    return inGroup.filter(matches).map((choice) => {
      const same = inGroup.filter((other) => other.name === choice.name).length;
      return (
        <UI.Button
          data-pick-skill={choice.value}
          key={choice.value}
          onClick={() => {
            setOpen(false);
            setQuery("");
            onPick(choice.value);
          }}
          variant="quiet"
        >
          <span>
            {choice.name}
            {t("picker.versionTail", { version: choice.revision })}
            {same > 1 ? t("picker.slugTail", { slug: choice.slug }) : null}
          </span>
        </UI.Button>
      );
    });
  };
  const organization = optionsOf("organization");
  const personal = optionsOf("private");
  return (
    <UI.Popover
      label={t("picker.label")}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      open={open}
      trigger={trigger}
      triggerAppearance="toolbar"
      variant="interactive"
    >
      <UI.Stack data-testid="skill-picker" gap="compact">
        <UI.SearchField
          aria-label={t("picker.find")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("picker.find")}
          value={query}
        />
        <UI.Stack data-picker-list="true" gap="compact">
          {organization.length === 0 && personal.length === 0
            ? (
              <UI.Text variant="muted">
                {t("picker.noMatch", { text: query })}
              </UI.Text>
            )
            : null}
          {organization.length === 0 ? null : (
            <>
              <UI.Text variant="strong">
                {t("picker.groupOrganization")}
              </UI.Text>
              {organization}
            </>
          )}
          {personal.length === 0 ? null : (
            <>
              <UI.Text variant="strong">{t("picker.groupPrivate")}</UI.Text>
              {personal}
            </>
          )}
        </UI.Stack>
      </UI.Stack>
    </UI.Popover>
  );
}

function SkillRow(
  { attach, row, t }: {
    readonly attach: StepAttach | null;
    readonly row: StepSkillRow;
    readonly t: (
      key: string,
      values?: Record<string, string | number>,
    ) => string;
  },
) {
  const version = row.revision ?? 0;
  const name = row.name ?? "";
  // The owner may be unknown (they left): the lines then say "someone else's".
  const owner = (row.owner ?? "").trim();
  // A skill that cannot be used says what happened; what to do about it comes with the controls.
  if (row.status !== "available") {
    return (
      <UI.Stack data-skill-status={row.status} gap="tight" role="listitem">
        <UI.Inline gap="compact">
          <UI.Text variant="strong">
            {row.name === null
              ? t(`slot.${row.status}.titleUnnamed`)
              : t(`slot.${row.status}.title`, { name })}
          </UI.Text>
        </UI.Inline>
        <UI.Text variant="muted">
          {row.status === "missing" && row.name === null
            ? t("slot.missing.bodyUnnamed")
            : row.status === "stopped" && row.mine
            ? t("slot.stopped.bodyOwner")
            : t(`slot.${row.status}.body`, { name })}
        </UI.Text>
        {
          /* Its own two actions, so no badge: Choose takes the place, Remove drops it. Nothing
            is drawn that cannot apply (no picker to offer, or a page that cannot edit). */
        }
        {row.onRemove === undefined && attach === null
          ? null
          : (
            <UI.Inline gap="compact">
              {}
              {row.status === "stopped" && row.mine && attach !== null &&
                  attach.state === "ready" && row.stepPath !== undefined &&
                  row.versionId != null && attach.canChoose(row.versionId)
                ? (
                  <UI.Button
                    variant="secondary"
                    onClick={() =>
                      attach.onChoose(row.versionId!, {
                        stepPath: row.stepPath!,
                        versionId: row.versionId ?? null,
                      })}
                  >
                    {t("slot.allowAgain")}
                  </UI.Button>
                )
                : null}
              {attach === null || attach.state !== "ready" ||
                  attach.choices.length === 0 || row.stepPath === undefined
                ? null
                : (
                  <SkillPicker
                    attach={attach}
                    onPick={(value) =>
                      attach.onChoose(value, {
                        stepPath: row.stepPath!,
                        versionId: row.versionId ?? null,
                      })}
                    t={t}
                    trigger={t("slot.choose")}
                  />
                )}
              {row.onRemove === undefined ? null : (
                <UI.Button
                  aria-label={row.name === null
                    ? t("slot.removeMissing")
                    : t("remove.label", { name })}
                  onClick={row.onRemove}
                  variant="text"
                >
                  {t("remove.action")}
                </UI.Button>
              )}
            </UI.Inline>
          )}
      </UI.Stack>
    );
  }
  const personal = row.scope === "personal";
  return (
    <UI.Stack gap="tight" role="listitem">
      <UI.Inline data-hung-tip gap="compact">
        <UI.Text variant="strong">{name}</UI.Text>
        {personal ? <UI.Badge tone="neutral">{t("private")}</UI.Badge> : null}
        {personal && !row.mine
          ? (
            <UI.HelpTip label={t("privateHelpLabel", { name })}>
              {owner === ""
                ? t("privateHelpUnnamed")
                : t("privateHelp", { owner })}
            </UI.HelpTip>
          )
          : null}
      </UI.Inline>
      <UI.Text variant="muted">
        {personal
          ? row.mine
            ? t("row.mine", { version })
            : owner === ""
            ? t("row.theirsUnnamed", { version })
            : t("row.theirs", { version, owner })
          : t(row.scope === "global" ? "row.global" : "row.organization", {
            version,
          })}
      </UI.Text>
      {row.onRemove === undefined ? null : (
        <UI.Inline>
          <UI.Button
            aria-label={t("remove.label", { name })}
            onClick={row.onRemove}
            variant="text"
          >
            {t("remove.action")}
          </UI.Button>
        </UI.Inline>
      )}
    </UI.Stack>
  );
}
