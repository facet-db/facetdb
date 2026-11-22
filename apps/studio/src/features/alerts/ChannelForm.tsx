import { Button, focusBrackets, Listbox } from "@facetdb/ui";
import { memo, type ReactNode, useCallback, useId, useLayoutEffect, useMemo, useRef } from "react";
import type { ChannelSends } from "../../api/index.ts";
import { CommandLine } from "../questions/index.ts";
import type { ChannelForm as Form, FormProblems, PlaceField } from "./draft.ts";
import { kindTitle, SENDS_WORDS } from "./words.ts";

/**
 * The channel form's fields ("Add a channel" and "Edit"): the kind, where it posts, what it sends
 * and its quiet hours as two times and a zone, the worker's by default. Controls the packages/ui
 * set has not (a text box with its problem, a radio) are drawn here with the brief's tokens; the
 * focus shows as the corner brackets on their wrappers.
 */

/** The zone choice that stands for the worker machine's own: no `zone` in the file. */
const WORKER_ZONE = "worker";

/** Every zone this browser knows, UTC first: a zone is found by typing its first letters. */
function zoneNames(current: string | null): readonly string[] {
  const known = Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC");
  const names = ["UTC", ...known];
  return current === null || names.includes(current) ? names : [current, ...names];
}

const BOX =
  "h-9 w-full min-w-0 border border-hairline bg-transparent px-3 text-text placeholder:text-text-3 hover:border-text-3 focus-visible:outline-2 focus-visible:outline-transparent aria-[invalid=true]:border-no";

function Problem({ id, words }: { readonly id: string; readonly words: string }) {
  return (
    <p id={id} className="m-0 border-l-2 border-no pl-2 text-[13px]">
      {words}
    </p>
  );
}

/** A labelled text box, its problem tied to it. */
function TextBox({
  label,
  value,
  onChange,
  problem,
  placeholder,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly problem: string | undefined;
  readonly placeholder?: string | undefined;
  readonly mono?: boolean;
}) {
  const id = useId();
  const problemId = `${id}-problem`;
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label htmlFor={id} className="text-[13px] text-text-2">
        {label}
      </label>
      <span className={`${focusBrackets} relative block has-[:focus-visible]:after:opacity-100!`}>
        <input
          id={id}
          value={value}
          autoComplete="off"
          spellCheck={false}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(problem === undefined
            ? {}
            : { "aria-invalid": true, "aria-describedby": problemId })}
          className={`${BOX}${mono ? " font-mono" : ""}`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </span>
      {problem === undefined ? null : <Problem id={problemId} words={problem} />}
    </div>
  );
}

/** A listbox with a visible label above it and, under it, a help line and a problem. */
function Choice({
  label,
  value,
  options,
  onChange,
  placeholder,
  help,
  problem,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly help?: string | undefined;
  readonly problem?: string | undefined;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const problemId = `${id}-problem`;
  // The help and the problem describe the choice, as a text box's do; a refused one is marked
  // invalid, so a refused Apply moves the focus to it like any other field (ChannelDialog).
  const described = [help === undefined ? "" : helpId, problem === undefined ? "" : problemId]
    .filter((one) => one !== "")
    .join(" ");
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <label htmlFor={id} className="text-[13px] text-text-2">
        {label}
      </label>
      <Listbox
        id={id}
        label={label}
        width="full"
        value={value}
        options={options}
        onValueChange={onChange}
        invalid={problem !== undefined}
        {...(described === "" ? {} : { describedBy: described })}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
      {help === undefined ? null : (
        <p id={helpId} className="m-0 text-[12.5px] text-text-3">
          {help}
        </p>
      )}
      {problem === undefined ? null : <Problem id={problemId} words={problem} />}
    </div>
  );
}

function Radio({
  name,
  checked,
  onChange,
  children,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <span
      className={`${focusBrackets} relative inline-flex w-fit items-center has-[:focus-visible]:after:opacity-100!`}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        className="size-4 accent-facet focus-visible:outline-2 focus-visible:outline-transparent"
        onChange={(event) => {
          if (event.target.checked) {
            onChange();
          }
        }}
      />
      <label htmlFor={id} className="pl-2.5">
        {children}
      </label>
    </span>
  );
}

/**
 * The time zone choice: the worker's own first (when it can be read), then every zone. Some four
 * hundred options, so it is drawn again only when its own value, zone or problem changes.
 */
const ZoneChoice = memo(function ZoneChoice({
  value,
  zone,
  workerZone,
  problem,
  onPick,
}: {
  readonly value: string;
  readonly zone: string | null;
  readonly workerZone: string | null;
  readonly problem: string | undefined;
  readonly onPick: (value: string) => void;
}) {
  const options = useMemo(
    () => [
      ...(workerZone === null
        ? []
        : [{ value: WORKER_ZONE, label: `The worker's (${workerZone})` }]),
      ...zoneNames(zone).map((name) => ({ value: name, label: name })),
    ],
    [zone, workerZone],
  );
  return (
    <Choice
      label="Time zone"
      value={value}
      placeholder="Choose a zone"
      options={options}
      problem={problem}
      onChange={onPick}
    />
  );
});

/** A kind the form can offer: one the worker hosts, or one the registry has with its command. */
export type KindOption =
  | { readonly kind: string; readonly installed: true }
  | { readonly kind: string; readonly installed: false; readonly command: string };

/** The kind's listbox value: a kind not installed is told apart, though no two share a name. */
export function kindValue(option: KindOption): string {
  return option.installed ? option.kind : `add:${option.kind}`;
}

/** The kind choice, the add form's first field. */
export function KindField({
  kinds,
  value,
  onChange,
}: {
  readonly kinds: readonly KindOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Choice
      label="Kind"
      value={value}
      options={kinds.map((option) => ({
        value: kindValue(option),
        label: option.installed
          ? kindTitle(option.kind)
          : `${kindTitle(option.kind)} (not installed)`,
      }))}
      onChange={onChange}
    />
  );
}

/** A kind whose plugin is not installed: its command, for the project's folder, instead of a form. */
export function NotInstalled({
  kind,
  command,
}: {
  readonly kind: string;
  readonly command: string;
}) {
  return (
    <div className="grid gap-2">
      <p className="m-0">{`${kindTitle(kind)} is not installed. Run this in the project's folder:`}</p>
      <CommandLine command={command} />
    </div>
  );
}

/** Where, what it sends and the quiet hours: the fields the add form and the edit form share. */
export function ChannelFields({
  form,
  onChange,
  place,
  problems,
  workerZone,
}: {
  readonly form: Form;
  readonly onChange: (form: Form) => void;
  readonly place: PlaceField;
  /** Shown once Apply was pressed; empty before. */
  readonly problems: FormProblems;
  readonly workerZone: string | null;
}) {
  const sendsName = useId();
  const { where } = form;
  // The zone's pick reads the form as it is when the person picks, so the list need not be drawn
  // again on every key typed elsewhere in the form (ZoneChoice).
  const latest = useRef({ form, onChange });
  useLayoutEffect(() => {
    latest.current = { form, onChange };
  });
  const pickZone = useCallback((next: string) => {
    const { form: now, onChange: change } = latest.current;
    change({ ...now, zone: next === WORKER_ZONE ? null : next });
  }, []);
  const options =
    place.options === undefined
      ? undefined
      : [...new Set([...(where === null || where === "" ? [] : [where]), ...place.options])];
  const zoneValue = form.zone ?? (workerZone === null ? "" : WORKER_ZONE);
  return (
    <>
      {where === null ? (
        <p className="m-0 text-text-2">{`${place.label}: as facetdb.config.ts writes it.`}</p>
      ) : options === undefined ? (
        <TextBox
          label={place.label}
          value={where}
          placeholder={place.placeholder}
          problem={problems.where}
          onChange={(next) => {
            onChange({ ...form, where: next });
          }}
        />
      ) : (
        <Choice
          label={place.label}
          value={where}
          placeholder="Choose one"
          options={options.map((name) => ({ value: name, label: name }))}
          help={place.help}
          problem={problems.where}
          onChange={(next) => {
            onChange({ ...form, where: next });
          }}
        />
      )}
      <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-[13px] text-text-2">Sends</legend>
        {(Object.keys(SENDS_WORDS) as ChannelSends[]).map((sends) => (
          <Radio
            key={sends}
            name={sendsName}
            checked={form.sends === sends}
            onChange={() => {
              onChange({ ...form, sends });
            }}
          >
            {SENDS_WORDS[sends]}
          </Radio>
        ))}
      </fieldset>
      <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-[13px] text-text-2">Quiet hours, optional</legend>
        <div className="flex flex-wrap items-start gap-3">
          <div className="w-[100px]">
            <TextBox
              label="From"
              value={form.from}
              placeholder="HH:MM"
              mono
              problem={problems.from}
              onChange={(next) => {
                onChange({ ...form, from: next });
              }}
            />
          </div>
          <div className="w-[100px]">
            <TextBox
              label="To"
              value={form.to}
              placeholder="HH:MM"
              mono
              problem={problems.to}
              onChange={(next) => {
                onChange({ ...form, to: next });
              }}
            />
          </div>
          <div className="min-w-[240px] flex-1">
            <ZoneChoice
              value={zoneValue}
              zone={form.zone}
              workerZone={workerZone}
              problem={problems.zone}
              onPick={pickZone}
            />
          </div>
        </div>
        <p className="m-0 text-[12.5px] text-text-3">
          Critical alerts still go through; the rest wait for one summary when the hours end.
        </p>
        {workerZone === null ? (
          <p className="m-0 border-l-2 border-review pl-3">
            The worker's time zone cannot be read, so quiet hours need a zone chosen here.
          </p>
        ) : null}
      </fieldset>
    </>
  );
}

/** The foot of the form: Remove at the left when editing, then Cancel and Apply, the form's submit. */
export function FormActions({
  onRemove,
  onCancel,
  applyDisabled,
}: {
  readonly onRemove: (() => void) | null;
  readonly onCancel: () => void;
  readonly applyDisabled: boolean;
}) {
  return (
    <div className="fdb-dialog-actions">
      {onRemove === null ? null : (
        <Button variant="quiet" className="mr-auto" onClick={onRemove}>
          Remove
        </Button>
      )}
      <Button variant="quiet" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="primary" type="submit" disabled={applyDisabled}>
        Apply
      </Button>
    </div>
  );
}
