import { Button, Listbox, StatusWord } from "@facetdb/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { InstalledPlugin } from "../../api/index.ts";
import { BOX, Bracketed } from "./box.tsx";
import { currentValue, draftOf, type Edits, edited, NO_EDITS } from "./draft.ts";
import { PluginApplyDialog } from "./PluginApplyDialog.tsx";
import {
  filePath,
  isControl,
  type Json,
  type Path,
  pathText,
  type Setting,
  settingsOf,
  urlEntry,
  variableOf,
} from "./settings.ts";
import { changesWords, lineWords } from "./words.ts";

/**
 * One installed plugin's settings: a ruled grid of the setting's path and its value as text; a
 * variable as its name and whether it is set, with where to set it when it is not, never a value
 * and never an input; an endpoint cut to its host as its name and that host; a shape the form
 * cannot draw as where to edit it in facetdb.config.ts, with any variable inside it. A setting the
 * plugin marks editable is a control, and the form's Apply sends the plugin's whole settings with
 * the changes in place through Apply's diff.
 */

type Variable = InstalledPlugin["settings"]["variables"][number];

function Faint({ children }: { readonly children: string }) {
  return <span className="text-text-3">{children}</span>;
}

const WHERE_TO_SET = "Set it where the worker runs, then restart the worker.";

/** A variable by its name and whether the worker's environment has it: "from GITHUB_TOKEN set". */
function VariableLine({
  name,
  variable,
}: {
  readonly name: string;
  readonly variable: Variable | undefined;
}) {
  return (
    // The spaces between the parts are for a screen reader and a copy: the flex gap draws them.
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-text-2">from</span> <code>{name}</code>{" "}
      {variable === undefined ? null : (
        <StatusWord
          status={variable.set ? "done" : "pending"}
          label={variable.set ? "set" : "not set"}
          size="small"
        />
      )}
    </span>
  );
}

/** What the plugin's settings say of each place: its variable, and whether its address is cut. */
type Places = {
  readonly variables: ReadonlyMap<string, Variable>;
  readonly hostOnly: ReadonlySet<string>;
};

/** One value of a list or a map, as text: a variable, an address's host, or the text itself. */
function Item({
  value,
  at,
  places,
}: {
  readonly value: Json;
  readonly at: Path;
  readonly places: Places;
}) {
  const name = variableOf(value);
  if (name !== undefined) {
    return <VariableLine name={name} variable={places.variables.get(pathText(at))} />;
  }
  if (places.hostOnly.has(pathText(at)) && typeof value === "string") {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-2">
        <span className="text-text-2">at</span> <code>{value}</code>
      </span>
    );
  }
  // An endpoint written `{ url, allowPrivate }`: its host, and the flag in words.
  const endpoint = urlEntry(value);
  if (endpoint !== undefined && places.hostOnly.has(pathText([...at, "url"]))) {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-2">
        <span className="text-text-2">at</span> <code>{endpoint.url}</code>{" "}
        {endpoint.allowPrivate ? (
          <span className="text-text-2">private network allowed</span>
        ) : null}
      </span>
    );
  }
  return <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>;
}

/** Whether a value names a variable that is not set, anywhere inside it. */
function unsetInside(value: Json | undefined, at: Path, places: Places): boolean {
  const name = variableOf(value);
  if (name !== undefined) {
    return places.variables.get(pathText(at))?.set === false;
  }
  if (Array.isArray(value)) {
    return value.some((item, index) => unsetInside(item, [...at, index], places));
  }
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).some(([key, item]) => unsetInside(item, [...at, key], places))
  );
}

/** Where a shape the form cannot draw is edited, and any variable inside it. */
function EditInFile({
  plugin,
  setting,
  places,
}: {
  readonly plugin: InstalledPlugin;
  readonly setting: Setting;
  readonly places: Places;
}) {
  const at = pathText(setting.path);
  const inside = [...places.variables.values()].filter(
    (variable) =>
      at === "" ||
      variable.path === at ||
      variable.path.startsWith(`${at}.`) ||
      variable.path.startsWith(`${at}[`),
  );
  return (
    <span className="grid gap-1.5">
      <span>
        Edit this setting in facetdb.config.ts, at <code>{filePath(plugin, setting.path)}</code>.
      </span>
      {inside.map((variable) => (
        <span key={variable.path} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <code className="text-text-2">{variable.path}</code>{" "}
          <VariableLine name={variable.variable} variable={variable} />
        </span>
      ))}
    </span>
  );
}

/** A setting's value as text, as the file writes it, or the plugin's default where it writes none. */
function Shown({
  plugin,
  setting,
  places,
}: {
  readonly plugin: InstalledPlugin;
  readonly setting: Setting;
  readonly places: Places;
}) {
  const { shape, path } = setting;
  if (shape.kind === "other") {
    return <EditInFile plugin={plugin} setting={setting} places={places} />;
  }
  const written = currentValue(plugin.settings.values, NO_EDITS, path);
  const value = written ?? setting.fallback;
  const several = shape.kind === "list" || shape.kind === "map";
  if (value === undefined || value === null) {
    return <Faint>{several ? "none" : "not set"}</Faint>;
  }
  const unset = unsetInside(value, path, places);
  let shown: ReactNode;
  const variable = variableOf(value);
  if (variable !== undefined) {
    shown = <VariableLine name={variable} variable={places.variables.get(pathText(path))} />;
  } else if (shape.kind === "list" && Array.isArray(value)) {
    shown =
      value.length === 0 ? (
        <Faint>none</Faint>
      ) : (
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {value.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a list's item is its place in the list
            <Item key={index} value={item} at={[...path, index]} places={places} />
          ))}
        </span>
      );
  } else if (shape.kind === "map" && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    shown =
      entries.length === 0 ? (
        <Faint>none</Faint>
      ) : (
        <span className="grid gap-1.5">
          {entries.map(([key, item]) => (
            <span key={key} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <code>{key}</code> <Item value={item} at={[...path, key]} places={places} />
            </span>
          ))}
        </span>
      );
  } else if (typeof value === "boolean") {
    shown = <span>{value ? "on" : "off"}</span>;
  } else if (typeof value === "string" || typeof value === "number") {
    shown = <code>{String(value)}</code>;
  } else {
    // A value of another shape than its schema says: the file is where it is read.
    return (
      <EditInFile
        plugin={plugin}
        setting={{ ...setting, shape: { kind: "other" } }}
        places={places}
      />
    );
  }
  return unset ? (
    <span className="grid gap-1">
      {shown}
      <span className="text-[12.5px] text-text-2">{WHERE_TO_SET}</span>
    </span>
  ) : (
    shown
  );
}

/** The text of a value in a text box: what is written, else the default, else nothing. */
function textOf(value: Json | undefined): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

type ControlProps = {
  readonly setting: Setting;
  readonly name: string;
  readonly id: string;
  /** What the setting holds now (a change, else the file's), or its default where it holds nothing. */
  readonly value: Json | undefined;
  readonly onChange: (next: Json | undefined) => void;
};

/**
 * Whether an emptied box leaves out a setting the plugin requires and has no default for: the box
 * says "Required" there and then, before Apply's diff would refuse it.
 */
function leftOut(setting: Setting, text: string): boolean {
  return setting.required && setting.fallback === undefined && text.trim() === "";
}

function Missing({ id, shown }: { readonly id: string; readonly shown: boolean }) {
  return shown ? (
    <span id={id} className="mt-1.5 block border-l-2 border-no pl-2 text-[13px] text-text">
      Required
    </span>
  ) : null;
}

/** A text box: emptied, the setting is taken out of the file, and the plugin's default applies. */
function TextControl({ setting, id, value, onChange }: ControlProps) {
  const [text, setText] = useState(textOf(value));
  const missing = `${id}-missing`;
  const absent = leftOut(setting, text);
  return (
    <>
      <Bracketed full narrow>
        <input
          id={id}
          className={BOX}
          value={text}
          autoComplete="off"
          aria-invalid={absent}
          {...(absent ? { "aria-describedby": missing } : {})}
          onChange={(event) => {
            setText(event.target.value);
            onChange(event.target.value === "" ? undefined : event.target.value);
          }}
        />
      </Bracketed>
      <Missing id={missing} shown={absent} />
    </>
  );
}

/** A number box: what is not a number is sent as written, and Apply's diff says what is wrong. */
function NumberControl({ setting, id, value, onChange }: ControlProps) {
  const [text, setText] = useState(textOf(value));
  const trimmed = text.trim();
  const missing = `${id}-missing`;
  const absent = leftOut(setting, text);
  return (
    <>
      <Bracketed full narrow>
        <input
          id={id}
          className={BOX}
          inputMode="decimal"
          autoComplete="off"
          value={text}
          aria-invalid={absent || (trimmed !== "" && !Number.isFinite(Number(trimmed)))}
          {...(absent ? { "aria-describedby": missing } : {})}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const number = Number(next.trim());
            onChange(next.trim() === "" ? undefined : Number.isFinite(number) ? number : next);
          }}
        />
      </Bracketed>
      <Missing id={missing} shown={absent} />
    </>
  );
}

function BooleanControl({ id, value, onChange }: ControlProps) {
  return (
    <Bracketed>
      <input
        id={id}
        type="checkbox"
        className="accent-facet focus-visible:outline-2 focus-visible:outline-transparent"
        checked={value === true}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
    </Bracketed>
  );
}

function ChoiceControl({ setting, name, id, value, onChange }: ControlProps) {
  const options = setting.shape.kind === "choice" ? setting.shape.options : [];
  return (
    <Listbox
      id={id}
      label={name}
      placeholder="not set"
      options={options.map((option) => ({ value: option, label: option }))}
      // Radix shows the placeholder for "": a choice the file does not make stays controlled.
      value={typeof value === "string" ? value : ""}
      onValueChange={(next) => {
        onChange(next);
      }}
    />
  );
}

/**
 * Lines of text, each with Remove, and Add for one more. A line left empty is not sent. Add puts the
 * focus in the new line, and Remove on the next one, or on Add after the last.
 */
function ListControl({ name, value, onChange }: ControlProps) {
  const [lines, setLines] = useState<readonly string[]>(() =>
    Array.isArray(value) ? value.map(textOf) : [],
  );
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const add = useRef<HTMLButtonElement>(null);
  const focus = useRef<number | null>(null);
  useEffect(() => {
    if (focus.current === null) {
      return;
    }
    (boxes.current[focus.current] ?? add.current)?.focus();
    focus.current = null;
  });
  const changed = (next: readonly string[]) => {
    setLines(next);
    onChange(next.filter((line) => line !== ""));
  };
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
      <legend className="sr-only">{name}</legend>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line is its place in the list
        <span key={index} className="flex flex-wrap items-center gap-2">
          <Bracketed full narrow>
            <input
              ref={(box) => {
                boxes.current[index] = box;
              }}
              className={BOX}
              value={line}
              autoComplete="off"
              aria-label={`${name}, ${lineWords(index)}`}
              onChange={(event) => {
                changed(lines.map((one, at) => (at === index ? event.target.value : one)));
              }}
            />
          </Bracketed>
          <Button
            size="small"
            variant="quiet"
            aria-label={`Remove ${line === "" ? `${lineWords(index)} of ${name}` : line}`}
            onClick={() => {
              // The next line takes its place and the focus; after the last, Add does.
              focus.current = index;
              changed(lines.filter((_, at) => at !== index));
            }}
          >
            Remove
          </Button>
        </span>
      ))}
      <span>
        <Button
          ref={add}
          size="small"
          aria-label={`Add to ${name}`}
          onClick={() => {
            focus.current = lines.length;
            setLines([...lines, ""]);
          }}
        >
          Add
        </Button>
      </span>
    </fieldset>
  );
}

/** Keys and their text, each pair with Remove, and Add for one more. A pair with no key is not sent. */
function MapControl({ name, value, onChange }: ControlProps) {
  const [pairs, setPairs] = useState<readonly (readonly [string, string])[]>(() =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.entries(value).map(([key, item]) => [key, textOf(item)] as const)
      : [],
  );
  const keys = useRef<(HTMLInputElement | null)[]>([]);
  const add = useRef<HTMLButtonElement>(null);
  const focus = useRef<number | null>(null);
  useEffect(() => {
    if (focus.current === null) {
      return;
    }
    (keys.current[focus.current] ?? add.current)?.focus();
    focus.current = null;
  });
  const changed = (next: readonly (readonly [string, string])[]) => {
    setPairs(next);
    onChange(Object.fromEntries(next.filter(([key]) => key !== "")));
  };
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
      <legend className="sr-only">{name}</legend>
      {pairs.map(([key, item], index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a pair is its place in the list
        <span key={index} className="flex flex-wrap items-center gap-2">
          <Bracketed>
            <input
              ref={(box) => {
                keys.current[index] = box;
              }}
              className={`${BOX} max-w-[160px]`}
              value={key}
              autoComplete="off"
              aria-label={`${name}, the key of ${lineWords(index)}`}
              onChange={(event) => {
                changed(
                  pairs.map((pair, at) => (at === index ? [event.target.value, pair[1]] : pair)),
                );
              }}
            />
          </Bracketed>
          <Bracketed>
            <input
              className={BOX}
              value={item}
              autoComplete="off"
              aria-label={`${name}, the value of ${lineWords(index)}`}
              onChange={(event) => {
                changed(
                  pairs.map((pair, at) => (at === index ? [pair[0], event.target.value] : pair)),
                );
              }}
            />
          </Bracketed>
          <Button
            size="small"
            variant="quiet"
            aria-label={`Remove ${key === "" ? `${lineWords(index)} of ${name}` : key}`}
            onClick={() => {
              // The next pair takes its place and the focus; after the last, Add does.
              focus.current = index;
              changed(pairs.filter((_, at) => at !== index));
            }}
          >
            Remove
          </Button>
        </span>
      ))}
      <span>
        <Button
          ref={add}
          size="small"
          aria-label={`Add to ${name}`}
          onClick={() => {
            focus.current = pairs.length;
            setPairs([...pairs, ["", ""]]);
          }}
        >
          Add
        </Button>
      </span>
    </fieldset>
  );
}

const CONTROLS = {
  text: TextControl,
  number: NumberControl,
  boolean: BooleanControl,
  choice: ChoiceControl,
  list: ListControl,
  map: MapControl,
} as const;

/** Whether a setting's name is a label for its control (one box), or the name of a group of them. */
function labelled(setting: Setting): boolean {
  return ["text", "number", "boolean"].includes(setting.shape.kind);
}

/** The changes, and the values they were made over: a new read of the plugin starts again. */
type FormState = { readonly base: string; readonly edits: Edits; readonly generation: number };

export function PluginSettings({ plugin }: { readonly plugin: InstalledPlugin }) {
  const id = useId();
  const settings = settingsOf(plugin);
  const controls = new Set(settings.filter((setting) => isControl(setting, plugin)));
  const places: Places = {
    variables: new Map(plugin.settings.variables.map((variable) => [variable.path, variable])),
    hostOnly: new Set(plugin.settings.hostOnly),
  };
  const { values } = plugin.settings;
  const base = JSON.stringify(values);
  const [state, setState] = useState<FormState>({ base, edits: NO_EDITS, generation: 0 });
  // The worker's values changed under the form (the write landed, or the file was edited): the
  // changes made over the old ones are dropped, and the controls start again from the new.
  const over = (held: FormState): FormState =>
    held.base === base ? held : { base, edits: NO_EDITS, generation: held.generation + 1 };
  const { edits, generation } = over(state);
  const [opened, setOpened] = useState(0);
  const [applying, setApplying] = useState(false);
  const apply = useRef<HTMLButtonElement>(null);
  // The dialog has no trigger of its own, so Radix gives the focus back to nothing when it closes
  // and it would land on the page's body: once the dialog is gone, Apply takes it back.
  const closing = useRef(false);
  useEffect(() => {
    if (!applying && closing.current) {
      closing.current = false;
      apply.current?.focus();
    }
  }, [applying]);

  const rows = settings.map((setting) => {
    const name = pathText(setting.path) === "" ? "settings" : pathText(setting.path);
    const controlId = `${id}-${pathText(setting.path)}`;
    if (!controls.has(setting)) {
      return (
        <Row key={name} name={name}>
          <Shown plugin={plugin} setting={setting} places={places} />
        </Row>
      );
    }
    const Control = CONTROLS[setting.shape.kind as keyof typeof CONTROLS];
    const value = currentValue(values, edits, setting.path) ?? setting.fallback;
    return (
      <Row key={name} name={name} {...(labelled(setting) ? { labelFor: controlId } : {})}>
        <Control
          key={generation}
          setting={setting}
          name={name}
          id={controlId}
          value={value}
          onChange={(next) => {
            setState((held) => {
              const now = over(held);
              return { ...now, edits: edited(now.edits, values, setting, next) };
            });
          }}
        />
      </Row>
    );
  });

  if (controls.size === 0) {
    return <dl className={GRID}>{rows}</dl>;
  }
  const changes = edits.size;
  return (
    <form
      aria-label={`${plugin.name}'s settings`}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <dl className={GRID}>{rows}</dl>
      <div className="flex flex-wrap items-center gap-3">
        {/* Never disabled: the focus comes back to it after Discard and after the dialog, and with
            nothing changed its diff says there is nothing to write. */}
        <Button
          ref={apply}
          variant="primary"
          onClick={() => {
            setOpened((count) => count + 1);
            setApplying(true);
          }}
        >
          Apply
        </Button>
        {changes === 0 ? null : (
          <Button
            variant="quiet"
            onClick={() => {
              setState({ base, edits: NO_EDITS, generation: generation + 1 });
              apply.current?.focus();
            }}
          >
            Discard
          </Button>
        )}
        <span role="status" className="text-[12.5px] text-text-2">
          {changes === 0 ? "" : changesWords(changes)}
        </span>
      </div>
      {applying ? (
        <PluginApplyDialog
          name={plugin.name}
          plugin={plugin.key}
          draft={{ [plugin.key]: draftOf(values, edits) }}
          opened={opened}
          onOpenChange={(open) => {
            if (!open) {
              closing.current = true;
              setApplying(false);
            }
          }}
        />
      ) : null}
    </form>
  );
}

const GRID =
  "m-0 grid grid-cols-1 items-baseline gap-x-4 gap-y-1 min-[900px]:grid-cols-[130px_minmax(0,1fr)] min-[900px]:gap-y-2.5";

/** One setting: its path, then its value or its control. */
function Row({
  name,
  labelFor,
  children,
}: {
  readonly name: string;
  /** The control's id, when the path labels one box. */
  readonly labelFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="min-w-0 pt-2 wrap-anywhere text-text-2 first:pt-0 min-[900px]:pt-0">
        {labelFor === undefined ? (
          <code>{name}</code>
        ) : (
          <label htmlFor={labelFor}>
            <code>{name}</code>
          </label>
        )}
      </dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}
