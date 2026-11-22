import type {
  AlertChannel,
  AlertChannelEntry,
  AlertsDraft,
  ChannelSends,
  InstalledPlugin,
} from "../../api/index.ts";

/**
 * The channel form: what a person fills in, what is wrong with it before anything is sent, and the
 * project draft's `alerts` it makes, built over the channels as facetdb.config.ts writes them (`GET
 * /v1/config`), so every other channel goes back exactly as the file has it. The loader judges the
 * draft again behind Apply, in its own words.
 */

export type ChannelForm = {
  /** The kind: a channel plugin's short name, `slack`. */
  readonly kind: string;
  /** Where it posts (`#ops`); null for a channel whose address the page withholds: the file's stays. */
  readonly where: string | null;
  readonly sends: ChannelSends;
  /** `HH:MM`, or empty for no quiet hours. */
  readonly from: string;
  readonly to: string;
  /** The zone the hours are read in; null for the worker machine's. */
  readonly zone: string | null;
};

export type FormProblems = {
  readonly where?: string;
  readonly from?: string;
  readonly to?: string;
  readonly zone?: string;
};

/** The address of a channel as the file writes it either way: `slack:#ops`. */
export function addressOf(entry: AlertChannelEntry): string {
  return typeof entry === "string" ? entry : entry.to;
}

/** A new channel of a kind: critical alerts and warnings, as the mockup chooses, and no quiet hours. */
export function newForm(kind: string): ChannelForm {
  return { kind, where: "", sends: "warnings", from: "", to: "", zone: null };
}

/** The form over a channel of the file; `withheld` keeps its where off the page. */
export function formOfEntry(entry: AlertChannelEntry, withheld: boolean): ChannelForm {
  const address = addressOf(entry);
  const colon = address.indexOf(":");
  const sends = typeof entry === "string" ? undefined : entry.sends;
  const quiet = typeof entry === "string" ? undefined : entry.quiet;
  return {
    kind: address.slice(0, colon),
    where: withheld ? null : address.slice(colon + 1),
    sends: sends ?? "everything",
    from: quiet?.from ?? "",
    to: quiet?.to ?? "",
    zone: quiet?.zone ?? null,
  };
}

/** `HH:MM` on a 24-hour clock, as the config writes it; `7:00` is read as `07:00`. */
function clockTime(text: string): string | undefined {
  const trimmed = text.trim();
  const padded = /^\d:\d\d$/.test(trimmed) ? `0${trimmed}` : trimmed;
  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(padded) ? padded : undefined;
}

/**
 * What is wrong with the form before anything is sent, by field, in plain words. `whereLabel` is
 * the where field's own label ("Channel", "Address"). With the worker's zone unreadable, quiet
 * hours need a zone of their own: the worker refuses them without one.
 */
export function problemsOf(
  form: ChannelForm,
  whereLabel: string,
  workerZone: string | null,
): FormProblems {
  const problems: { -readonly [Field in keyof FormProblems]: string } = {};
  if (form.where !== null && form.where.trim() === "") {
    problems.where = `${whereLabel} is needed.`;
  }
  const from = form.from.trim();
  const to = form.to.trim();
  if (from === "" && to === "") {
    return problems;
  }
  if (from === "" || to === "") {
    problems[from === "" ? "from" : "to"] = "Give both times, or neither.";
    return problems;
  }
  const time = "Write a time as HH:MM, such as 22:00.";
  if (clockTime(from) === undefined) {
    problems.from = time;
  }
  if (clockTime(to) === undefined) {
    problems.to = time;
  }
  if (
    problems.from === undefined &&
    problems.to === undefined &&
    clockTime(from) === clockTime(to)
  ) {
    problems.to = "Give a different time from From.";
  }
  if (form.zone === null && workerZone === null) {
    problems.zone = "Choose a zone: the worker's cannot be read.";
  }
  return problems;
}

export function hasProblems(problems: FormProblems): boolean {
  return Object.keys(problems).length > 0;
}

/**
 * The channel as the file will write it: the address alone when it is sent everything with no
 * quiet hours (the file's shortest form), else the address under `to` with what differs from that.
 * `address` is the file's own for a channel whose where the page withholds.
 */
export function entryOf(form: ChannelForm, address?: string): AlertChannelEntry {
  const to = address ?? `${form.kind}:${(form.where ?? "").trim()}`;
  const from = clockTime(form.from);
  const until = clockTime(form.to);
  const quiet =
    from === undefined || until === undefined
      ? undefined
      : { from, to: until, ...(form.zone === null ? {} : { zone: form.zone }) };
  if (form.sends === "everything" && quiet === undefined) {
    return to;
  }
  return {
    to,
    ...(form.sends === "everything" ? {} : { sends: form.sends }),
    ...(quiet === undefined ? {} : { quiet }),
  };
}

/** Whether two forms say the same: an unchanged channel keeps the file's own form. */
function sameForm(a: ChannelForm, b: ChannelForm): boolean {
  return (
    JSON.stringify(entryOf(a, "x:x")) === JSON.stringify(entryOf(b, "x:x")) && a.where === b.where
  );
}

/** One change to the channels: a new one, one edited at its place in the file, or one removed. */
export type ChannelChange =
  | { readonly kind: "add"; readonly form: ChannelForm }
  | { readonly kind: "edit"; readonly index: number; readonly form: ChannelForm }
  | { readonly kind: "remove"; readonly index: number };

/** The project draft's `alerts` the change makes over the file's channels; null when none is left. */
export function draftOf(entries: readonly AlertChannelEntry[], change: ChannelChange): AlertsDraft {
  const channels = (() => {
    switch (change.kind) {
      case "add":
        return [...entries, entryOf(change.form)];
      case "remove":
        return entries.filter((_entry, index) => index !== change.index);
      case "edit":
        return entries.map((entry, index) => {
          if (index !== change.index) {
            return entry;
          }
          const withheld = change.form.where === null;
          if (sameForm(formOfEntry(entry, withheld), change.form)) {
            return entry;
          }
          return entryOf(change.form, withheld ? addressOf(entry) : undefined);
        });
    }
  })();
  return channels.length === 0 ? null : { channels };
}

/**
 * Where a listed channel sits in the file's list: by its address, which the file names once; a
 * channel whose address the page withholds by its place, when the file's entry there is of its
 * kind. -1 when the two lists no longer agree (the file changed between the two reads).
 */
export function indexInFile(
  entries: readonly AlertChannelEntry[],
  channel: AlertChannel,
  position: number,
): number {
  if (channel.address !== null) {
    return entries.findIndex((entry) => addressOf(entry) === channel.address);
  }
  const entry = entries[position];
  return entry !== undefined && addressOf(entry).startsWith(`${channel.kind}:`) ? position : -1;
}

/** How a kind's where is asked: a text box with its label and an example, or a choice of names. */
export type PlaceField = {
  readonly label: string;
  readonly placeholder?: string;
  /** The names the plugin's settings allow (webhook endpoints, Slack channels with a webhook). */
  readonly options?: readonly string[];
  readonly help?: string;
};

/** The keys of an object setting (`endpoints`, `webhooks`): names, never their values. */
function namesIn(value: unknown): readonly string[] | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value)
    : undefined;
}

/**
 * The where field of a kind, from its plugin: FacetDB's own channel plugins by their short name
 * (the Plugins page's read, which this shares, names no package), the webhook only when it is the
 * built-in one, any other as a plain "Where". A Slack plugin with no bot token posts only to the
 * channels it has a webhook for, and the webhook only to the endpoints its settings name: then the
 * field is a choice of their names (an endpoint's address is never read here).
 */
export function placeOf(plugin: InstalledPlugin | undefined): PlaceField {
  const values = plugin?.settings.values ?? {};
  const name = plugin?.name === "webhook" && !plugin.builtIn ? undefined : plugin?.name;
  switch (name) {
    case "slack": {
      const hooks = values["token"] === undefined ? namesIn(values["webhooks"]) : undefined;
      return hooks === undefined
        ? { label: "Channel", placeholder: "#ops or C0123ABCD" }
        : {
            label: "Channel",
            options: hooks,
            help: "Only channels with a webhook in facetdb.config.ts.",
          };
    }
    case "webhook":
      return {
        label: "Endpoint",
        options: namesIn(values["endpoints"]) ?? [],
        help: "Endpoints are set in facetdb.config.ts.",
      };
    case "email":
      return { label: "Address", placeholder: "ops@example.com" };
    case "telegram":
      return { label: "Chat", placeholder: "-1001234567890 or @channel" };
    default:
      return { label: "Where" };
  }
}
