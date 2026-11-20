import type { ComponentProps } from "react";

export type TagTone = "neutral" | "facet" | "yes" | "no" | "review" | "cloud";

export type TagProps = ComponentProps<"span"> & {
  // The role of the 6 px square at the tag's left. `facet` also takes the amber border (the
  // product's own: a plan, a verified plugin); `cloud` is dashed (a FacetDB Cloud feature).
  tone?: TagTone;
};

// A rectangle with a square at its left, sentence case at 12.5 px in the secondary text role.
// What the tag means is in its words; the square only classes it.
export function Tag({ tone = "neutral", children, ...rest }: TagProps) {
  return (
    <span className="fdb-tag" data-tone={tone} {...rest}>
      {children}
    </span>
  );
}
