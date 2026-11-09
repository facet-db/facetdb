import { z } from "zod";

/**
 * An error body is a boundary: TypeSafe's `detail` is either a plain message or a list of
 * validation issues with a `loc` path and a `msg`. Anything else is reported as the raw text.
 */
const issue = z.object({
  loc: z.array(z.union([z.string(), z.number()])).optional(),
  msg: z.string(),
});
const errorBody = z.object({ detail: z.union([z.string(), z.array(issue).min(1)]) });

export type Rejection = { readonly message: string; readonly field: string | undefined };

export function rejectionFrom(text: string): Rejection {
  const raw = text.trim() === "" ? "the model rejected the request" : text.trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { message: raw, field: undefined };
  }
  const parsed = errorBody.safeParse(json);
  if (!parsed.success) {
    return { message: raw, field: undefined };
  }
  const { detail } = parsed.data;
  if (typeof detail === "string") {
    return { message: detail, field: undefined };
  }
  const first = detail[0];
  if (first === undefined) {
    return { message: raw, field: undefined };
  }
  // "body" names the request itself, not a field of it.
  const path = (first.loc ?? []).filter((part, index) => !(index === 0 && part === "body"));
  return { message: first.msg, field: path.length === 0 ? undefined : path.join(".") };
}
