/**
 * The slice of semver a plugin's `facetdb` range needs: `^`, `~`, comparators (`>=1.2.0 <2.0.0`),
 * partial and x-ranges (`1`, `1.2`, `1.x`, `*`) and `||`. No dependency: the grammar is small and
 * the package keeps its install light. Hyphen ranges are not supported and are reported as invalid.
 */

type Version = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: readonly string[];
};

type Comparator = { readonly op: "<" | "<=" | ">" | ">=" | "="; readonly version: Version };

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split("."),
  };
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== undefined;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    return Math.sign(Number(a) - Number(b));
  }
  if (aNumeric !== bNumeric) {
    return aNumeric ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a: Version, b: Version): number {
  for (const [x, y] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const order = compareIdentifiers(x, y);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

const release = (major: number, minor: number, patch: number): Version => ({
  major,
  minor,
  patch,
  pre: [],
});

const WILDCARD = /^[xX*]$/;

/** One whitespace-free term of a range, as the comparators it stands for; undefined if invalid. */
function termComparators(term: string): Comparator[] | undefined {
  const operator = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(term);
  const op = operator?.[1] ?? "";
  const body = operator?.[2] ?? "";
  const parts = body.split(/[-+]/, 1)[0]?.split(".") ?? [];
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^(\d+|[xX*])$/.test(p))) {
    return undefined;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    if (WILDCARD.test(part)) {
      break;
    }
    numbers.push(Number(part));
  }
  const [major, minor, patch] = numbers;
  const given = numbers.length;
  if (given === 0) {
    return op === "" || op === "=" || op === ">=" || op === "^" || op === "~" ? [] : undefined;
  }
  const full = given === 3 ? parseVersion(body) : undefined;
  if (given === 3 && full === undefined) {
    return undefined;
  }
  const floor = full ?? release(major ?? 0, minor ?? 0, patch ?? 0);
  const nextMajor = release((major ?? 0) + 1, 0, 0);
  const nextMinor = release(major ?? 0, (minor ?? 0) + 1, 0);
  const nextPatch = release(major ?? 0, minor ?? 0, (patch ?? 0) + 1);

  switch (op) {
    case "^": {
      const ceiling =
        (major ?? 0) > 0 || given === 1
          ? nextMajor
          : (minor ?? 0) > 0 || given === 2
            ? nextMinor
            : nextPatch;
      return [
        { op: ">=", version: floor },
        { op: "<", version: ceiling },
      ];
    }
    case "~":
      return [
        { op: ">=", version: floor },
        { op: "<", version: given === 1 ? nextMajor : nextMinor },
      ];
    case ">=":
      return [{ op: ">=", version: floor }];
    case "<":
      return [{ op: "<", version: floor }];
    case ">":
      return given === 3
        ? [{ op: ">", version: floor }]
        : [{ op: ">=", version: given === 1 ? nextMajor : nextMinor }];
    case "<=":
      return given === 3
        ? [{ op: "<=", version: floor }]
        : [{ op: "<", version: given === 1 ? nextMajor : nextMinor }];
    default:
      return given === 3
        ? [{ op: "=", version: floor }]
        : [
            { op: ">=", version: floor },
            { op: "<", version: given === 1 ? nextMajor : nextMinor },
          ];
  }
}

/** Every alternative (`||`) of a range as its comparators, or undefined when any part is invalid. */
function parseRange(range: string): Comparator[][] | undefined {
  const alternatives: Comparator[][] = [];
  for (const alternative of range.split("||")) {
    const terms = alternative.trim().split(/\s+/).filter(Boolean);
    const comparators: Comparator[] = [];
    for (const term of terms.length === 0 ? ["*"] : terms) {
      const parsed = termComparators(term);
      if (parsed === undefined) {
        return undefined;
      }
      comparators.push(...parsed);
    }
    alternatives.push(comparators);
  }
  return alternatives;
}

export function isValidRange(range: string): boolean {
  return range.trim() !== "" && parseRange(range) !== undefined;
}

function holds(version: Version, { op, version: bound }: Comparator): boolean {
  const order = compare(version, bound);
  switch (op) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "=":
      return order === 0;
  }
}

/** True when `version` lies in `range`. A pre-release only matches a range that names its release. */
export function satisfies(version: string, range: string): boolean {
  const candidate = parseVersion(version);
  const alternatives = parseRange(range);
  if (candidate === undefined || alternatives === undefined) {
    return false;
  }
  return alternatives.some(
    (comparators) =>
      comparators.every((comparator) => holds(candidate, comparator)) &&
      (candidate.pre.length === 0 ||
        comparators.some(
          ({ version: bound }) =>
            bound.pre.length > 0 &&
            bound.major === candidate.major &&
            bound.minor === candidate.minor &&
            bound.patch === candidate.patch,
        )),
  );
}
