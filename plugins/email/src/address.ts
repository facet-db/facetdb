import { z } from "facetdb/plugin";

/**
 * One email address, as the setting `from` and a channel's `where` hold it: a bare `name@domain`,
 * one of them, on one line. A display name, angle brackets, quotes, a comment, a list, a group, a
 * space or a control character is refused, so nothing but the address itself can reach the From
 * or To header (a second address smuggled in `Ops <ops@example.com>, x@y`, or a header after a
 * line break). Internationalized addresses are not taken: a domain is written in its `xn--` form.
 */

/** The settings that hold an address, each refused in words that name it. */
export type AddressSetting = "from" | "where";

/** RFC 5322's atext: what a dot-atom local part is made of, quotes and backslashes excluded. */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Line breaks (CR, LF, NEL, the Unicode line and paragraph separators) and every control character. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const SPACE = /\s/u;
const LIST = /[,;]/;
/** What a display name, a route, a comment, a group or a quoted part is written with. */
const NAME_SYNTAX = /[<>"()[\]:\\]/;

const EXAMPLE: Readonly<Record<AddressSetting, string>> = {
  from: "alerts@example.com",
  where: "ops@example.com",
};

const ONE_ONLY: Readonly<Record<AddressSetting, string>> = {
  from: "FacetDB sends from one address",
  where:
    'a channel sends to one address; to reach two, name the channel twice: "email:a@example.com" and "email:b@example.com"',
};

/**
 * Why `value` is not one bare email address, in words that name the setting and the fix, or
 * undefined when it is one. The words never quote the value: it may hold a line break.
 */
export function addressProblem(value: string, setting: AddressSetting): string | undefined {
  const example = EXAMPLE[setting];
  if (value === "") {
    return `${setting} is empty: write one email address, such as ${example}`;
  }
  if (CONTROL.test(value)) {
    return `${setting} holds a line break or a control character: write one email address on one line, such as ${example}`;
  }
  if (LIST.test(value)) {
    return `${setting} holds a list (a comma or a semicolon): ${ONE_ONLY[setting]}`;
  }
  if (NAME_SYNTAX.test(value)) {
    return `${setting} holds a display name, angle brackets, quotes or a comment: write the bare address alone, such as ${example}`;
  }
  if (SPACE.test(value)) {
    return `${setting} holds a space: write the address alone, with no name, such as ${example}`;
  }
  const at = value.indexOf("@");
  if (at === -1 || at !== value.lastIndexOf("@")) {
    return `${setting} is not one email address (it needs exactly one @): write it as name@domain, such as ${example}`;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const labels = domain.split(".");
  if (
    value.length > 254 ||
    local.length > 64 ||
    !LOCAL_PART.test(local) ||
    domain.length > 253 ||
    !labels.every((label) => DOMAIN_LABEL.test(label))
  ) {
    return `${setting} is not an email address FacetDB can send to: write it as name@domain in plain ASCII (an internationalized domain in its xn-- form), such as ${example}`;
  }
  return undefined;
}

/** The schema of a setting that holds one address: it refuses what `addressProblem` refuses. */
export function addressSchema(setting: AddressSetting, missing: string) {
  return z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? missing
          : `${setting} is text: one email address, such as "${EXAMPLE[setting]}"`,
    })
    .superRefine((value, ctx) => {
      const problem = addressProblem(value, setting);
      if (problem !== undefined) {
        ctx.addIssue({ code: "custom", message: problem });
      }
    });
}
